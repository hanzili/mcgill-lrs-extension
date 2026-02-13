// Pings the service worker every 20s to prevent Chrome from killing it
// during long-running downloads. Created/destroyed by background.js.
setInterval(() => {
  chrome.runtime.sendMessage({ type: 'KEEPALIVE' }).catch(() => {});
}, 20000);
