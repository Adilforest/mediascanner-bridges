// FB Bridge: разбор постов из данных, которые страница Facebook получает сама.
//
// Посты ленты страницы или группы приходят в ответах /api/graphql/
// (ProfileCometTimelineFeedRefetchQuery, GroupsCometFeedRegularStoriesPaginationQuery)
// и в <script type="application/json"> первой загрузки. Пост ленты это объект
// Story в edges[].node или строка потока с path [..., "edges", N] и data.node.
// Вложенная история (репост) лежит в attached_story и отдельным постом не считается.
//
// Обычный скрипт без модулей: грузится в MAIN world перед capture.js и в тестах
// через vm. Проверено на живых страницах 12.10.2026.

(function (root) {
  "use strict";

  const SKIP = new Set(["attached_story", "attached_story_layout"]);

  function first(obj, pred, intoAttached) {
    // обход в ширину: ближайшее к корню значение; вложенные истории (репост)
    // пропускаются, если не intoAttached
    const queue = [obj];
    let steps = 0;
    while (queue.length && steps < 200000) {
      const cur = queue.shift();
      steps += 1;
      if (cur === null || typeof cur !== "object") continue;
      if (Array.isArray(cur)) {
        for (const v of cur) queue.push(v);
        continue;
      }
      const hit = pred(cur);
      if (hit !== undefined) return hit;
      for (const k of Object.keys(cur)) {
        if (intoAttached || !SKIP.has(k)) queue.push(cur[k]);
      }
    }
    return undefined;
  }

  const num = (v) => (typeof v === "number" && v >= 0 ? v : undefined);

  function storyToPost(node) {
    if (!node || node.__typename !== "Story" || !node.post_id) return null;
    const context = (node.comet_sections && node.comet_sections.context_layout) || node;
    const time = first(context, (o) => num(o.creation_time)) ?? first(node, (o) => num(o.creation_time));
    if (!time) return null;
    let url = typeof node.permalink_url === "string" ? node.permalink_url : undefined;
    url = url || first(context, (o) => (typeof o.permalink_url === "string" ? o.permalink_url : undefined))
      || first(node, (o) => (typeof o.permalink_url === "string" ? o.permalink_url : undefined))
      || first(node, (o) => (typeof o.url === "string" && /^https:\/\/www\.facebook\.com\//.test(o.url) ? o.url : undefined));
    if (!url) return null;
    const actor = Array.isArray(node.actors) && node.actors[0]
      ? node.actors[0]
      : first(node, (o) => (Array.isArray(o.actors) && o.actors[0] && o.actors[0].name ? o.actors[0] : undefined));
    const textOf = (o) => (o.message && typeof o.message.text === "string" && o.message.text ? o.message.text : undefined);
    // свой текст поста, у репоста без своего текста текст исходной публикации
    // (лежит в attached_story, иногда на несколько уровней глубже)
    // у ссылки без подписи текст это заголовок ссылки; у одного фото текста нет
    const titleOf = (o) => (o.title_with_entities && typeof o.title_with_entities.text === "string"
      && o.title_with_entities.text ? o.title_with_entities.text : undefined);
    const message = textOf(node) || first(node, textOf) || first(node, textOf, true) || first(node, titleOf, true);
    return {
      post_id: String(node.post_id),
      url,
      time,
      author: (actor && actor.name) || "",
      text: message || "",
      reactions: first(node, (o) => (o.reaction_count && num(o.reaction_count.count) !== undefined ? o.reaction_count.count : undefined)) ?? null,
      comments: first(node, (o) => (o.comment_rendering_instance && o.comment_rendering_instance.comments
        && num(o.comment_rendering_instance.comments.total_count) !== undefined
        ? o.comment_rendering_instance.comments.total_count : undefined)) ?? null,
      shares: first(node, (o) => (o.share_count && num(o.share_count.count) !== undefined ? o.share_count.count : undefined)) ?? null,
    };
  }

  // Все посты ленты в одном разобранном JSON (ответ graphql или script первой загрузки).
  function storiesIn(blob, out) {
    const stack = [blob];
    let steps = 0;
    while (stack.length && steps < 500000) {
      const cur = stack.pop();
      steps += 1;
      if (cur === null || typeof cur !== "object") continue;
      if (Array.isArray(cur)) {
        for (const v of cur) stack.push(v);
        continue;
      }
      // строка потока: следующий пост ленты отдельным куском (и в script первой загрузки)
      if (Array.isArray(cur.path) && cur.path.includes("edges") && cur.data && cur.data.node) {
        const p = storyToPost(cur.data.node);
        if (p && !out.has(p.post_id)) out.set(p.post_id, p);
      }
      if (Array.isArray(cur.edges)) {
        for (const e of cur.edges) {
          const p = e && storyToPost(e.node);
          if (p && !out.has(p.post_id)) out.set(p.post_id, p);
        }
      }
      for (const k of Object.keys(cur)) {
        if (!SKIP.has(k)) stack.push(cur[k]);
      }
    }
    return out;
  }

  // Текст ответа graphql: несколько JSON подряд по строкам, иногда с префиксом for (;;);
  function parseLines(text) {
    const out = [];
    for (let line of String(text || "").split("\n")) {
      line = line.trim();
      if (line.startsWith("for (;;);")) line = line.slice(9);
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch (_) { /* не JSON */ }
    }
    return out;
  }

  root.FBBridgeExtract = { storyToPost, storiesIn, parseLines };
})(typeof window !== "undefined" ? window : globalThis);
