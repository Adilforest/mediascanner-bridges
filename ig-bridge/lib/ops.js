// IG Bridge: белый список операций (план Instagram v2, 01, п. 3; 02).
//
// Сервер может попросить только операцию из OPS. Для каждой: проверка
// аргументов, построение запроса, ужимание ответа в формат 01. Всё, кроме
// GET, разрешённого POST на graphql/query (только имена из GRAPHQL_NAMES и
// только с doc_id, захваченным со страницы) и POST tags/{tag}/sections/,
// отклоняется как not_allowed. Эндпоинты подтверждены spike 06.10.2026.

export const DEFAULT_APP_ID = "936619743392459";
export const DEFAULT_ASBD_ID = "359341";
export const GRAPHQL_NAMES = ["PolarisProfilePostsQuery"];

// Форма variables, снятая со страницы 06.10.2026. Если страница пришлёт
// другую (ключи __relay_internal__ меняются вместе с doc_id), берётся
// захваченная.
const PROFILE_POSTS_VARS = {
  data: {
    count: 12, include_reel_media_seen_timestamp: true, include_relationship_info: true,
    latest_besties_reel_media: true, latest_reel_media: true,
  },
  username: "",
  __relay_internal__pv__PolarisMultiCaptionCarouselEnabledrelayprovider: true,
  __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
  __relay_internal__pv__PolarisReelsRecoDebugOverlayEnabledrelayprovider: false,
};

const USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;
const DIGITS_RE = /^\d{1,25}$/;
const CURSOR_RE = /^[A-Za-z0-9_\-=.:|%]{1,2000}$/;
const QUERY_MAX = 100;

export class NotAllowed extends Error {}

function needUsername(v) {
  const s = String(v || "").trim().replace(/^@/, "");
  if (!USERNAME_RE.test(s)) throw new NotAllowed("плохой username");
  return s.toLowerCase();
}
function needDigits(v, what) {
  const s = String(v ?? "");
  if (!DIGITS_RE.test(s)) throw new NotAllowed(`плохой ${what}`);
  return s;
}
function optCursor(v) {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v);
  if (!CURSOR_RE.test(s)) throw new NotAllowed("плохой курсор");
  return s;
}
function needQuery(v) {
  const s = String(v || "").trim();
  if (!s || s.length > QUERY_MAX || /[\u0000-\u001f]/.test(s)) throw new NotAllowed("плохой запрос");
  return s;
}
function needTag(v) {
  const s = String(v || "").trim().replace(/^#/, "").toLowerCase();
  if (!/^[\p{L}\p{N}_]{1,100}$/u.test(s)) throw new NotAllowed("плохой хэштег");
  return s;
}

// --- построение запросов ---------------------------------------------------

export function buildRequest(op, args, pageConfig) {
  args = args && typeof args === "object" ? args : {};
  switch (op) {
    case "topsearch":
    case "verify": {
      const q = op === "verify" ? "instagram" : needQuery(args.query);
      return { method: "GET", path: `/web/search/topsearch/?query=${encodeURIComponent(q)}&context=blended` };
    }
    case "profile_posts": {
      const username = needUsername(args.username);
      const docId = pageConfig && pageConfig.doc_id && pageConfig.doc_id.PolarisProfilePostsQuery;
      if (!docId || !DIGITS_RE.test(docId)) {
        const e = new Error("no doc_id");
        e.outcome = "parse_error";
        throw e;
      }
      const template = (pageConfig.templates && pageConfig.templates.PolarisProfilePostsQuery) || PROFILE_POSTS_VARS;
      const vars = JSON.parse(JSON.stringify(template));
      vars.username = username;
      vars.data = Object.assign({}, vars.data || {}, { count: Math.min(Math.max(parseInt(args.count, 10) || 12, 1), 12) });
      const after = optCursor(args.after);
      if (after) vars.after = after; else delete vars.after;
      return { method: "POST", path: "/graphql/query", graphql: { name: "PolarisProfilePostsQuery", docId, variables: vars } };
    }
    case "comments": {
      const pk = needDigits(args.media_pk, "media_pk");
      const minId = optCursor(args.min_id);
      let path = `/api/v1/media/${pk}/comments/?can_support_threading=true&permalink_enabled=false`;
      if (minId) path += `&min_id=${encodeURIComponent(minId)}`;
      return { method: "GET", path };
    }
    case "media_info":
      return { method: "GET", path: `/api/v1/media/${needDigits(args.media_pk, "media_pk")}/info/` };
    case "tag_recent": {
      const tag = needTag(args.tag);
      const form = { include_persistent: "0", surface: "grid", tab: "recent" };
      const maxId = optCursor(args.max_id);
      if (maxId) form.max_id = maxId;
      if (args.page !== undefined && args.page !== null) form.page = needDigits(args.page, "page");
      if (Array.isArray(args.next_media_ids)) {
        form.next_media_ids = JSON.stringify(args.next_media_ids.map(String).filter((x) => DIGITS_RE.test(x)).slice(0, 50));
      }
      return { method: "POST", path: `/api/v1/tags/${encodeURIComponent(tag)}/sections/`, form };
    }
    case "top_serp": {
      const q = needQuery(args.query);
      let path = `/api/v1/fbsearch/web/top_serp/?enable_metadata=true&query=${encodeURIComponent(q)}`;
      const maxId = optCursor(args.next_max_id);
      if (maxId) path += `&next_max_id=${encodeURIComponent(maxId)}`;
      const rank = optCursor(args.rank_token);
      if (rank) path += `&rank_token=${encodeURIComponent(rank)}`;
      return { method: "GET", path };
    }
    default:
      throw new NotAllowed(`операция ${op} не разрешена`);
  }
}

// --- выполнение внутри вкладки (функция сериализуется в executeScript) ----

export async function pageFetch(spec) {
  const csrf = (document.cookie.match(/(?:^|; )csrftoken=([^;]+)/) || [])[1] || "";
  const headers = {
    "x-ig-app-id": spec.appId,
    "x-asbd-id": spec.asbdId,
    "x-csrftoken": csrf,
    "x-requested-with": "XMLHttpRequest",
    "x-ig-www-claim": sessionStorage.getItem("www-claim-v2") || "0",
    accept: "*/*",
  };
  let body;
  if (spec.graphql) {
    let dtsg = null, lsd = null;
    try { dtsg = window.require("DTSGInitialData").token; lsd = window.require("LSD").token; } catch (_) {}
    if (!dtsg || !lsd) {
      const h = document.documentElement.innerHTML;
      dtsg = dtsg || (h.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/) || [])[1] || "";
      lsd = lsd || (h.match(/"LSD",\[\],\{"token":"([^"]+)"/) || [])[1] || "";
    }
    let j = 0;
    for (const ch of dtsg) j += ch.charCodeAt(0);
    body = new URLSearchParams({
      __d: "www", __user: "0", __a: "1", __comet_req: "7",
      fb_dtsg: dtsg, jazoest: "2" + j, lsd,
      fb_api_caller_class: "RelayModern", fb_api_req_friendly_name: spec.graphql.name,
      server_timestamps: "true", variables: JSON.stringify(spec.graphql.variables), doc_id: spec.graphql.docId,
    }).toString();
    headers["content-type"] = "application/x-www-form-urlencoded";
    headers["x-fb-friendly-name"] = spec.graphql.name;
    headers["x-fb-lsd"] = lsd;
  } else if (spec.form) {
    body = new URLSearchParams(spec.form).toString();
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), spec.timeoutMs || 30000);
  try {
    const r = await fetch(spec.path, { method: spec.method, credentials: "include", headers, body, signal: ctrl.signal });
    const text = await r.text();
    return { status: r.status, contentType: r.headers.get("content-type") || "", text, finalUrl: r.url, pageUrl: location.href };
  } catch (e) {
    return { status: 0, contentType: "", text: "", error: String(e && e.message || e), finalUrl: "", pageUrl: location.href };
  } finally {
    clearTimeout(timer);
  }
}

// --- ужимание ответа ---------------------------------------------------------

function stripBroken(text) {
  // Подписи длиннее ~2200 байт Instagram хранит обрезанными посреди символа:
  // хвостовой � — это не текст.
  return String(text || "").replace(/�+$/u, "");
}

function bestImage(m) {
  const c = m && m.image_versions2 && m.image_versions2.candidates;
  return Array.isArray(c) && c.length ? c[0] : null;
}

function slide(m) {
  const img = bestImage(m);
  const vid = Array.isArray(m.video_versions) && m.video_versions.length ? m.video_versions[0] : null;
  if (vid) return { type: "video", url: vid.url, width: vid.width || null, height: vid.height || null, poster: img ? img.url : null };
  if (img) return { type: "image", url: img.url, width: img.width || null, height: img.height || null };
  return null;
}

export function projectMedia(m) {
  if (!m || typeof m !== "object" || !m.code) return null;
  const user = m.user || m.owner || {};
  const slides = Array.isArray(m.carousel_media) && m.carousel_media.length ? m.carousel_media : [m];
  const loc = m.location;
  return {
    pk: String(m.pk || (m.id ? String(m.id).split("_")[0] : "")),
    code: m.code,
    taken_at: m.taken_at || null,
    user: { pk: user.pk ? String(user.pk) : (user.id ? String(user.id) : null), username: user.username || null,
            full_name: user.full_name || null, is_verified: !!user.is_verified },
    coauthors: (m.coauthor_producers || []).map((u) => u && u.username).filter(Boolean),
    caption: stripBroken(m.caption && m.caption.text),
    caption_is_edited: !!m.caption_is_edited,
    like_count: typeof m.like_count === "number" ? m.like_count : null,
    comment_count: typeof m.comment_count === "number" ? m.comment_count : null,
    play_count: m.play_count ?? m.ig_play_count ?? null,
    view_count: m.view_count ?? null,
    media_type: m.media_type || null,
    product_type: m.product_type || null,
    is_pinned: Array.isArray(m.timeline_pinned_user_ids) && m.timeline_pinned_user_ids.length > 0,
    is_paid_partnership: !!m.is_paid_partnership,
    media: slides.map(slide).filter(Boolean),
    location: loc ? { pk: loc.pk || null, name: loc.name || null, lat: loc.lat ?? null, lng: loc.lng ?? null } : null,
    usertags: ((m.usertags && m.usertags.in) || []).map((t) => t && t.user && t.user.username).filter(Boolean),
  };
}

function collectMedia(node, acc, depth = 0) {
  // Посты в поисковых ответах ищем по признакам полей, а не по пути: Instagram
  // перекладывает JSON чаще, чем меняет имена полей.
  if (!node || typeof node !== "object" || depth > 40) return acc;
  if (Array.isArray(node)) { for (const x of node) collectMedia(x, acc, depth + 1); return acc; }
  if (typeof node.code === "string" && typeof node.taken_at === "number" && (node.pk || node.id)) {
    if (!acc.has(node.code)) acc.set(node.code, projectMedia(node));
    return acc;
  }
  for (const k of Object.keys(node)) collectMedia(node[k], acc, depth + 1);
  return acc;
}

function projectComment(c) {
  return {
    pk: c.pk ? String(c.pk) : null,
    text: String(c.text || ""),
    created_at: c.created_at || c.created_at_utc || null,
    user: { username: (c.user && c.user.username) || null, pk: c.user && c.user.pk ? String(c.user.pk) : null },
    like_count: c.comment_like_count ?? c.like_count ?? null,
    child_comment_count: c.child_comment_count ?? 0,
  };
}

export function project(op, json) {
  switch (op) {
    case "verify":
      return { ok: true };
    case "topsearch":
      return {
        users: (json.users || []).map((u) => u.user || u).map((u) => ({
          pk: u.pk ? String(u.pk) : (u.pk_id ? String(u.pk_id) : null), username: u.username,
          full_name: u.full_name || null, is_private: !!u.is_private, is_verified: !!u.is_verified,
        })),
      };
    case "profile_posts": {
      const conn = json.data && json.data.xdt_api__v1__feed__user_timeline_graphql_connection;
      if (!conn) return null;
      return {
        posts: (conn.edges || []).map((e) => projectMedia(e && e.node)).filter(Boolean),
        page_info: { has_next_page: !!(conn.page_info && conn.page_info.has_next_page),
                     end_cursor: (conn.page_info && conn.page_info.end_cursor) || null },
        errors: (json.errors || []).slice(0, 5).map((e) => ({ message: String(e.message || "").slice(0, 120),
                                                             path: (e.path || []).join(".") })),
      };
    }
    case "comments":
      return {
        comments: (json.comments || []).map(projectComment),
        comment_count: json.comment_count ?? null,
        next_min_id: json.next_min_id || null,
        has_more: !!(json.has_more_comments || json.has_more_headload_comments),
      };
    case "media_info":
      return { posts: (json.items || []).map(projectMedia).filter(Boolean) };
    case "tag_recent":
      return {
        posts: [...collectMedia(json.sections || json, new Map()).values()].filter(Boolean),
        next_max_id: json.next_max_id || null,
        next_page: json.next_page ?? null,
        next_media_ids: Array.isArray(json.next_media_ids) ? json.next_media_ids.map(String).slice(0, 50) : [],
        more_available: !!json.more_available,
      };
    case "top_serp": {
      const grid = json.media_grid || {};
      return {
        posts: [...collectMedia(grid.sections || json, new Map()).values()].filter(Boolean),
        next_max_id: grid.next_max_id || json.next_max_id || null,
        rank_token: json.rank_token || grid.rank_token || null,
        has_more: !!(grid.has_more ?? json.has_more),
      };
    }
    default:
      return null;
  }
}

// --- классификация ответа ----------------------------------------------------

export function classify(resp) {
  // Возвращает outcome (01, п. 3) и разобранный JSON, если он есть.
  const urls = `${resp.finalUrl || ""} ${resp.pageUrl || ""}`;
  if (/\/challenge\//.test(urls)) return { outcome: "checkpoint", json: null };
  if (/\/accounts\/login/.test(urls)) return { outcome: "login_wall", json: null };
  if (resp.status === 0) return { outcome: "network_error", json: null };
  let json = null;
  try { json = JSON.parse(String(resp.text || "").replace(/^for \(;;\);/, "")); } catch (_) {}
  const msg = json ? `${json.message || ""} ${json.error_type || ""}` : "";
  if (resp.status === 429) return { outcome: "rate_limited", json };
  if (/checkpoint_required|challenge_required/.test(msg)) return { outcome: "checkpoint", json };
  if (resp.status === 401 || /login_required/.test(msg)) return { outcome: "unauthorized", json };
  if (/feedback_required|spam|Please wait a few minutes/i.test(msg)) return { outcome: "soft_block", json };
  if (resp.status === 404) return { outcome: "not_found", json };
  if (!json) return { outcome: /text\/html/.test(resp.contentType || "") ? "login_wall" : "parse_error", json: null };
  if (resp.status >= 400) return { outcome: resp.status === 400 ? "soft_block" : "network_error", json };
  return { outcome: "ok", json };
}
