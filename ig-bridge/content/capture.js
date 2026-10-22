// IG Bridge: захват конфигурации запросов страницы (план Instagram v2, 02).
//
// Выполняется в MAIN world на document_start: оборачивает fetch и
// XMLHttpRequest и для запросов к /graphql/query выписывает имя запроса,
// doc_id, форму variables и заголовки x-ig-app-id / x-asbd-id. Instagram
// меняет doc_id раз в 2-4 недели; так расширение узнаёт новый сам, а сервер
// не может подсунуть под разрешённое имя чужой doc_id.
//
// Сессионные токены (fb_dtsg, lsd, jazoest) не читаются и не передаются.
(() => {
  if (window.__igBridgeCaptureInstalled) return;
  window.__igBridgeCaptureInstalled = true;

  const WANT = new Set(["PolarisProfilePostsQuery"]);
  const GRAPHQL_RE = /\/(graphql\/query|api\/graphql)\/?(\?|$)/;

  function toParams(body) {
    if (typeof body === "string") return new URLSearchParams(body);
    if (body instanceof URLSearchParams) return body;
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      const out = new URLSearchParams();
      for (const [k, v] of body.entries()) if (typeof v === "string") out.append(k, v);
      return out;
    }
    return null;
  }

  function headerValue(headers, name) {
    if (!headers) return null;
    try {
      if (typeof Headers !== "undefined" && headers instanceof Headers) return headers.get(name);
      if (Array.isArray(headers)) {
        const hit = headers.find((h) => String(h[0]).toLowerCase() === name);
        return hit ? hit[1] : null;
      }
      for (const k of Object.keys(headers)) if (k.toLowerCase() === name) return headers[k];
    } catch (_) {}
    return null;
  }

  function inspect(url, body, headers) {
    if (!url || !GRAPHQL_RE.test(String(url))) return;
    const params = toParams(body);
    if (!params) return;
    const name = params.get("fb_api_req_friendly_name");
    const docId = params.get("doc_id");
    if (!name || !docId || !WANT.has(name) || !/^\d{1,25}$/.test(docId)) return;
    let variables = null;
    try { variables = JSON.parse(params.get("variables") || "null"); } catch (_) {}
    window.postMessage({
      __igBridgeCapture: true,
      name,
      docId,
      variables,
      appId: headerValue(headers, "x-ig-app-id"),
      asbdId: headerValue(headers, "x-asbd-id"),
    }, location.origin);
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : (input && input.url);
      inspect(url, init && init.body, (init && init.headers) || (input && input.headers));
    } catch (_) {}
    return origFetch.apply(this, arguments);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__igBridgeUrl = url;
    this.__igBridgeHeaders = {};
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try { if (this.__igBridgeHeaders) this.__igBridgeHeaders[name] = value; } catch (_) {}
    return origSetHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try { inspect(this.__igBridgeUrl, body, this.__igBridgeHeaders); } catch (_) {}
    return origSend.apply(this, arguments);
  };
})();
