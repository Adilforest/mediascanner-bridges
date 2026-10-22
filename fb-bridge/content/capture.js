// FB Bridge: снимает посты ленты из ответов, которые страница Facebook получает
// сама, и дозапрашивает следующие порции ленты тем же запросом, что делает сайт
// при прокрутке (paginate ниже).
//
// MAIN world, document_start: обёртки над fetch и XMLHttpRequest должны встать
// раньше кода сайта. Разбор в content/extract.js (грузится перед этим файлом).

(function () {
  "use strict";
  if (window.__fbBridge) return;
  const X = window.FBBridgeExtract;
  const posts = new Map();
  const isGraphql = (url) => /\/api\/graphql\/?/.test(String(url || ""));

  function take(text) {
    if (!X || typeof text !== "string" || text.indexOf('"Story"') < 0) return;
    for (const blob of X.parseLines(text)) {
      try { X.storiesIn(blob, posts); } catch (_) { /* не мешаем странице */ }
    }
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === "string" ? input : input && input.url;
      if (isGraphql(url)) {
        p.then((r) => r.clone().text()).then(take).catch(() => {});
      }
    } catch (_) { /* ignore */ }
    return p;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (isGraphql(url)) {
      this.addEventListener("load", function () {
        try {
          if (this.responseType === "" || this.responseType === "text") take(this.responseText);
        } catch (_) { /* ignore */ }
      });
    }
    return origOpen.apply(this, arguments);
  };

  function pageState() {
    const path = location.pathname;
    if (/^\/(login|recover)/.test(path) || document.querySelector("form#login_form, input[name=pass]")) return "login";
    if (/^\/checkpoint/.test(path)) return "checkpoint";
    const text = (document.body && document.body.innerText) || "";
    if (/временно заблокирован|temporarily blocked|You're Temporarily Blocked/i.test(text)) return "checkpoint";
    return "ok";
  }

  function targetState(found) {
    if (found) return "ok";
    const text = (document.body && document.body.innerText) || "";
    if (/Закрытая группа|Private group|Жабық топ/i.test(text) && /Вступить|Join group|Қосылу/i.test(text)) return "closed";
    if (/контент сейчас недоступен|content isn't available|isn't available right now|Страница недоступна/i.test(text)) {
      return "unavailable";
    }
    return "ok";
  }

  // --- дозагрузка ленты ------------------------------------------------------
  //
  // Фоновую, свёрнутую или закрытую другим окном вкладку Chrome не отрисовывает,
  // и при прокрутке лента не подгружается: в разметке приходит 1-3 поста
  // (проверка 12.10.2026). Поэтому следующие порции ленты запрашиваются тем же
  // запросом, который делает сам сайт при прокрутке: doc_id из модуля
  // <запрос>_facebookRelayOperation, переменные и курсор из данных первой
  // загрузки, токены страницы. Ничего не зашито: при обновлении Facebook всё
  // берётся со страницы заново.

  const OPS = { GROUP: "GroupsCometFeedRegularStoriesPaginationQuery", TIMELINE: "ProfileCometTimelineFeedRefetchQuery" };
  const FEEDS = new Set(["group_feed", "timeline_list_feed_units"]);
  // переменные запроса пагинации, которых нет у первой загрузки
  const EXTRA = {
    GROUP: (id) => ({ filterTopicId: null, referringStoryRenderLocation: null, stream_initial_count: 1, youthIntegrityHostID: id }),
    TIMELINE: () => ({ afterTime: null, beforeTime: null, memorializedSplitTimeFilter: null, postedBy: { group: "OWNER" },
      privacy: null, referringStoryRenderLocation: null, run_with_continuation_key: true, stream_count: 1,
      taggedInOnly: null, trackingCode: null }),
  };

  function feedCursor(blob, found) {
    const stack = [blob];
    while (stack.length) {
      const o = stack.pop();
      if (!o || typeof o !== "object") continue;
      if (Array.isArray(o)) { for (const v of o) stack.push(v); continue; }
      if (!found.pre && o.preloaderID && o.variables && OPS[o.variables.feedLocation]) found.pre = o;
      if (Array.isArray(o.path) && FEEDS.has(o.path[o.path.length - 1]) && o.data && o.data.page_info
          && typeof o.data.page_info.end_cursor === "string") found.pageInfo = o.data.page_info;
      // ответ пагинации без потока: page_info рядом с edges постов (у комментариев свои page_info)
      if (o.page_info && typeof o.page_info.end_cursor === "string" && Array.isArray(o.edges)
          && o.edges.some((e) => e && e.node && e.node.__typename === "Story")) found.pageInfo = o.page_info;
      for (const k in o) stack.push(o[k]);
    }
    return found;
  }

  async function paginate(pages, stopBeforeSec) {
    const found = {};
    for (const s of document.querySelectorAll('script[type="application/json"]')) {
      const t = s.textContent || "";
      if (t.indexOf("feedLocation") < 0 && t.indexOf("page_info") < 0) continue;
      try { feedCursor(JSON.parse(t), found); } catch (_) { /* ignore */ }
    }
    if (!found.pre) return { pages: 0, reason: "no_feed" };
    const kind = found.pre.variables.feedLocation;
    const name = OPS[kind];
    let docId;
    try { docId = require(name + "_facebookRelayOperation"); } catch (_) { docId = null; }
    if (!docId) return { pages: 0, reason: "no_doc_id" };
    const base = Object.assign({}, found.pre.variables);
    const id = base.groupID || base.userID || base.id;
    delete base.groupID;
    delete base.userID;
    const dtsg = require("DTSGInitialData").token;
    const lsd = require("LSD").token;
    const site = require("SiteData");
    const user = require("CurrentUserInitialData").USER_ID;
    let jaz = 0;
    for (const c of dtsg) jaz += c.charCodeAt(0);
    let cursor = found.pageInfo && found.pageInfo.has_next_page !== false ? found.pageInfo.end_cursor : null;
    let done = 0;
    for (; done < pages && cursor; done += 1) {
      const vars = Object.assign(EXTRA[kind](id), base, { count: 3, cursor, id });
      const body = new URLSearchParams({
        av: user, __user: user, __a: "1", __req: (done + 1).toString(36), __comet_req: String(site.comet_env || 15),
        fb_dtsg: dtsg, jazoest: "2" + jaz, lsd, __rev: String(site.client_revision), __hs: site.haste_session,
        __spin_r: String(site.__spin_r), __spin_b: site.__spin_b, __spin_t: String(site.__spin_t),
        fb_api_caller_class: "RelayModern", fb_api_req_friendly_name: name, variables: JSON.stringify(vars),
        server_timestamps: "true", doc_id: docId,
      });
      const r = await origFetch.call(window, "/api/graphql/", {
        method: "POST", credentials: "include", body,
        headers: { "content-type": "application/x-www-form-urlencoded", "x-fb-friendly-name": name, "x-fb-lsd": lsd },
      });
      if (!r.ok) return { pages: done, reason: "http_" + r.status };
      const text = await r.text();
      const page = new Map();
      const next = {};
      for (const blob of X.parseLines(text)) {
        X.storiesIn(blob, page);
        feedCursor(blob, next);
      }
      for (const [k, v] of page) posts.set(k, v);
      if (!page.size) return { pages: done + 1, reason: /"errors"/.test(text) ? "errors" : "empty" };
      // дальше только посты старше нужного: хватит
      if (Math.max(...[...page.values()].map((p) => p.time)) < stopBeforeSec) return { pages: done + 1, reason: "old" };
      cursor = next.pageInfo && next.pageInfo.has_next_page !== false ? next.pageInfo.end_cursor : null;
      await new Promise((res) => setTimeout(res, 1500 + Math.random() * 2000));
    }
    return { pages: done, reason: cursor ? "limit" : "end" };
  }

  window.__fbBridge = {
    paginate,
    collect() {
      // первая порция постов приходит не запросом, а в разметке страницы
      for (const s of document.querySelectorAll('script[type="application/json"]')) {
        const t = s.textContent || "";
        if (t.indexOf('"Story"') < 0) continue;
        try { X.storiesIn(JSON.parse(t), posts); } catch (_) { /* ignore */ }
      }
      const list = Array.from(posts.values());
      const state = pageState();
      return { state, target: state === "ok" ? targetState(list.length > 0) : state, url: location.href, posts: list };
    },
  };
})();
