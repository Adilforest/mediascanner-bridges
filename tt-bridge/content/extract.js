// TikTok Bridge: разбор постов из данных, которые страница TikTok получает сама.
//
// Видео аккаунта приходят в ответе /api/post/item_list/ (itemList[]): id, desc, createTime,
// author, stats {playCount, diggCount, commentCount, shareCount}. Профиль (подписчики, код
// ответа «аккаунт не найден») лежит в <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">.
//
// Обычный скрипт без модулей: грузится в MAIN world перед capture.js и в тестах через vm.

(function (root) {
  "use strict";

  const count = (v) => (typeof v === "number" && v >= 0 ? v : (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null));

  // Время публикации из id видео: старшие 32 бита это секунды unix.
  function timeFromId(id) {
    try { return Number(BigInt(id) >> 32n); } catch (_) { return 0; }
  }

  function authorName(item, fallback) {
    const a = item.author;
    if (a && typeof a === "object") return a.uniqueId || a.unique_id || fallback || "";
    if (typeof a === "string" && a) return a;
    return (item.authorInfo && item.authorInfo.uniqueId) || fallback || "";
  }

  function itemToPost(item, fallbackAuthor) {
    if (!item || typeof item !== "object") return null;
    const id = String(item.id || item.itemId || "");
    if (!/^\d{10,}$/.test(id)) return null;
    const author = authorName(item, fallbackAuthor);
    if (!author) return null;
    const created = count(item.createTime);
    const stats = item.stats || item.statsV2 || {};
    return {
      post_id: id,
      url: `https://www.tiktok.com/@${author}/video/${id}`,
      text: String(item.desc || "").trim(),
      time: created || timeFromId(id),
      author: `@${author}`,
      views: count(stats.playCount),
      likes: count(stats.diggCount),
      comments: count(stats.commentCount),
      shares: count(stats.shareCount),
    };
  }

  // Ответ /api/post/item_list/ (объект или текст JSON): добавляет посты в map по id.
  function postsIn(data, map, fallbackAuthor) {
    let json = data;
    if (typeof data === "string") {
      try { json = JSON.parse(data); } catch (_) { return map; }
    }
    if (!json || typeof json !== "object") return map;
    const list = Array.isArray(json.itemList) ? json.itemList : [];
    for (const item of list) {
      const post = itemToPost(item, fallbackAuthor);
      if (post && post.time) map.set(post.post_id, post);
    }
    return map;
  }

  // Профиль из данных страницы: {username, followers, statusCode}.
  function profileIn(data) {
    let json = data;
    if (typeof data === "string") {
      try { json = JSON.parse(data); } catch (_) { return null; }
    }
    const scope = json && json.__DEFAULT_SCOPE__;
    const detail = scope && scope["webapp.user-detail"];
    if (!detail) return null;
    const info = detail.userInfo || {};
    const user = info.user || {};
    const stats = info.stats || {};
    return {
      username: user.uniqueId || "",
      followers: count(stats.followerCount),
      statusCode: typeof detail.statusCode === "number" ? detail.statusCode : 0,
      private: Boolean(user.privateAccount),
    };
  }

  // Аккаунт, под которым выполнен вход: webapp.app-context.user.
  function loggedInUser(data) {
    let json = data;
    if (typeof data === "string") {
      try { json = JSON.parse(data); } catch (_) { return ""; }
    }
    const scope = json && json.__DEFAULT_SCOPE__;
    const ctx = scope && scope["webapp.app-context"];
    const user = ctx && ctx.user;
    return (user && (user.uniqueId || user.nickName || "")) || "";
  }

  root.TTBridgeExtract = { timeFromId, itemToPost, postsIn, profileIn, loggedInUser };
})(typeof window !== "undefined" ? window : globalThis);
