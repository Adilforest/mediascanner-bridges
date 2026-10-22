// FB Bridge: цикл сбора целевых страниц и групп Facebook для MediaScanner.
//
// Раз в минуту (alarm) расширение спрашивает у бэкенда следующий источник
// (POST /api/internal/facebook-bridge/next/), открывает его в закреплённой
// вкладке facebook.com, дозагружает ленту тем же запросом, что сайт при
// прокрутке, забирает посты (content/capture.js) и отправляет их
// (POST .../result/). Паузу до следующего источника задаёт сервер. Куки и
// токены Facebook никуда не уходят: на сервер идут только посты и id аккаунта
// (c_user) для журнала.

const DEFAULTS = { server: "https://app.mediascanner.kz", token: "", label: "fb-pc-1", fbAccount: "" };
const VERSION = chrome.runtime.getManifest().version;
const HOME = "https://www.facebook.com/";
const BUSY_TIMEOUT_MS = 5 * 60 * 1000;
const PAGES = 3;

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
  login: "Вход в Facebook потерян: войдите в этом профиле Chrome",
  checkpoint: "Facebook просит проверку или временно ограничил аккаунт: откройте facebook.com",
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
    await chrome.action.setTitle({ title: state === "ok" ? "FB Bridge: работает" : `FB Bridge: ${MESSAGES[state] || state}` });
  } catch (_) { /* ignore */ }
  if (state !== prev && ["login", "checkpoint", "bad_token"].includes(state)) {
    try {
      await chrome.notifications.create(`fb-bridge-${state}`, {
        type: "basic", iconUrl: "icons/icon128.png", title: "FB Bridge", message: MESSAGES[state],
        requireInteraction: true, priority: 2,
      });
    } catch (_) { /* ignore */ }
  }
}

async function accountId() {
  const c = await chrome.cookies.get({ url: HOME, name: "c_user" });
  return c ? c.value : "";
}

async function api(path, body) {
  const s = await settings();
  const resp = await fetch(s.server.replace(/\/+$/, "") + "/api/internal/facebook-bridge/" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-FB-Bridge-Token": s.token },
    body: JSON.stringify(Object.assign({ label: s.label, version: VERSION, account_name: s.fbAccount }, body)),
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

// Закреплённая вкладка facebook.com: открывается и закрепляется сама, если её нет.
async function ensureTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.facebook.com/*" });
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

// Открыть источник, дозагрузить ленту, забрать посты.
//
// Вкладка остаётся фоновой: прокрутка в скрытой вкладке ленту не подгружает,
// поэтому следующие порции запрашивает content/capture.js (paginate) тем же
// запросом, что сайт. Останавливается на постах старше двух суток.
async function collect(url) {
  const tab = await ensureTab();
  await chrome.tabs.update(tab.id, { url });
  try {
    await waitComplete(tab.id, 45000);
    await wait(5000 + Math.random() * 3000);
    const stopBefore = Math.floor(Date.now() / 1000) - 2 * 24 * 3600;
    let more = null;
    try {
      more = await runInTab(tab.id, (n, before) => (window.__fbBridge ? window.__fbBridge.paginate(n, before) : null),
        [PAGES, stopBefore]);
    } catch (e) {
      more = { pages: 0, reason: String(e.message || e).slice(0, 100) };
    }
    const res = await runInTab(tab.id, () => (window.__fbBridge ? window.__fbBridge.collect() : null));
    if (!res) return { state: "ok", target: "error", posts: [], url };
    res.more = more;
    return res;
  } finally {
    // вкладку возвращаем на ленту: страница группы не висит открытой
    chrome.tabs.update(tab.id, { url: HOME }).catch(() => {});
  }
}

async function tick(force = false) {
  const s = await settings();
  if (!s.token) return setState("not_configured");
  const local = await chrome.storage.local.get(["busyAt", "nextAt"]);
  if (local.busyAt && Date.now() - local.busyAt < BUSY_TIMEOUT_MS) return;
  if (!force && local.nextAt && Date.now() < local.nextAt) return;
  await chrome.storage.local.set({ busyAt: Date.now() });
  try {
    const account = await accountId();
    const loginState = account ? "ok" : "login";
    const next = await api("next/", { account, state: loginState });
    if (loginState !== "ok") {
      await setState("login");
    } else if (next.target) {
      const res = await collect(next.target.url);
      const status = res.state !== "ok" ? res.state : res.target;
      const posts = status === "ok" ? res.posts : [];
      const more = res.more ? `дозагрузка: ${res.more.pages}, ${res.more.reason}` : "";
      const saved = await api("result/", { account, state: res.state, target_id: next.target.id, status, posts,
        detail: (status === "ok" ? more : `${(res.url || "").slice(0, 250)} ${more}`).slice(0, 500) });
      await setState(res.state === "ok" ? "ok" : res.state, {
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

// Проверка из настроек: сервер принимает токен, вход в Facebook есть.
// Источник при этом не берётся (state=check), посты не собираются.
async function selfTest() {
  const out = { server: "offline", facebook: "login", account: "", detail: "" };
  const s = await settings();
  if (!s.token) out.server = "not_configured";
  else {
    try {
      await api("next/", { account: await accountId(), state: "check" });
      out.server = "ok";
    } catch (e) {
      out.server = e.code === "bad_token" ? "bad_token" : "offline";
      out.detail = String(e.message || e).slice(0, 200);
    }
  }
  out.account = await accountId();
  try {
    const tab = await ensureTab();
    const res = await runInTab(tab.id, () => (window.__fbBridge ? window.__fbBridge.collect() : null));
    out.facebook = !out.account ? "login" : ((res && res.state) || "ok");
  } catch (e) {
    out.facebook = "no_tab";
    out.detail = String(e.message || e).slice(0, 200);
  }
  if (out.server === "ok" && out.facebook === "ok") await setState("ok");
  else if (["login", "checkpoint"].includes(out.facebook)) await setState(out.facebook);
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

// Для диагностики из DevTools service worker: await fbBridge.collect(url), await fbBridge.selfTest()
self.fbBridge = { collect, selfTest };
