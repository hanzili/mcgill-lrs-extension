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
// The video is fetched from inside an lrs.mcgill.ca frame — the same context
// the LRS player itself fetches from — so the CDN request carries the same
// Origin/Referer as the player's own requests:
//   1. Locate an lrs.mcgill.ca frame. We probe the frames of every open
//      McGill tab — the active tab of the focused window first — because
//      students usually have several myCourses tabs open and only one of
//      them actually contains the LRS player.
//   2. Exactly ONE frame acts as the fetcher, so a page with several LRS
//      frames doesn't fetch the same recording several times.
//   3. If the LRS frame is nested, the top-level frame of the same tab
//      receives the ArrayBuffer via postMessage (zero-copy transfer) and
//      triggers <a download>; if the LRS page is itself top-level, it
//      saves the file directly.
//   4. Each download gets a unique ID so concurrent downloads don't clash,
//      and fetches inside one frame run one at a time so "Download all"
//      doesn't hold every lecture in memory at once.

const LRS_HOST = 'lrs.mcgill.ca';
const MYCOURSES_HOST = 'mycourses2.mcgill.ca';

const NO_LRS_FRAME_ERROR =
  'Lecture Recordings page not found. Open the course’s Lecture Recordings ' +
  'in myCourses, keep that tab open, then try again.';

// A fetch that receives no data for this long is aborted, so one stalled
// response can't hold up the recordings queued behind it.
const FETCH_IDLE_TIMEOUT_MS = 60 * 1000;

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

// ─── Locating the LRS frame ──────────────────────────

// All open McGill tabs, most likely candidates first: the active tab of the
// focused window, then other active tabs, then most recently used.
async function getCandidateTabs() {
  const tabs = await chrome.tabs.query({ url: 'https://*.mcgill.ca/*' });

  let focusedWindowId = chrome.windows.WINDOW_ID_NONE;
  try {
    focusedWindowId = (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id;
  } catch (_) { /* no focused window — fall back to recency */ }

  const rank = (t) => (t.active && t.windowId === focusedWindowId) ? 0 : (t.active ? 1 : 2);
  return tabs
    .filter(t => !t.discarded)
    .sort((a, b) => rank(a) - rank(b) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
}

// Probes every frame of a tab. Returns { target, hosts }: target is
// { tabId, frameId } of the best lrs.mcgill.ca frame (or null), hosts lists
// the frame hostnames seen (for diagnostics).
async function findLrsFrameInTab(tabId) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      // Don't wait for document_idle: a myCourses tab that is still loading
      // would otherwise hold up the search.
      injectImmediately: true,
      func: () => ({
        host: location.hostname,
        hasVideo: !!document.querySelector('video')
      })
    });
  } catch (e) {
    // Tab not scriptable right now (error page, navigating, …)
    return { target: null, hosts: ['<' + e.message + '>'] };
  }

  results = (results || []).filter(r => r.result);
  const hosts = results.map(r => r.result.host);
  const lrsFrames = results.filter(r => r.result.host === LRS_HOST);
  if (lrsFrames.length === 0) return { target: null, hosts };

  // A top-level LRS page can save directly; otherwise prefer the player frame.
  const pick = lrsFrames.find(r => r.frameId === 0)
            || lrsFrames.find(r => r.result.hasVideo)
            || lrsFrames[0];
  return { target: { tabId, frameId: pick.frameId }, hosts };
}

// Returns { target, error }.
async function findLrsFrame() {
  const seen = [];
  for (const tab of await getCandidateTabs()) {
    const { target, hosts } = await findLrsFrameInTab(tab.id);
    if (target) return { target };
    seen.push({ tabId: tab.id, active: tab.active, frames: hosts });
  }
  console.warn('[LRS] No ' + LRS_HOST + ' frame found. McGill tabs checked:', JSON.stringify(seen));

  // Tabs and frames on hosts the user withheld (chrome://extensions → Site
  // access) are skipped silently, so say so explicitly.
  const withheld = [];
  for (const host of [MYCOURSES_HOST, LRS_HOST]) {
    try {
      if (!(await chrome.permissions.contains({ origins: ['https://' + host + '/*'] }))) withheld.push(host);
    } catch (_) {}
  }
  if (withheld.length > 0) {
    return {
      target: null,
      error: 'The extension is not allowed to access ' + withheld.join(' and ') + '. In chrome://extensions → ' +
             'McGill LRS Downloader → Details, set Site access to allow mcgill.ca sites.'
    };
  }
  return { target: null, error: NO_LRS_FRAME_ERROR };
}

// ─── Code injected into the page ─────────────────────
// These functions are serialized by chrome.scripting, so they must be
// self-contained (no references to anything outside their own body).

// ISOLATED world: relays progress/status messages from the MAIN world to
// the service worker. Re-injected before each download because the
// declarative bridge.js is orphaned when the extension is reloaded while
// the tab is open.
function pageInstallBridge() {
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

// MAIN world, top-level frame of a tab whose LRS player is in an iframe:
// waits for the fetched video from that iframe and saves it.
function pageListenForVideo(downloadId) {
  function report(msg) {
    console.log(msg);
    window.postMessage({ type: '__LRS_STATUS__', message: msg }, '*');
  }

  function handler(e) {
    if (e.data?.type !== '__LRS_DOWNLOAD__') return;
    if (e.data.downloadId !== downloadId) return; // match by unique ID
    window.removeEventListener('message', handler);

    if (e.data.error) {
      report('[LRS] ERROR from LRS frame: ' + e.data.error);
      return;
    }

    const size = e.data.buffer?.byteLength || 0;
    report('[LRS] Received buffer (' + (size / 1e6).toFixed(1) + ' MB), triggering download...');
    try {
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
      window.postMessage({
        type: '__LRS_PROGRESS__', filename: e.data.filename,
        pct: 100, received: size, total: size, complete: true
      }, '*');
    } catch (err) {
      report('[LRS] ERROR creating download: ' + err.message);
      window.postMessage({ type: '__LRS_PROGRESS__', filename: e.data.filename, error: err.message }, '*');
    }
  }

  // No timeout: with "Download all" a recording can wait in the fetch queue
  // for a long time before its buffer arrives; the fetcher always answers,
  // with the buffer or an error.
  window.addEventListener('message', handler);
  report('[LRS] Listener ready on ' + window.location.hostname + ' for ' + downloadId);
  return { role: 'listener' };
}

// MAIN world, the lrs.mcgill.ca frame: fetches the video from the CDN (the
// browser sets Origin: https://lrs.mcgill.ca), then saves it directly if
// this is the top-level frame, or hands the buffer to the top-level frame.
function pageFetchVideo(url, fname, downloadId, lrsHost, idleTimeoutMs) {
  function report(msg) {
    console.log(msg);
    window.postMessage({ type: '__LRS_STATUS__', message: msg }, '*');
  }

  if (window.location.hostname !== lrsHost) {
    return { role: null, error: 'Frame is no longer on ' + lrsHost };
  }
  const isTopFrame = (window === window.top);

  async function run() {
    report('[LRS] Fetching from LRS frame: ' + fname);

    // Abort if no data arrives for idleTimeoutMs (also covers the headers).
    const controller = new AbortController();
    let idleTimer = null;
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), idleTimeoutMs);
    };

    try {
      resetIdleTimer();
      const r = await fetch(url, { headers: { 'Range': 'bytes=0-' }, signal: controller.signal });
      report('[LRS] CDN response: status=' + r.status + ' ok=' + r.ok);
      if (!r.ok && r.status !== 206) throw new Error('CDN ' + r.status);

      const totalStr = r.headers.get('content-range')?.split('/')[1]
                    || r.headers.get('content-length');
      const totalBytes = totalStr ? +totalStr : 0;
      if (totalBytes > 0) report('[LRS] Video size: ~' + (totalBytes / 1e6).toFixed(0) + ' MB');

      // Stream the response with progress reporting. When the size is known,
      // write straight into one pre-sized buffer so the recording isn't held
      // in memory twice (chunks + concatenated copy).
      const reader = r.body.getReader();
      let out = null;
      if (totalBytes > 0) {
        try { out = new Uint8Array(totalBytes); } catch (_) { /* fall back to chunks */ }
      }
      const chunks = [];
      let received = 0;
      let lastProgressAt = 0;

      while (true) {
        resetIdleTimer();
        const { done, value } = await reader.read();
        if (done) break;
        if (out && received + value.byteLength <= out.length) {
          out.set(value, received);
        } else {
          // Size unknown or larger than announced: collect chunks instead
          if (out) { chunks.push(out.subarray(0, received)); out = null; }
          chunks.push(value);
        }
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
      clearTimeout(idleTimer);

      report('[LRS] Fetch complete: ' + (received / 1e6).toFixed(1) + ' MB');
      let buffer;
      if (out) {
        buffer = received === out.length ? out.buffer : out.slice(0, received).buffer;
        out = null;
      } else {
        // Concatenate chunks into a single ArrayBuffer
        buffer = new ArrayBuffer(received);
        const view = new Uint8Array(buffer);
        let offset = 0;
        for (const chunk of chunks) {
          view.set(chunk, offset);
          offset += chunk.byteLength;
        }
      }
      chunks.length = 0;

      if (buffer.byteLength < 1000) throw new Error('Too small: ' + buffer.byteLength + ' bytes');

      // Fetched; "complete" is reported by whichever frame saves the file,
      // once the download has actually been handed to Chrome.
      window.postMessage({
        type: '__LRS_PROGRESS__',
        filename: fname,
        pct: 100,
        received: received,
        total: totalBytes || received
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
        window.postMessage({
          type: '__LRS_PROGRESS__', filename: fname,
          pct: 100, received: received, total: received, complete: true
        }, '*');
      } else {
        // Transfer ArrayBuffer to the top-level frame (zero-copy via transferable)
        window.top.postMessage({
          type: '__LRS_DOWNLOAD__',
          downloadId: downloadId,
          buffer: buffer,
          filename: fname
        }, '*', [buffer]);
        report('[LRS] ArrayBuffer transferred to parent frame');
      }
    } catch (e) {
      clearTimeout(idleTimer);
      const message = e.name === 'AbortError'
        ? 'No data from the server for ' + Math.round(idleTimeoutMs / 1000) + ' s'
        : e.message;
      report('[LRS] ERROR: ' + message);
      window.postMessage({
        type: '__LRS_PROGRESS__',
        filename: fname,
        error: message
      }, '*');
      if (!isTopFrame) {
        try {
          window.top.postMessage({
            type: '__LRS_DOWNLOAD__',
            downloadId: downloadId,
            error: message
          }, '*');
        } catch (_) {}
      }
    }
  }

  // One fetch at a time per frame: each recording is buffered in memory in
  // full, so running "Download all" concurrently would exhaust the tab.
  window.__LRS_FETCH_QUEUE = (window.__LRS_FETCH_QUEUE || Promise.resolve()).then(run, run);
  return { role: 'fetcher' };
}

// ─── Download orchestration ──────────────────────────

async function downloadRecording(recording) {
  try {
    const mediaUrl = await resolveMediaUrl(recording);
    const filename = buildFilename(recording);
    const dlId = 'dl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

    const { target, error } = await findLrsFrame();
    if (!target) return { ok: false, error };

    const { tabId, frameId } = target;
    const nested = frameId !== 0;
    // The top-level frame saves the file; the LRS frame fetches it.
    const frameIds = nested ? [0, frameId] : [0];

    await chrome.scripting.executeScript({
      target: { tabId, frameIds },
      world: 'ISOLATED',
      func: pageInstallBridge
    });

    // TS→MP4 remuxer, needed only where the file is saved
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      files: ['remux.js']
    });

    // Register the listener before the fetch starts so the buffer can't
    // arrive before anyone is waiting for it.
    if (nested) {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: 'MAIN',
        func: pageListenForVideo,
        args: [dlId]
      });
    }

    const [fetchResult] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: pageFetchVideo,
      args: [mediaUrl, filename, dlId, LRS_HOST, FETCH_IDLE_TIMEOUT_MS]
    });

    if (fetchResult?.result?.role !== 'fetcher') {
      return { ok: false, error: fetchResult?.result?.error || NO_LRS_FRAME_ERROR };
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
  // Per-recording failures, so the popup can mark those rows
  const failures = results.filter(r => !r.ok)
    .map(r => ({ recId: r.recId, error: r.error || 'Failed' }));
  if (count === 0) {
    return { ok: false, error: failures[0]?.error || 'No downloads succeeded', failures };
  }
  // Return filename→recId pairs so popup can track progress
  const filenames = results.filter(r => r.ok && r.filename)
    .map(r => ({ filename: r.filename, recId: r.recId }));
  return { ok: true, count, total: recordings.length, filenames, failures };
}
