// TikTok Bridge: цикл сбора целевых аккаунтов TikTok для MediaScanner.
//
// Раз в минуту (alarm) расширение спрашивает у бэкенда следующий аккаунт
// (POST /api/internal/tiktok-bridge/next/), открывает его в закреплённой вкладке tiktok.com,
// ждёт, пока страница сама получит ленту (content/capture.js), и отправляет посты
// (POST .../result/). Паузу до следующего аккаунта задаёт сервер. Куки и токены TikTok
// никуда не уходят: на сервер идут только посты и ник аккаунта, под которым выполнен вход.

const DEFAULTS = { server: "https://app.mediascanner.kz", token: "", label: "tt-pc-1", ttAccount: "" };
const VERSION = chrome.runtime.getManifest().version;
const HOME = "https://www.tiktok.com/";
const BUSY_TIMEOUT_MS = 5 * 60 * 1000;
const FEED_WAIT_MS = 30000;

const BADGES = {
  ok: ["", "#2e7d32"],
  not_configured: ["SET", "#9e9e9e"],
  login: ["IN", "#c62828"],
  checkpoint: ["!", "#c62828"],
  bad_token: ["KEY", "#c62828"],
  offline: ["ERR", "#ef6c00"],
};
const MESSAGES = {
  not_configured: "Откройте настройки расширения и укажите токен",
  login: "Вход в TikTok потерян: войдите в этом профиле Chrome",
  checkpoint: "TikTok просит проверку (капча): откройте tiktok.com и пройдите её",
  bad_token: "Неверный токен в настройках расширения",
  offline: "Нет связи с сервером MediaScanner",
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function settings() {
  return Object.assign({}, DEFAULTS, await chrome.storage.local.get(Object.keys(DEFAULTS)));
}

async function setState(state, extra = {}) {
  const prev = (await chrome.storage.local.get("state")).state;
  await chrome.storage.local.set(Object.assign({ state, stateAt: Date.now() }, extra));
  const [text, color] = BADGES[state] || BADGES.offline;
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setTitle({ title: state === "ok" ? "TikTok Bridge: работает" : `TikTok Bridge: ${MESSAGES[state] || state}` });
  } catch (_) { /* ignore */ }
  if (state !== prev && ["login", "checkpoint", "bad_token"].includes(state)) {
    try {
      await chrome.notifications.create(`tt-bridge-${state}`, {
        type: "basic", iconUrl: "icons/icon128.png", title: "TikTok Bridge", message: MESSAGES[state],
        requireInteraction: true, priority: 2,
      });
    } catch (_) { /* ignore */ }
  }
}

// Вход выполнен, если у TikTok есть сессионная кука. Значение никуда не отправляется.
async function loggedIn() {
  for (const name of ["sessionid", "sessionid_ss", "sid_tt"]) {
    const c = await chrome.cookies.get({ url: HOME, name });
    if (c && c.value) return true;
  }
  return false;
}

async function api(path, body) {
  const s = await settings();
  const resp = await fetch(s.server.replace(/\/+$/, "") + "/api/internal/tiktok-bridge/" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-TT-Bridge-Token": s.token },
    body: JSON.stringify(Object.assign({ label: s.label, version: VERSION }, body)),
  });
  if (resp.status === 401 || resp.status === 403) throw Object.assign(new Error("bad token"), { code: "bad_token" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function waitComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, timeoutMs);
  });
}

// Закреплённая вкладка tiktok.com: открывается и закрепляется сама, если её нет.
async function ensureTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.tiktok.com/*" });
  let tab = tabs.find((t) => t.pinned) || tabs[0];
  if (!tab) {
    tab = await chrome.tabs.create({ url: HOME, pinned: true, active: false });
    await waitComplete(tab.id, 45000);
  } else {
    if (!tab.pinned) await chrome.tabs.update(tab.id, { pinned: true });
    if (tab.status !== "complete") await waitComplete(tab.id, 30000);
  }
  return chrome.tabs.get(tab.id);
}

async function runInTab(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func, args });
  return res ? res.result : null;
}

// Скрытая вкладка (окно свёрнуто или закрыто другими) не отрисовывает страницу профиля, и TikTok не
// подгружает ленту. На время сбора вкладку делаем активной, окно разворачиваем и поднимаем.
async function showTab(tab) {
  const shown = { windowId: tab.windowId, minimized: false, note: "" };
  try {
    const win = await chrome.windows.get(tab.windowId);
    shown.minimized = win.state === "minimized";
    if (shown.minimized) await chrome.windows.update(win.id, { state: "normal" });
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(win.id, { focused: true });
    const after = await chrome.windows.get(win.id);
    const now = await chrome.tabs.get(tab.id);
    shown.note = `окно было ${win.state}, стало ${after.state}, в фокусе ${after.focused}, вкладка активна ${now.active}`;
  } catch (e) {
    shown.note = `показать вкладку не удалось: ${String((e && e.message) || e).slice(0, 80)}`;
  }
  return shown;
}

// Окно, которое было свёрнуто, сворачиваем обратно.
async function hideTab(shown) {
  if (!shown || !shown.minimized) return;
  try { await chrome.windows.update(shown.windowId, { state: "minimized" }); } catch (_) { /* окна уже нет */ }
}

const collectNow = () => (window.__ttBridge ? window.__ttBridge.collect() : null);

// Открыть аккаунт и дождаться ленты: страница сама запрашивает первые видео при загрузке,
// прокрутка не нужна. Ждём, пока придёт список, появится капча или выйдет время.
async function collect(url) {
  const tab = await ensureTab();
  const shown = await showTab(tab);
  await chrome.tabs.update(tab.id, { url });
  try {
    await waitComplete(tab.id, 45000);
    const started = Date.now();
    let res = null;
    while (Date.now() - started < FEED_WAIT_MS) {
      await wait(2000);
      try { res = await runInTab(tab.id, collectNow); } catch (_) { res = null; }
      if (res && (res.lists > 0 || res.state !== "ok" || res.target !== "ok")) break;
    }
    if (!res) return { state: "ok", target: "error", posts: [], url, via: "none", lists: 0, diag: "скрипт страницы не отвечает" };
    if (res.diag) res.diag += `; ${shown.note}`;
    // после первого списка даём странице секунду на остальные ответы
    if (res.lists > 0 && res.state === "ok") {
      await wait(1500);
      try { res = (await runInTab(tab.id, collectNow)) || res; } catch (_) { /* берём что есть */ }
    }
    return res;
  } finally {
    // вкладку возвращаем на главную: страница аккаунта не висит открытой
    chrome.tabs.update(tab.id, { url: HOME }).catch(() => {});
    await hideTab(shown);
  }
}

function resultStatus(res) {
  if (res.state !== "ok") return res.state;               // checkpoint
  if (res.target === "unavailable") return "unavailable";
  if (!res.posts.length) return "error";                  // лента не пришла: это поломка, а не «пусто»
  return "ok";
}

async function tick(force = false) {
  const s = await settings();
  if (!s.token) return setState("not_configured");
  const local = await chrome.storage.local.get(["busyAt", "nextAt"]);
  if (local.busyAt && Date.now() - local.busyAt < BUSY_TIMEOUT_MS) return;
  if (!force && local.nextAt && Date.now() < local.nextAt) return;
  await chrome.storage.local.set({ busyAt: Date.now() });
  try {
    const isIn = await loggedIn();
    const known = (await chrome.storage.local.get("ttAccountSeen")).ttAccountSeen || s.ttAccount || "";
    const next = await api("next/", { account: known, state: isIn ? "ok" : "login" });
    if (!isIn) {
      await setState("login");
    } else if (next.target) {
      const res = await collect(next.target.url);
      const status = resultStatus(res);
      const account = res.account || known;
      if (res.account && res.account !== known) await chrome.storage.local.set({ ttAccountSeen: res.account });
      const posts = status === "ok" ? res.posts : [];
      const detail = status === "ok" ? `через ${res.via}, списков ${res.lists}`
        : `${(res.url || "").slice(0, 120)} через ${res.via}, списков ${res.lists || 0}${res.diag ? `; ${res.diag}` : ""}`;
      const saved = await api("result/", { account, state: res.state, target_id: next.target.id, status, posts,
        followers: res.followers, detail: detail.slice(0, 500) });
      await setState(status === "checkpoint" ? "checkpoint" : "ok", {
        last: { at: Date.now(), url: next.target.url, status, posts: posts.length, created: saved.created || 0 },
      });
      const stats = (await chrome.storage.local.get("stats")).stats || { checks: 0, created: 0 };
      await chrome.storage.local.set({ stats: { checks: stats.checks + 1, created: stats.created + (saved.created || 0) } });
    } else {
      await setState("ok");
    }
    await chrome.storage.local.set({ nextAt: Date.now() + (next.wait_sec || 300) * 1000 });
  } catch (e) {
    await setState(e.code === "bad_token" ? "bad_token" : "offline", { lastError: String(e.message || e).slice(0, 200) });
    await chrome.storage.local.set({ nextAt: Date.now() + 5 * 60 * 1000 });
  } finally {
    await chrome.storage.local.set({ busyAt: 0 });
  }
}

// Проверка из настроек: сервер принимает токен, вход в TikTok есть. Аккаунт при этом не
// берётся (state=check), посты не собираются.
async function selfTest() {
  const out = { server: "offline", tiktok: "login", account: "", detail: "" };
  const s = await settings();
  if (!s.token) out.server = "not_configured";
  else {
    try {
      await api("next/", { account: s.ttAccount, state: "check" });
      out.server = "ok";
    } catch (e) {
      out.server = e.code === "bad_token" ? "bad_token" : "offline";
      out.detail = String(e.message || e).slice(0, 200);
    }
  }
  const isIn = await loggedIn();
  out.tiktok = isIn ? "ok" : "login";
  if (isIn) {
    try {
      const tab = await ensureTab();
      const res = await runInTab(tab.id, collectNow);
      out.account = (res && res.account) || "";
      out.tiktok = (res && res.state) || "ok";
      if (out.account) await chrome.storage.local.set({ ttAccountSeen: out.account });
    } catch (e) {
      out.tiktok = "no_tab";
      out.detail = String(e.message || e).slice(0, 200);
    }
  }
  if (out.server === "ok" && out.tiktok === "ok") await setState("ok");
  else if (["login", "checkpoint"].includes(out.tiktok)) await setState(out.tiktok);
  else if (out.server !== "ok") await setState(out.server);
  return out;
}

async function init() {
  await chrome.alarms.create("tick", { periodInMinutes: 1 });
  try { await ensureTab(); } catch (_) { /* окно ещё не готово: вкладку откроет первая проверка */ }
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "tick") tick(); });
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || typeof msg !== "object") return false;
  if (msg.type === "run_now") {
    tick(true).then(async () => reply(await chrome.storage.local.get(["state", "last", "lastError"])));
    return true;
  }
  if (msg.type === "test") {
    selfTest().then(reply);
    return true;
  }
  return false;
});

// Для диагностики из DevTools service worker: await ttBridge.collect(url), await ttBridge.selfTest()
self.ttBridge = { collect, selfTest, resultStatus };
