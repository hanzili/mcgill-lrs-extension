// Runs in MAIN world — patches fetch/XHR to capture JWT tokens
// sent to the McGill LRS API. Communicates via postMessage to the
// bridge script running in the ISOLATED world.

(function() {
  const TARGET = 'lrswapi.campus.mcgill.ca';
  const MSG_TYPE = '__LRS_TOKEN__';

  function extractAuth(headers) {
    if (!headers) return null;
    if (headers instanceof Headers) return headers.get('Authorization');
    if (Array.isArray(headers)) {
      const pair = headers.find(([k]) => k.toLowerCase() === 'authorization');
      return pair ? pair[1] : null;
    }
    if (typeof headers === 'object') {
      return headers['Authorization'] || headers['authorization'] || null;
    }
    return null;
  }

  function emit(token) {
    window.postMessage({ type: MSG_TYPE, token }, '*');
  }

  // ── Patch fetch ────────────────────────────────────
  const _fetch = window.fetch;
  window.fetch = function(input, init) {
    try {
      const url = typeof input === 'string' ? input
                : input instanceof Request ? input.url
                : String(input);

      if (url.includes(TARGET)) {
        // Check init.headers first, then Request headers
        let auth = extractAuth(init?.headers);
        if (!auth && input instanceof Request) {
          auth = input.headers.get('Authorization');
        }
        if (auth && auth.startsWith('Bearer ')) {
          emit(auth.slice(7));
        }
      }
    } catch (_) {}
    return _fetch.apply(this, arguments);
  };

  // ── Patch XMLHttpRequest ───────────────────────────
  const _open = XMLHttpRequest.prototype.open;
  const _setHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function(method, url) {
    this._lrsUrl = String(url);
    return _open.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    if (
      this._lrsUrl?.includes(TARGET) &&
      name.toLowerCase() === 'authorization' &&
      value.startsWith('Bearer ')
    ) {
      emit(value.slice(7));
    }
    return _setHeader.apply(this, arguments);
  };
})();
