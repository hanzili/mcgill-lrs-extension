const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let state = { courses: {}, lastCourseId: null, downloads: {} };
let recordings = [];
let currentToken = null;
let currentCourseId = null;

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

// ─── Downloads ───────────────────────────────────────

async function downloadSingle(index, btn) {
  const rec = recordings[index];
  if (!rec) return;

  const progressEl = $(`#progress-${rec.id}`);

  btn.innerHTML = getIcon('loading');
  if (progressEl) progressEl.innerHTML = '<span class="rec-progress-text">Preparing script...</span>';

  const result = await sendMessage({
    type: 'DOWNLOAD_RECORDING',
    recording: rec
  });

  if (result?.ok) {
    btn.innerHTML = getIcon('done');
    btn.className = 'btn-dl complete';
    if (progressEl) progressEl.innerHTML = '<span class="rec-progress-text done">Script saved</span>';
  } else {
    btn.innerHTML = getIcon('failed');
    btn.className = 'btn-dl failed';
    if (progressEl) progressEl.innerHTML = `<span class="rec-progress-text failed">${result?.error || 'Failed'}</span>`;
  }
}

async function downloadAll() {
  const btn = $('#downloadAllBtn');
  btn.innerHTML = 'Preparing script...';
  btn.disabled = true;

  const result = await sendMessage({
    type: 'DOWNLOAD_ALL',
    recordings
  });

  if (result?.ok) {
    btn.innerHTML = `Script saved \u2714`;
    // Show instructions
    const hint = document.createElement('div');
    hint.className = 'script-hint';
    hint.innerHTML = `
      Open <strong>McGill-Lectures/</strong> in Downloads, then:<br>
      <code>chmod +x *.command && open *.command</code>
    `;
    btn.parentElement.appendChild(hint);
  } else {
    btn.innerHTML = `Failed: ${result?.error || 'Unknown error'}`;
    btn.disabled = false;
  }
}

// ─── Helpers ─────────────────────────────────────────

function formatDuration(secs) {
  if (!secs) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
