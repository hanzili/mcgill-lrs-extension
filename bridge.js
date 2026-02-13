// Runs in ISOLATED world — receives tokens from the MAIN world
// intercept.js via postMessage and forwards them to the background
// service worker via chrome.runtime.sendMessage.

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== '__LRS_TOKEN__') return;

  chrome.runtime.sendMessage({
    type: 'TOKEN_CAPTURED',
    token: event.data.token
  });
});
