const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let state = { courses: {}, lastCourseId: null, downloads: {} };
let recordings = [];
let currentToken = null;
let currentCourseId = null;

// ─── Init ────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  state = await sendMessage({ type: 'GET_STATE' });

  // On popup open, immediately clear any stuck 'saving' downloads.
  // The saving step takes <1s, so if we see it on open, the SW crashed.
  await clearStaleDownloads();

  tryLoadFromState();

  $('#downloadAllBtn').addEventListener('click', downloadAll);

  // Live-update when background updates storage (token capture + download progress)
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.lastCourseId || changes.courses) {
      sendMessage({ type: 'GET_STATE' }).then((fresh) => {
        state = fresh;
        if (!currentToken) tryLoadFromState();
      });
    }
    if (changes.downloads) {
      state.downloads = changes.downloads.newValue || {};
      updateAllProgress();
    }
  });

});

function tryLoadFromState() {
  if (!state.lastCourseId || !state.courses[state.lastCourseId]) return;

  const course = state.courses[state.lastCourseId];

  if (course.exp && Date.now() / 1000 > course.exp) {
    showTokenStatus('Expired', false);
    return;
  }

  currentToken = course.token;
  currentCourseId = state.lastCourseId;
  showTokenStatus('Active', true);
  loadRecordings();
}

// ─── Communication ───────────────────────────────────

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => resolve(resp));
  });
}

// ─── UI Updates ──────────────────────────────────────

function showTokenStatus(text, active) {
  const badge = $('#tokenStatus');
  badge.textContent = text;
  badge.className = 'header-badge' + (active ? ' active' : '');
}

function showLoading() {
  $('#emptyState').style.display = 'none';
  $('#recordingsView').style.display = 'block';
  $('#recordingsView').querySelector('.actions-bar').style.display = 'none';
  $('#recordingsList').innerHTML = `
    <div class="loading">
      <div class="spinner"></div>
      Fetching recordings...
    </div>
  `;
}

async function loadRecordings() {
  showLoading();

  const result = await sendMessage({
    type: 'FETCH_RECORDINGS',
    token: currentToken,
    courseId: currentCourseId
  });

  if (!result.ok) {
    $('#recordingsList').innerHTML = `
      <div class="loading">Failed to load: ${result.error}</div>
    `;
    return;
  }

  recordings = result.recordings;
  renderRecordings();
}

function renderRecordings() {
  if (!recordings.length) {
    $('#recordingsList').innerHTML = `
      <div class="loading">No recordings found</div>
    `;
    return;
  }

  const course = recordings[0];
  $('#emptyState').style.display = 'none';
  $('#recordingsView').style.display = 'block';
  $('#recordingsView').querySelector('.actions-bar').style.display = 'flex';

  $('#courseName').textContent = course.courseName || 'Recordings';
  $('#courseMeta').textContent = `${course.semesterName} \u00B7 ${recordings.length} lectures`;

  const list = $('#recordingsList');
  list.innerHTML = recordings.map((rec, i) => {
    const dt = new Date(rec.dateTime);
    const dateStr = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const timeStr = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const instructor = rec.instructor || '\u2014';
    const duration = formatDuration(rec.durationSeconds);
    const dl = state.downloads[rec.id];
    const dlState = dl?.status || 'idle';

    return `
      <div class="rec-item" data-index="${i}" data-id="${rec.id}">
        <div class="rec-date">
          <div class="rec-date-day">${dateStr}</div>
          <div class="rec-date-time">${timeStr}</div>
        </div>
        <div class="rec-info">
          <div class="rec-instructor">${instructor}</div>
          <div class="rec-progress" id="progress-${rec.id}">
            ${dlState === 'downloading' || dlState === 'saving' ? formatProgress(dl)
              : dlState === 'complete' ? '<span class="rec-progress-text done">Downloaded</span>'
              : dlState === 'failed' ? '<span class="rec-progress-text failed">Failed · click to retry</span>'
              : `<span class="rec-duration">${duration}</span>`}
          </div>
        </div>
        <div class="rec-action">
          <button class="btn-dl ${dlState}" data-id="${rec.id}" data-index="${i}">
            ${getIcon(dlState)}
          </button>
        </div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.btn-dl').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index);
      downloadSingle(idx, btn);
    });
  });

  updateDownloadCount();
}

function formatProgress(dl) {
  if (!dl || !dl.total) return '';
  const pct = Math.round((dl.received / dl.total) * 100);
  const recvMB = (dl.received / (1024 * 1024)).toFixed(0);
  const totalMB = (dl.total / (1024 * 1024)).toFixed(0);

  if (dl.status === 'saving') {
    return `<span class="rec-progress-text">Saving to disk...</span>
            <div class="progress-bar"><div class="progress-fill" style="width:100%"></div></div>`;
  }

  return `<span class="rec-progress-text">${pct}% \u00B7 ${recvMB} / ${totalMB} MB</span>
          <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>`;
}

function updateAllProgress() {
  if (!recordings.length) return;

  recordings.forEach(rec => {
    const dl = state.downloads[rec.id];
    if (!dl) return;

    // Update progress text + bar
    const progressEl = $(`#progress-${rec.id}`);
    if (progressEl) {
      if (dl.status === 'downloading' || dl.status === 'saving') {
        progressEl.innerHTML = formatProgress(dl);
      } else if (dl.status === 'complete') {
        progressEl.innerHTML = `<span class="rec-progress-text done">Downloaded</span>`;
      } else if (dl.status === 'failed') {
        progressEl.innerHTML = `<span class="rec-progress-text failed">Failed · click to retry</span>`;
      }
    }

    // Update button icon
    const btn = $(`.btn-dl[data-id="${rec.id}"]`);
    if (btn) {
      btn.className = `btn-dl ${dl.status}`;
      btn.innerHTML = getIcon(dl.status);
    }
  });

  updateDownloadCount();
}

function getIcon(status) {
  switch (status) {
    case 'downloading':
    case 'saving':
      return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2v9M4 8l4 4 4-4M3 13h10"/></svg>`;
    case 'complete':
      return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 8.5l3.5 3.5 6.5-7"/></svg>`;
    case 'failed':
      return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 8a6 6 0 0 1 10.3-4.2M14 8a6 6 0 0 1-10.3 4.2M14 2v4h-4M2 14v-4h4"/></svg>`;
    default:
      return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2v9M4 8l4 4 4-4M3 13h10"/></svg>`;
  }
}

function updateDownloadCount() {
  if (!recordings.length) return;
  const done = recordings.filter(r => state.downloads[r.id]?.status === 'complete').length;
  const failed = recordings.filter(r => state.downloads[r.id]?.status === 'failed').length;
  const downloading = recordings.filter(r =>
    state.downloads[r.id]?.status === 'downloading' || state.downloads[r.id]?.status === 'saving'
  ).length;
  const total = recordings.length;

  const course = recordings[0];
  const parts = [`${course.semesterName} \u00B7 ${total} lectures`];
  if (done > 0) parts.push(`${done} downloaded`);
  if (downloading > 0) parts.push(`${downloading} in progress`);
  if (failed > 0) parts.push(`${failed} failed`);
  $('#courseMeta').textContent = parts.join(' \u00B7 ');

  const btn = $('#downloadAllBtn');
  const remaining = total - done;
  if (done === total) {
    btn.innerHTML = `All downloaded <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 8.5l3.5 3.5 6.5-7"/></svg>`;
    btn.disabled = true;
    btn.style.opacity = '0.5';
    btn.style.cursor = 'default';
  } else if (done > 0) {
    btn.innerHTML = `Download remaining (${remaining}) <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2v9M4 8l4 4 4-4M3 13h10"/></svg>`;
  }
}

// ─── Downloads ───────────────────────────────────────

async function downloadSingle(index, btn) {
  const rec = recordings[index];
  if (!rec) return;

  // Don't restart if already downloading/complete
  const existing = state.downloads[rec.id]?.status;
  if (existing === 'downloading' || existing === 'saving' || existing === 'complete') return;

  btn.className = 'btn-dl downloading';
  btn.innerHTML = getIcon('downloading');

  // Send request — the background handles everything asynchronously
  // Progress updates come via chrome.storage.onChanged
  sendMessage({
    type: 'DOWNLOAD_RECORDING',
    recording: rec,
    token: currentToken
  });
}

async function downloadAll() {
  for (let i = 0; i < recordings.length; i++) {
    const rec = recordings[i];
    const existing = state.downloads[rec.id]?.status;
    if (existing === 'complete' || existing === 'downloading' || existing === 'saving') continue;

    const btn = $(`.btn-dl[data-index="${i}"]`);
    if (btn) downloadSingle(i, btn);

    // Wait for this download to finish before starting the next
    await waitForDownload(rec.id);
    await new Promise(r => setTimeout(r, 500));
  }
}

function waitForDownload(recId) {
  return new Promise(resolve => {
    const check = () => {
      const status = state.downloads[recId]?.status;
      if (status === 'complete' || status === 'failed') {
        resolve();
      } else {
        setTimeout(check, 2000);
      }
    };
    setTimeout(check, 2000);
  });
}

// ─── Stale Download Recovery ─────────────────────────

async function clearStaleDownloads() {
  const data = await chrome.storage.local.get('downloads');
  const downloads = data.downloads || {};
  let changed = false;

  for (const [id, dl] of Object.entries(downloads)) {
    if (dl.status === 'saving') {
      // 'saving' is a transient state (<1s). If we see it on popup open,
      // the service worker crashed before completing. Reset to allow retry.
      downloads[id].status = 'failed';
      changed = true;
    }
  }

  if (changed) {
    await chrome.storage.local.set({ downloads });
    state.downloads = downloads;
  }
}

// ─── Helpers ─────────────────────────────────────────

function formatDuration(secs) {
  if (!secs) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
