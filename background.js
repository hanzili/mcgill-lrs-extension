// Service worker: captures JWT tokens via content script + webRequest,
// fetches recordings, and manages downloads.

const API_BASE = 'https://lrswapi.campus.mcgill.ca/api';

// ─── Header injection for CDN downloads ──────────────
// The CDN requires Origin + Referer from lrs.mcgill.ca.
// chrome.downloads can't set these (restricted), so we use
// declarativeNetRequest to inject them at the network level.

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
        regexFilter: '.*lrscdn\\.mcgill\\.ca.*tsmedia.*',
        isUrlFilterCaseSensitive: false
      }
    }
  ]
}).catch(e => console.error('[LRS] Header rule install failed:', e));

// ─── JWT Capture: Method 1 — Content script relay ────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'KEEPALIVE') return;
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
    if (!payload || !payload.LRSCourseId) {
      console.warn('[LRS] JWT missing LRSCourseId');
      return;
    }

    const courseId = payload.LRSCourseId;
    const data = await chrome.storage.local.get('courses');
    const courses = data.courses || {};

    // Only update if this is a newer token
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

    // Store course name for display
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

// ─── Keep-alive (prevents Chrome from killing SW during downloads) ──

let activeDownloads = 0;

async function startKeepAlive() {
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Keep service worker alive during downloads'
    });
  } catch {} // already exists
}

async function stopKeepAlive() {
  try { await chrome.offscreen.closeDocument(); } catch {}
}

// ─── Downloads ───────────────────────────────────────

async function downloadRecording(recording, token) {
  activeDownloads++;
  if (activeDownloads === 1) await startKeepAlive();
  try {
    // Find video source — try multiple property names
    const sources = recording.sources
      || recording.mediaRecordingSourceDtos
      || recording.Sources
      || [];

    const hlsSource = sources.find(s =>
        (s.label || s.name || s.Label || '') === 'VGA')
      || sources[0];

    if (!hlsSource) throw new Error('No video source in recording');
    const srcUrl = hlsSource.src || hlsSource.url || hlsSource.Src;
    if (!srcUrl) throw new Error('Source has no URL property');

    // Fetch HLS manifest
    const manifestResp = await fetch(srcUrl);
    if (!manifestResp.ok) {
      throw new Error(`Manifest fetch failed: ${manifestResp.status}`);
    }
    const manifest = await manifestResp.text();

    // Extract media URL — look for tsmedia CDN link
    let mediaUrl = manifest.split('\n').find(line =>
      line.toLowerCase().includes('tsmedia') && !line.startsWith('#')
    );

    // Fallback: rewrite /hls/ → /tsmedia/ in the source URL
    if (!mediaUrl && srcUrl.toLowerCase().includes('/api/hls/')) {
      mediaUrl = srcUrl.replace(/\/api\/hls\//i, '/api/tsmedia/');
    }

    // Fallback: any non-comment URL line in the manifest
    if (!mediaUrl) {
      mediaUrl = manifest.split('\n').find(line =>
        (line.startsWith('http') || line.startsWith('/')) && !line.startsWith('#')
      );
    }

    if (!mediaUrl) {
      throw new Error('Could not find media URL in manifest');
    }

    mediaUrl = mediaUrl.trim();

    // Build filename
    const date = recording.dateTime.split('T')[0];
    const instructor = (recording.instructor || 'Lecture').replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
    const course = (recording.courseName || 'Recording').replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
    const filename = `${course}_${date}_${instructor}.ts`;

    // Fetch via service worker (host_permissions allow setting any headers)
    const videoResp = await fetch(mediaUrl, {
      headers: {
        'Range': 'bytes=0-',
        'Origin': 'https://lrs.mcgill.ca',
        'Referer': 'https://lrs.mcgill.ca/'
      }
    });

    if (!videoResp.ok && videoResp.status !== 206) {
      throw new Error(`CDN returned ${videoResp.status}`);
    }

    const totalSize = parseInt(
      videoResp.headers.get('content-range')?.split('/')[1]
      || videoResp.headers.get('content-length')
      || '0'
    );

    // Stream to OPFS (Origin Private File System) — each chunk is written
    // directly to disk, so we never hold the full file in memory. This is
    // critical for 1GB+ lecture recordings that would crash the service worker.
    await updateProgress(recording.id, filename, 0, totalSize, 'downloading');

    const root = await navigator.storage.getDirectory();
    const tmpName = `lrs_${recording.id}.tmp`;
    const fileHandle = await root.getFileHandle(tmpName, { create: true });
    const writable = await fileHandle.createWritable();

    const reader = videoResp.body.getReader();
    let received = 0;
    let lastUpdate = 0;

    while (true) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Download stalled (no data for 60s)')), 60000)
        )
      ]);
      if (done) break;
      await writable.write(value);
      received += value.byteLength;

      if (received - lastUpdate > 2 * 1024 * 1024) {
        lastUpdate = received;
        await updateProgress(recording.id, filename, received, totalSize, 'downloading');
      }
    }

    await writable.close();

    await updateProgress(recording.id, filename, totalSize, totalSize, 'saving');

    // getFile() returns a disk-backed File reference — no memory copy
    const file = await fileHandle.getFile();
    const blobUrl = URL.createObjectURL(file);

    const downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: `McGill-Lectures/${filename}`
    });

    // Clean up OPFS temp file and blob URL after Chrome finishes writing
    setTimeout(async () => {
      URL.revokeObjectURL(blobUrl);
      try { await root.removeEntry(tmpName); } catch {}
    }, 120000);

    await updateProgress(recording.id, filename, totalSize, totalSize, 'complete', downloadId);
    return { ok: true, downloadId, filename };
  } catch (e) {
    console.error('[LRS] Download failed:', e.message);
    await updateProgress(recording.id, null, 0, 0, 'failed');
    return { ok: false, error: e.message };
  } finally {
    activeDownloads--;
    if (activeDownloads <= 0) {
      activeDownloads = 0;
      stopKeepAlive();
    }
  }
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

// Monitor download progress
chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state) return;

  const data = await chrome.storage.local.get('downloads');
  const downloads = data.downloads || {};

  for (const [recId, dl] of Object.entries(downloads)) {
    if (dl.downloadId === delta.id) {
      if (delta.state.current === 'complete') {
        downloads[recId].status = 'complete';
      } else if (delta.state.current === 'interrupted') {
        downloads[recId].status = 'failed';
      }
      await chrome.storage.local.set({ downloads });
      break;
    }
  }
});
