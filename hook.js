// Работает в контексте страницы (world: MAIN): записывает fetch/XHR-запросы для диагностики.
(() => {
  if (window.__tmsHooked) return;
  window.__tmsHooked = true;
  const log = [];
  const MAX = 150;
  const cut = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s);

  // структура JSON: ключи + первый элемент массивов (обрезанный)
  function shape(v, depth = 0) {
    if (Array.isArray(v)) return { _array: v.length, first: depth < 4 && v.length ? shape(v[0], depth + 1) : undefined };
    if (v && typeof v === 'object') {
      if (depth >= 5) return '{…}';
      const o = {};
      Object.keys(v).slice(0, 60).forEach((k) => (o[k] = shape(v[k], depth + 1)));
      return o;
    }
    return typeof v === 'string' ? cut(v, 80) : v;
  }

  function push(entry, text) {
    try {
      const j = JSON.parse(text);
      entry.responseShape = shape(j);
    } catch (e) {
      entry.responseSnippet = cut(text, 300);
    }
    log.push(entry);
    if (log.length > MAX) log.shift();
  }

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const res = await origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input.url;
      const entry = {
        type: 'fetch', url, method: (init && init.method) || (input && input.method) || 'GET',
        requestBody: cut(init && typeof init.body === 'string' ? init.body : '', 1500),
        status: res.status
      };
      res.clone().text().then((t) => push(entry, t)).catch(() => {});
    } catch (e) {}
    return res;
  };

  const oOpen = XMLHttpRequest.prototype.open;
  const oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__t = { method: m, url: u }; return oOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    this.addEventListener('load', () => {
      try {
        const entry = { type: 'xhr', ...this.__t, requestBody: cut(typeof body === 'string' ? body : '', 1500), status: this.status };
        push(entry, typeof this.responseText === 'string' ? this.responseText : '');
      } catch (e) {}
    });
    return oSend.apply(this, arguments);
  };

  const OWS = window.WebSocket;
  window.WebSocket = function (url, p) {
    log.push({ type: 'websocket', url: String(url).replace(/(token|key|auth)=[^&]+/gi, '$1=…') });
    return p ? new OWS(url, p) : new OWS(url);
  };
  window.WebSocket.prototype = OWS.prototype;
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.__tmsReq) window.postMessage({ __tmsRes: true, log }, '*');
  });
})();
