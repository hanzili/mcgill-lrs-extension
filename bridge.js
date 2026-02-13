// Runs in ISOLATED world — receives messages from the MAIN world
// (intercept.js / injected scripts) via postMessage and forwards
// them to the background service worker via chrome.runtime.sendMessage.

window.addEventListener('message', (event) => {
  if (event.source !== window) return;

  if (event.data?.type === '__LRS_TOKEN__') {
    chrome.runtime.sendMessage({
      type: 'TOKEN_CAPTURED',
      token: event.data.token
    });
  }

  // Relay status logs from injected MAIN-world download code → SW console
  if (event.data?.type === '__LRS_STATUS__') {
    chrome.runtime.sendMessage({
      type: 'DOWNLOAD_STATUS',
      message: event.data.message
    });
  }

  // Relay download progress → background → chrome.storage → popup
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
});
