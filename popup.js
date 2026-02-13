const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let state = { courses: {}, lastCourseId: null, downloads: {} };
let recordings = [];
let currentToken = null;
let currentCourseId = null;
const downloadMap = {}; // filename → rec.id (tracks which download updates which row)

// ─── Init ────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  state = await sendMessage({ type: 'GET_STATE' });
  tryLoadFromState();

  $('#downloadAllBtn').addEventListener('click', downloadAll);

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.lastCourseId || changes.courses) {
      sendMessage({ type: 'GET_STATE' }).then((fresh) => {
        state = fresh;
        if (!currentToken) tryLoadFromState();
      });
    }
    if (changes.downloadProgress) {
      console.log('[popup] storage changed: downloadProgress', changes.downloadProgress.newValue?.filename);
      updateDownloadProgress(changes.downloadProgress.newValue);
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

    return `
      <div class="rec-item" data-index="${i}" data-id="${rec.id}">
        <div class="rec-date">
          <div class="rec-date-day">${dateStr}</div>
          <div class="rec-date-time">${timeStr}</div>
        </div>
        <div class="rec-info">
          <div class="rec-instructor">${instructor}</div>
          <div class="rec-progress" id="progress-${rec.id}">
            <span class="rec-duration">${duration}</span>
          </div>
        </div>
        <div class="rec-action">
          <button class="btn-dl" data-id="${rec.id}" data-index="${i}">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2v9M4 8l4 4 4-4M3 13h10"/></svg>
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
}

function getIcon(status) {
  switch (status) {
    case 'loading':
      return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" class="spin"><circle cx="8" cy="8" r="6" stroke-dasharray="28" stroke-dashoffset="8"/></svg>`;
    case 'done':
      return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 8.5l3.5 3.5 6.5-7"/></svg>`;
    case 'failed':
      return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 8a6 6 0 0 1 10.3-4.2M14 8a6 6 0 0 1-10.3 4.2M14 2v4h-4M2 14v-4h4"/></svg>`;
    default:
      return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2v9M4 8l4 4 4-4M3 13h10"/></svg>`;
  }
}

function updateDownloadProgress(progress) {
  if (!progress?.filename) return;

  const recId = downloadMap[progress.filename];
  console.log('[popup] progress:', progress.filename, progress.pct, 'recId:', recId, 'map:', Object.keys(downloadMap));
  if (!recId) return;

  const progressEl = $(`#progress-${recId}`);
  if (!progressEl) return;

  if (progress.error) {
    progressEl.innerHTML = `<span class="rec-progress-text failed">Error: ${progress.error}</span>`;
    const btn = $(`.btn-dl[data-id="${recId}"]`);
    if (btn) { btn.innerHTML = getIcon('failed'); btn.className = 'btn-dl failed'; }
    return;
  }

  if (progress.complete) {
    progressEl.innerHTML = '<span class="rec-progress-text done">Complete!</span>';
    const btn = $(`.btn-dl[data-id="${recId}"]`);
    if (btn) { btn.innerHTML = getIcon('done'); btn.className = 'btn-dl complete'; }
    return;
  }

  const receivedMB = (progress.received / 1e6).toFixed(0);
  const totalMB = progress.total > 0 ? (progress.total / 1e6).toFixed(0) : '?';
  const pctText = progress.pct !== null ? `${progress.pct}%` : '';
  const sizeText = `${receivedMB}/${totalMB} MB`;
  const barPct = progress.pct !== null ? progress.pct : 0;

  progressEl.innerHTML = `
    <span class="rec-progress-text">${pctText} ${sizeText}</span>
    <div class="progress-bar"><div class="progress-fill" style="width:${barPct}%"></div></div>
  `;
}

// ─── Downloads ───────────────────────────────────────

async function downloadSingle(index, btn) {
  const rec = recordings[index];
  if (!rec) return;

  const progressEl = $(`#progress-${rec.id}`);

  // Pre-populate downloadMap BEFORE sending — progress events may arrive
  // before the sendMessage response returns
  const expectedFilename = buildFilename(rec);
  downloadMap[expectedFilename] = rec.id;

  btn.innerHTML = getIcon('loading');
  btn.className = 'btn-dl downloading';
  if (progressEl) progressEl.innerHTML = '<span class="rec-progress-text">Downloading...</span>';

  const result = await sendMessage({
    type: 'DOWNLOAD_RECORDING',
    recording: rec
  });

  if (result?.ok) {
    // Also store the actual filename from background (in case it differs)
    if (result.filename) downloadMap[result.filename] = rec.id;
    if (progressEl) progressEl.innerHTML = '<span class="rec-progress-text">Starting...</span>';
    showKeepOpenHint();
  } else {
    btn.innerHTML = getIcon('failed');
    btn.className = 'btn-dl failed';
    if (progressEl) progressEl.innerHTML = `<span class="rec-progress-text failed">${result?.error || 'Failed'}</span>`;
  }
}

async function downloadAll() {
  const btn = $('#downloadAllBtn');
  btn.innerHTML = 'Starting downloads...';
  btn.disabled = true;

  // Pre-populate downloadMap for ALL recordings BEFORE sending —
  // background processes sequentially, and progress events arrive
  // before downloadAll returns.
  for (const rec of recordings) {
    const fname = buildFilename(rec);
    downloadMap[fname] = rec.id;
    const rowBtn = $(`.btn-dl[data-id="${rec.id}"]`);
    if (rowBtn) { rowBtn.innerHTML = getIcon('loading'); rowBtn.className = 'btn-dl downloading'; }
    const rowProgress = $(`#progress-${rec.id}`);
    if (rowProgress) rowProgress.innerHTML = '<span class="rec-progress-text">Queued...</span>';
  }
  showKeepOpenHint();

  const result = await sendMessage({
    type: 'DOWNLOAD_ALL',
    recordings
  });

  if (result?.ok) {
    // Also store actual filenames from background (in case they differ)
    if (result.filenames) {
      for (const { filename, recId } of result.filenames) {
        downloadMap[filename] = recId;
      }
    }
    const msg = result.count === result.total
      ? `${result.count} downloads started`
      : `${result.count}/${result.total} started`;
    btn.innerHTML = msg;
    showKeepOpenHint();
  } else {
    btn.innerHTML = `Failed: ${result?.error || 'Unknown error'}`;
    btn.disabled = false;
  }
}

function showKeepOpenHint() {
  if ($('#keepOpenHint')) return; // only show once
  const hint = document.createElement('div');
  hint.id = 'keepOpenHint';
  hint.className = 'script-hint';
  hint.innerHTML = 'Keep the lecture tab open — the video is downloading in the background. It will appear in Chrome\'s download bar when ready.';
  $('#recordingsList').parentElement.appendChild(hint);
}

// ─── Helpers ─────────────────────────────────────────

function formatDuration(secs) {
  if (!secs) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Must match background.js buildFilename exactly
function buildFilename(recording) {
  const date = (recording.dateTime || new Date().toISOString()).split('T')[0];
  const instructor = (recording.instructor || 'Lecture').replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
  const course = (recording.courseName || 'Recording').replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
  return `${course}_${date}_${instructor}.mp4`;
}
