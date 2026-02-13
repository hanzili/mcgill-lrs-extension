// Service worker: captures JWT tokens, fetches recording metadata,
// and routes downloads through the content script on the LRS page
// (which has the correct Origin for CDN requests).

const API_BASE = 'https://lrswapi.campus.mcgill.ca/api';

// ─── Message handling ────────────────────────────────

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
  if (msg.type === 'DOWNLOAD_STATUS') return;
  if (msg.type === 'DOWNLOAD_PROGRESS') {
    chrome.storage.local.set({ downloadProgress: msg.progress });
    return;
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

// ─── JWT Capture: webRequest (backup) ─────────────────

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
  const data = await chrome.storage.local.get(['courses', 'lastCourseId']);
  return {
    courses: data.courses || {},
    lastCourseId: data.lastCourseId || null,
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

// ─── Downloads via chrome.scripting.executeScript ────
//
// Strategy: inject code into ALL frames of a McGill tab.
//   - Top-level frame: listens for a postMessage carrying an ArrayBuffer
//     from the LRS iframe, then triggers <a download> (works because
//     <a download> is NOT blocked in top-level frames).
//   - LRS iframe (lrs.mcgill.ca): fetches the video from the CDN
//     (browser auto-sets the correct Origin header in MAIN world),
//     then transfers the ArrayBuffer to the parent via postMessage
//     (zero-copy via transferable).
//   - If LRS IS the top-level frame (direct tab), downloads directly.
//   - Each download gets a unique ID so concurrent downloads don't clash.

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
  const date = (recording.dateTime || new Date().toISOString()).split('T')[0];
  const instructor = (recording.instructor || 'Lecture').replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
  const course = (recording.courseName || 'Recording').replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
  return `${course}_${date}_${instructor}.mp4`;
}

async function findMcGillTab() {
  const tabs = await chrome.tabs.query({ url: 'https://*.mcgill.ca/*' });
  if (tabs.length === 0) return null;
  // Prefer tabs with LRS or myCourses content
  const preferred = tabs.find(t =>
    t.url.includes('lrs.mcgill.ca') || t.url.includes('mycourses')
  );
  return (preferred || tabs[0]).id;
}

// Inject a function into ALL frames of a McGill tab, running in MAIN world.
async function runInAllFrames(tabId, func, args = []) {
  return chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'MAIN',
    func,
    args
  });
}

async function downloadRecording(recording) {
  try {
    const mediaUrl = await resolveMediaUrl(recording);
    const filename = buildFilename(recording);
    const dlId = 'dl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

    const tabId = await findMcGillTab();
    if (!tabId) {
      return { ok: false, error: 'Open any McGill LRS page first' };
    }


    // Inject a fresh bridge in ISOLATED world so progress messages reach
    // the service worker even if the declarative bridge.js is orphaned
    // (happens when the extension is reloaded while the tab is open).
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'ISOLATED',
      func: () => {
        if (window.__LRS_BRIDGE_INJECTED) return;
        window.__LRS_BRIDGE_INJECTED = true;
        window.addEventListener('message', (event) => {
          if (event.source !== window) return;
          try {
            if (event.data?.type === '__LRS_PROGRESS__') {
              chrome.runtime.sendMessage({
                type: 'DOWNLOAD_PROGRESS',
                progress: {
                  filename: event.data.filename,
                  pct: event.data.pct,
                  received: event.data.received,
                  total: event.data.total,
                  complete: event.data.complete || false,
                  error: event.data.error || null
                }
              });
            }
            if (event.data?.type === '__LRS_STATUS__') {
              chrome.runtime.sendMessage({
                type: 'DOWNLOAD_STATUS',
                message: event.data.message
              });
            }
          } catch (e) { /* extension context invalidated — ignore */ }
        });
      }
    });

    // Inject TS→MP4 remuxer into all frames (MAIN world)
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      files: ['remux.js']
    });

    const results = await runInAllFrames(tabId, (url, fname, downloadId) => {
      // Helper: log to page console AND relay to SW via bridge.js
      function report(msg) {
        console.log(msg);
        window.postMessage({ type: '__LRS_STATUS__', message: msg }, '*');
      }

      // ── Detect frame role (try/catch for cross-origin safety) ──
      let isTopFrame;
      try { isTopFrame = (window.self === window.top); }
      catch { isTopFrame = false; }
      const isLrsFrame = (window.location.hostname === 'lrs.mcgill.ca');

      if (!isTopFrame && !isLrsFrame) return null;

      // ── Top-level frame (non-LRS): listen for data from LRS iframe ──
      if (isTopFrame && !isLrsFrame) {
        report('[LRS] Listener ready on ' + window.location.hostname + ' for ' + downloadId);

        // Auto-cleanup after 15 min if fetch never completes
        const timer = setTimeout(() => {
          window.removeEventListener('message', handler);
          report('[LRS] Listener timed out (15 min): ' + downloadId);
        }, 15 * 60 * 1000);

        function handler(e) {
          if (e.data?.type !== '__LRS_DOWNLOAD__') return;
          if (e.data.downloadId !== downloadId) return; // match by unique ID
          window.removeEventListener('message', handler);
          clearTimeout(timer);

          // Handle error from LRS iframe
          if (e.data.error) {
            report('[LRS] ERROR from LRS frame: ' + e.data.error);
            return;
          }

          report('[LRS] Received buffer (' + (e.data.buffer?.byteLength / 1e6).toFixed(1) + ' MB), triggering download...');

          try {
            // Remux TS→MP4 for native playback in QuickTime/Windows Media Player
            let videoBuffer = e.data.buffer;
            if (typeof __LRS_REMUX === 'function') {
              try {
                report('[LRS] Remuxing TS → MP4...');
                videoBuffer = __LRS_REMUX(e.data.buffer);
                report('[LRS] Remux done: ' + (videoBuffer.byteLength / 1e6).toFixed(1) + ' MB');
              } catch (remuxErr) {
                report('[LRS] Remux failed (' + remuxErr.message + '), saving as TS');
              }
            }
            const blob = new Blob([videoBuffer], { type: 'video/mp4' });
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = e.data.filename;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { URL.revokeObjectURL(blobUrl); a.remove(); }, 30000);
            report('[LRS] Download triggered: ' + e.data.filename + ' (' + (blob.size / 1e6).toFixed(1) + ' MB)');
          } catch (err) {
            report('[LRS] ERROR creating download: ' + err.message);
          }
        }

        window.addEventListener('message', handler);
        return { role: 'listener' };
      }

      // ── LRS frame: fetch video from CDN and transfer to parent ──
      if (isLrsFrame) {
        report('[LRS] Fetching from LRS frame: ' + fname);

        (async () => {
          try {
            const r = await fetch(url, { headers: { 'Range': 'bytes=0-' } });
            report('[LRS] CDN response: status=' + r.status + ' ok=' + r.ok);
            if (!r.ok && r.status !== 206) throw new Error('CDN ' + r.status);

            const totalStr = r.headers.get('content-range')?.split('/')[1]
                          || r.headers.get('content-length');
            const totalBytes = totalStr ? +totalStr : 0;
            if (totalBytes > 0) report('[LRS] Video size: ~' + (totalBytes / 1e6).toFixed(0) + ' MB');

            // Stream response with progress reporting
            const reader = r.body.getReader();
            const chunks = [];
            let received = 0;
            let lastProgressAt = 0;

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
              received += value.byteLength;

              const now = Date.now();
              if (now - lastProgressAt > 2000) {
                lastProgressAt = now;
                const pct = totalBytes > 0 ? Math.round(received / totalBytes * 100) : null;
                const msg = pct !== null
                  ? '[LRS] ' + pct + '% — ' + (received / 1e6).toFixed(0) + '/' + (totalBytes / 1e6).toFixed(0) + ' MB'
                  : '[LRS] Downloaded ' + (received / 1e6).toFixed(0) + ' MB';
                report(msg);
                window.postMessage({
                  type: '__LRS_PROGRESS__',
                  filename: fname,
                  pct: pct,
                  received: received,
                  total: totalBytes
                }, '*');
              }
            }

            // Concatenate chunks into a single ArrayBuffer
            report('[LRS] Fetch complete: ' + (received / 1e6).toFixed(1) + ' MB');
            const buffer = new ArrayBuffer(received);
            const view = new Uint8Array(buffer);
            let offset = 0;
            for (const chunk of chunks) {
              view.set(chunk, offset);
              offset += chunk.byteLength;
            }

            if (buffer.byteLength < 1000) throw new Error('Too small: ' + buffer.byteLength + ' bytes');

            // Send 100% progress
            window.postMessage({
              type: '__LRS_PROGRESS__',
              filename: fname,
              pct: 100,
              received: received,
              total: totalBytes,
              complete: true
            }, '*');

            if (isTopFrame) {
              // LRS is the top-level frame — download directly
              let videoBuffer = buffer;
              if (typeof __LRS_REMUX === 'function') {
                try {
                  report('[LRS] Remuxing TS → MP4...');
                  videoBuffer = __LRS_REMUX(buffer);
                  report('[LRS] Remux done: ' + (videoBuffer.byteLength / 1e6).toFixed(1) + ' MB');
                } catch (remuxErr) {
                  report('[LRS] Remux failed (' + remuxErr.message + '), saving as TS');
                }
              }
              const blob = new Blob([videoBuffer], { type: 'video/mp4' });
              const blobUrl = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = blobUrl;
              a.download = fname;
              document.body.appendChild(a);
              a.click();
              setTimeout(() => { URL.revokeObjectURL(blobUrl); a.remove(); }, 30000);
              report('[LRS] Download started (direct): ' + fname);
            } else {
              // Transfer ArrayBuffer to parent frame (zero-copy via transferable)
              window.top.postMessage({
                type: '__LRS_DOWNLOAD__',
                downloadId: downloadId,
                buffer: buffer,
                filename: fname
              }, '*', [buffer]);
              report('[LRS] ArrayBuffer transferred to parent frame');
            }
          } catch (e) {
            report('[LRS] ERROR: ' + e.message);
            window.postMessage({
              type: '__LRS_PROGRESS__',
              filename: fname,
              error: e.message
            }, '*');
            if (!isTopFrame) {
              try {
                window.top.postMessage({
                  type: '__LRS_DOWNLOAD__',
                  downloadId: downloadId,
                  error: e.message
                }, '*');
              } catch (_) {}
            }
          }
        })();

        return { role: 'fetcher' };
      }

      return null;
    }, [mediaUrl, filename, dlId]);

    // Log what each frame returned (including injection errors)
    const summary = results.map(r => {
      if (r.error) return 'ERROR: ' + r.error;
      if (r.result?.role) return r.result.role;
      return 'skip';
    });

    const hasFetcher = results.some(r => r.result?.role === 'fetcher');
    if (!hasFetcher) {
      const errors = results.filter(r => r.error).map(r => r.error);
      const errMsg = errors.length > 0
        ? 'Injection errors: ' + errors.join('; ')
        : 'LRS frame not found. Open a lecture page first.';
      return { ok: false, error: errMsg };
    }

    return { ok: true, filename, status: 'fetching' };
  } catch (e) {
    console.error('[LRS] Download failed:', e.message);
    return { ok: false, error: e.message };
  }
}

async function downloadAll(recordings) {
  const results = [];
  for (const rec of recordings) {
    try {
      const r = await downloadRecording(rec);
      results.push({ ...r, recId: rec.id });
      if (r.ok) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        await chrome.storage.local.get('_'); // keep SW alive
      }
    } catch (e) {
      results.push({ ok: false, error: e.message, recId: rec.id });
    }
  }
  const count = results.filter(r => r.ok).length;
  if (count === 0) return { ok: false, error: 'No downloads succeeded' };
  // Return filename→recId pairs so popup can track progress
  const filenames = results.filter(r => r.ok && r.filename)
    .map(r => ({ filename: r.filename, recId: r.recId }));
  return { ok: true, count, total: recordings.length, filenames };
}

