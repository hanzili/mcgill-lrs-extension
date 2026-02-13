// Service worker: captures JWT tokens via content script + webRequest,
// fetches recordings, and manages downloads.

const API_BASE = 'https://lrswapi.campus.mcgill.ca/api';

// ─── Reset on reload (dev) ───────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.remove('downloads');
});

// ─── JWT Capture: Method 1 — Content script relay ────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'TOKEN_CAPTURED') {
    handleJwtCaptured(msg.token);
    return;
  }
  if (msg.type === 'GET_STATE') {
    getState().then(sendResponse);
    return true;
  }
  if (msg.type === 'FETCH_RECORDINGS') {
    fetchRecordings(msg.token, msg.courseId).then(sendResponse);
    return true;
  }
  if (msg.type === 'DOWNLOAD_RECORDING') {
    downloadRecording(msg.recording).then(sendResponse);
    return true;
  }
  if (msg.type === 'DOWNLOAD_ALL') {
    downloadAll(msg.recordings).then(sendResponse);
    return true;
  }
});

// ─── JWT Capture: Method 2 — webRequest (backup) ─────────

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    const authHeader = details.requestHeaders?.find(
      h => h.name.toLowerCase() === 'authorization'
    );
    if (authHeader && authHeader.value.startsWith('Bearer ')) {
      handleJwtCaptured(authHeader.value.slice(7));
    }
  },
  { urls: ['https://lrswapi.campus.mcgill.ca/*'] },
  ['requestHeaders', 'extraHeaders']
);

// ─── JWT Storage ─────────────────────────────────────

async function handleJwtCaptured(token) {
  try {
    const payload = decodeJwt(token);
    if (!payload || !payload.LRSCourseId) return;

    const courseId = payload.LRSCourseId;
    const data = await chrome.storage.local.get('courses');
    const courses = data.courses || {};

    const existing = courses[courseId];
    if (existing && existing.exp >= payload.exp) return;

    courses[courseId] = {
      token,
      email: payload.email,
      exp: payload.exp,
      courseName: null,
      capturedAt: Date.now()
    };
    await chrome.storage.local.set({ courses, lastCourseId: courseId });
  } catch (e) {
    console.error('[LRS] JWT storage failed:', e);
  }
}

function decodeJwt(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(payload));
  } catch {
    return null;
  }
}

// ─── State ───────────────────────────────────────────

async function getState() {
  const data = await chrome.storage.local.get(['courses', 'lastCourseId', 'downloads']);
  return {
    courses: data.courses || {},
    lastCourseId: data.lastCourseId || null,
    downloads: data.downloads || {}
  };
}

// ─── API ─────────────────────────────────────────────

async function fetchRecordings(token, courseId) {
  try {
    const resp = await fetch(`${API_BASE}/MediaRecordings/dto/${courseId}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      }
    });
    if (!resp.ok) throw new Error(`API returned ${resp.status}`);
    const recordings = await resp.json();

    if (recordings.length > 0) {
      const data = await chrome.storage.local.get('courses');
      const courses = data.courses || {};
      if (courses[courseId]) {
        courses[courseId].courseName = recordings[0].courseName;
        courses[courseId].semester = recordings[0].semesterName;
        await chrome.storage.local.set({ courses });
      }
    }

    return { ok: true, recordings };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── Downloads ───────────────────────────────────────

async function resolveMediaUrl(recording) {
  const sources = recording.sources
    || recording.mediaRecordingSourceDtos
    || recording.Sources
    || [];

  const hlsSource = sources.find(s =>
      (s.label || s.name || s.Label || '') === 'VGA')
    || sources[0];

  if (!hlsSource) throw new Error('No video source');
  const srcUrl = hlsSource.src || hlsSource.url || hlsSource.Src;
  if (!srcUrl) throw new Error('Source has no URL');

  const manifestResp = await fetch(srcUrl);
  if (!manifestResp.ok) throw new Error(`Manifest: ${manifestResp.status}`);
  const manifest = await manifestResp.text();

  let mediaUrl = manifest.split('\n').find(line =>
    line.toLowerCase().includes('tsmedia') && !line.startsWith('#')
  );

  if (!mediaUrl && srcUrl.toLowerCase().includes('/api/hls/')) {
    mediaUrl = srcUrl.replace(/\/api\/hls\//i, '/api/tsmedia/');
  }

  if (!mediaUrl) {
    mediaUrl = manifest.split('\n').find(line =>
      (line.startsWith('http') || line.startsWith('/')) && !line.startsWith('#')
    );
  }

  if (!mediaUrl) throw new Error('No media URL in manifest');
  return mediaUrl.trim();
}

function buildFilename(recording) {
  const date = recording.dateTime.split('T')[0];
  const instructor = (recording.instructor || 'Lecture').replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
  const course = (recording.courseName || 'Recording').replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
  return `${course}_${date}_${instructor}.ts`;
}

// Download a single recording — generates a curl script
async function downloadRecording(recording) {
  try {
    const mediaUrl = await resolveMediaUrl(recording);
    const filename = buildFilename(recording);

    const script = generateScript([{ mediaUrl, filename }]);
    return await saveScript(script, `download_${filename.replace('.ts', '')}.command`);
  } catch (e) {
    console.error('[LRS] Download failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// Download all recordings — generates one script with all curl commands
async function downloadAll(recordings) {
  try {
    const items = [];
    for (const rec of recordings) {
      try {
        const mediaUrl = await resolveMediaUrl(rec);
        const filename = buildFilename(rec);
        items.push({ mediaUrl, filename });
      } catch (e) {
        console.error('[LRS] Skipping recording:', e.message);
      }
    }

    if (items.length === 0) return { ok: false, error: 'No downloadable recordings' };

    const course = (recordings[0].courseName || 'Recordings').replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
    const script = generateScript(items);
    return await saveScript(script, `download_${course}.command`);
  } catch (e) {
    console.error('[LRS] Download all failed:', e.message);
    return { ok: false, error: e.message };
  }
}

function generateScript(items) {
  const curls = items.map((item, i) => {
    const num = items.length > 1 ? `(${i + 1}/${items.length}) ` : '';
    return `echo "\\n⬇  ${num}${item.filename}"
curl -# -L \\
  -o "$DIR/${item.filename}" \\
  -H "Origin: https://lrs.mcgill.ca" \\
  -H "Referer: https://lrs.mcgill.ca/" \\
  -H "Range: bytes=0-" \\
  "${item.mediaUrl}"`;
  }).join('\n\n');

  return `#!/bin/bash
DIR="$HOME/Downloads/McGill-Lectures"
mkdir -p "$DIR"
echo "Saving to: $DIR"
echo "Downloading ${items.length} recording${items.length > 1 ? 's' : ''}..."

${curls}

echo "\\n✓ Done! Files saved to $DIR"
`;
}

async function saveScript(script, filename) {
  const blob = new Blob([script], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);

  const downloadId = await chrome.downloads.download({
    url,
    filename: `McGill-Lectures/${filename}`
  });

  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { ok: true, downloadId, filename, isScript: true };
}
