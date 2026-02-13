// Service worker: captures JWT tokens via content script + webRequest,
// fetches recordings, and manages downloads.

const API_BASE = 'https://lrswapi.campus.mcgill.ca/api';

// ─── Reset on reload (dev) ───────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.remove('downloads');
  console.log('[LRS] State reset on reload');
});

// ─── Header injection for CDN downloads ──────────────
// declarativeNetRequest injects Origin/Referer/Range at the network
// level so chrome.downloads.download() works directly with CDN URLs.

chrome.declarativeNetRequest.updateDynamicRules({
  removeRuleIds: [1],
  addRules: [
    {
      id: 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Origin', operation: 'set', value: 'https://lrs.mcgill.ca' },
          { header: 'Referer', operation: 'set', value: 'https://lrs.mcgill.ca/' },
          { header: 'Range', operation: 'set', value: 'bytes=0-' }
        ]
      },
      condition: {
        regexFilter: '.*[Ll][Rr][Ss][Cc][Dd][Nn]\\.mcgill\\.ca.*',
        isUrlFilterCaseSensitive: false
      }
    }
  ]
}).catch(e => console.error('[LRS] Header rule install failed:', e));

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
    downloadRecording(msg.recording, msg.token).then(sendResponse);
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

async function downloadRecording(recording, token) {
  try {
    const mediaUrl = await resolveMediaUrl(recording);
    const filename = buildFilename(recording);

    console.log('[LRS] Resolved URL:', mediaUrl.substring(0, 80));

    // Strategy: hand the CDN URL directly to Chrome's download manager.
    // declarativeNetRequest rules inject Origin/Referer/Range headers
    // at the network level. The service worker is NOT involved in the
    // actual data transfer — Chrome handles everything natively.
    const downloadId = await chrome.downloads.download({
      url: mediaUrl,
      filename: `McGill-Lectures/${filename}`
    });

    console.log('[LRS] Native download started, id:', downloadId);

    await updateProgress(recording.id, filename, 0, 0, 'downloading', downloadId);

    // Poll Chrome's download manager for byte-level progress
    pollProgress(recording.id, downloadId, filename);

    return { ok: true, downloadId, filename };
  } catch (e) {
    console.error('[LRS] Download failed:', e.message);
    await updateProgress(recording.id, null, 0, 0, 'failed');
    return { ok: false, error: e.message };
  }
}

function pollProgress(recId, downloadId, filename) {
  const check = async () => {
    try {
      const [item] = await chrome.downloads.search({ id: downloadId });
      if (!item) return;

      if (item.state === 'in_progress') {
        const received = item.bytesReceived || 0;
        const total = item.totalBytes > 0 ? item.totalBytes : 0;
        await updateProgress(recId, filename, received, total, 'downloading', downloadId);
        setTimeout(check, 2000);
      }
      // 'complete' and 'interrupted' handled by onChanged listener below
    } catch {}
  };
  setTimeout(check, 1000);
}

async function updateProgress(recId, filename, received, total, status, downloadId) {
  const data = await chrome.storage.local.get('downloads');
  const downloads = data.downloads || {};
  downloads[recId] = {
    ...(downloads[recId] || {}),
    filename,
    received,
    total,
    status,
    ...(downloadId ? { downloadId } : {})
  };
  await chrome.storage.local.set({ downloads });
}

// Final state changes (complete / failed)
chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state) return;

  const data = await chrome.storage.local.get('downloads');
  const downloads = data.downloads || {};

  for (const [recId, dl] of Object.entries(downloads)) {
    if (dl.downloadId === delta.id) {
      if (delta.state.current === 'complete') {
        downloads[recId].status = 'complete';
        downloads[recId].received = downloads[recId].total;
      } else if (delta.state.current === 'interrupted') {
        downloads[recId].status = 'failed';
      }
      await chrome.storage.local.set({ downloads });
      break;
    }
  }
});
