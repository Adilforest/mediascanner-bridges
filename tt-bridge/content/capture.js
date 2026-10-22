// TikTok Bridge: снимает посты аккаунта из ответа /api/post/item_list/, который страница
// TikTok получает сама, и данные профиля из разметки страницы.
//
// MAIN world, document_start: обёртки над fetch и XMLHttpRequest должны встать раньше
// кода сайта. Разбор в content/extract.js (грузится перед этим файлом). Своих запросов
// к TikTok расширение не делает: подпись запросов (msToken, X-Bogus) ставит сама страница.

(function () {
  "use strict";
  if (window.__ttBridge) return;
  const X = window.TTBridgeExtract;
  const posts = new Map();
  const seen = { lists: 0, last: 0 };
  const isItemList = (url) => /\/api\/post\/item_list\/?/.test(String(url || ""));

  function take(text) {
    if (!X || typeof text !== "string" || text.indexOf("itemList") < 0) return;
    try {
      const before = posts.size;
      X.postsIn(text, posts, currentUser());
      seen.lists += 1;
      seen.last = Date.now();
      return posts.size - before;
    } catch (_) { /* не мешаем странице */ }
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === "string" ? input : input && input.url;
      if (isItemList(url)) p.then((r) => r.clone().text()).then(take).catch(() => {});
    } catch (_) { /* ignore */ }
    return p;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (isItemList(url)) {
      this.addEventListener("load", function () {
        try {
          if (this.responseType === "" || this.responseType === "text") take(this.responseText);
          else if (this.responseType === "json" && this.response) take(JSON.stringify(this.response));
        } catch (_) { /* ignore */ }
      });
    }
    return origOpen.apply(this, arguments);
  };

  function currentUser() {
    const m = location.pathname.match(/^\/@([^/]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }

  function rehydration() {
    const el = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
    if (!el) return null;
    try { return JSON.parse(el.textContent || ""); } catch (_) { return null; }
  }

  const CAPTCHA_SEL = '#captcha_container, .captcha-verify-container, .captcha_verify_container, [class*="captcha-modal"], '
    + 'iframe[src*="captcha"], [id*="captcha-verify"]';
  const CAPTCHA_TEXT = /Drag the slider|Verify to continue|Перетащите ползунок|Подтвердите, что вы не робот|Select 2 objects|puzzle/i;
  const NOT_FOUND_TEXT = /Couldn't find this account|Не удалось найти этот аккаунт|Бұл аккаунт табылмады/i;
  const PRIVATE_TEXT = /This account is private|Этот аккаунт закрыт|Бұл аккаунт жабық/i;

  function pageState() {
    if (document.querySelector(CAPTCHA_SEL)) return "checkpoint";
    const text = (document.body && document.body.innerText) || "";
    if (CAPTCHA_TEXT.test(text) && /captcha|slider|ползун|puzzle/i.test(document.documentElement.innerHTML.slice(0, 400000))) {
      return "checkpoint";
    }
    return "ok";
  }

  // Запасной путь, если ответ item_list не пойман: ссылки на видео в сетке страницы.
  // Из них известны id, автор и время (из id), текст берётся из подписи обложки.
  function domPosts(author) {
    const map = new Map();
    for (const a of document.querySelectorAll('a[href*="/video/"]')) {
      const m = (a.getAttribute("href") || "").match(/\/@([^/]+)\/video\/(\d{10,})/);
      if (!m || (author && m[1].toLowerCase() !== author.toLowerCase())) continue;
      const img = a.querySelector("img[alt]");
      const post = X.itemToPost({ id: m[2], desc: img ? img.alt : "", author: { uniqueId: m[1] } }, author);
      if (post && post.time) map.set(post.post_id, post);
    }
    return map;
  }

  // Что видит вкладка, когда постов нет: по этому в статусе сервера понятно, лента не загрузилась
  // (вкладка скрыта, нет сети) или страница другая (вход, ошибка, пустой профиль).
  function diagnose() {
    try {
      const text = ((document.body && document.body.innerText) || "").replace(/\s+/g, " ").trim().slice(0, 90);
      const links = document.querySelectorAll('a[href*="/video/"]').length;
      return `вкладка ${document.visibilityState}, ${document.readyState}, видео в сетке ${links}, `
        + `заголовок «${(document.title || "").slice(0, 50)}», текст «${text}»`;
    } catch (_) { return ""; }
  }

  window.__ttBridge = {
    collect() {
      const author = currentUser();
      const data = rehydration();
      const profile = (data && X.profileIn(data)) || null;
      const state = pageState();
      let target = state;
      let via = "item_list";
      let list = Array.from(posts.values());
      if (state === "ok") {
        const text = (document.body && document.body.innerText) || "";
        if ((profile && (profile.statusCode === 10221 || profile.statusCode === 10202)) || NOT_FOUND_TEXT.test(text)) {
          target = "unavailable";
        } else if (!list.length && ((profile && profile.private) || PRIVATE_TEXT.test(text))) {
          target = "unavailable";
        } else if (!list.length) {
          list = Array.from(domPosts(author).values());
          via = list.length ? "dom" : "none";
        }
      }
      return {
        state, target, via, url: location.href, posts: list,
        followers: profile ? profile.followers : null,
        account: data ? X.loggedInUser(data) : "",
        lists: seen.lists,
        diag: list.length ? "" : diagnose(),
      };
    },
    reset() { posts.clear(); seen.lists = 0; },
  };
})();
