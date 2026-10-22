// IG Bridge: service worker (план Instagram v2, 02).
//
// Держит WebSocket к шлюзу ig_bridge, выполняет команды сервера во вкладке
// instagram.com строго из белого списка (lib/ops.js) и показывает человеку,
// всё ли в порядке. Куки никуда не отправляются: на сервер уходят только
// признак входа, ds_user_id, sha256 от sessionid и срок сессии.
//
// В консоль пишутся тип сообщения, операция, исход и время. Никогда —
// значения кук, токены страницы и токен шлюза.

import { buildRequest, classify, GRAPHQL_NAMES, DEFAULT_APP_ID, DEFAULT_ASBD_ID, NotAllowed, pageFetch, project } from "./lib/ops.js";
import { ensureTab, findTab, runInTab, tabState, visitBeacon } from "./lib/tab.js";
import { getLocal, getSettings, setLocal, setState } from "./lib/state.js";

const VERSION = chrome.runtime.getManifest().version;
const PING_MS = 20000;
const PONG_TIMEOUT_MS = 60000;
const MIN_GAP_MS = 5000;
const MAX_PER_HOUR = 200;
const RETRY_STEPS_MS = [5000, 10000, 30000, 60000, 120000, 300000];
const STABLE_MS = 10 * 60 * 1000;
const WATCHED_COOKIES = new Set(["sessionid", "ds_user_id", "csrftoken"]);

let ws = null;
let pingTimer = null;
let lastPong = 0;
let openedAt = 0;
let retryStep = 0;
let failCount = 0;
let retryTimer = null;
const queue = [];
let busy = false;
let lastOpAt = 0;
let beaconRunning = false;
let connecting = false;

// --- запуск -----------------------------------------------------------------

async function ensureClientId() {
  const { clientId } = await getLocal("clientId");
  if (!clientId) await setLocal({ clientId: crypto.randomUUID() });
}

async function ensureAlarms() {
  if (!(await chrome.alarms.get("ig-bridge-watch"))) chrome.alarms.create("ig-bridge-watch", { periodInMinutes: 0.5 });
  if (!(await chrome.alarms.get("ig-beacon"))) scheduleBeacon();
}

function scheduleBeacon() {
  const hours = 5 + Math.random() * 2;
  chrome.alarms.create("ig-beacon", { when: Date.now() + hours * 3600 * 1000 });
}

async function init() {
  await ensureClientId();
  await ensureAlarms();
  connect();
  ensureDocId();
}

// Свежая установка: doc_id ленты ещё не снят со страницы, и первая profile_posts
// упала бы с no doc_id (проверка 06.10.2026). Снимаем сразу, не дожидаясь маяка по аларму.
async function ensureDocId() {
  const { pageConfig } = await getLocal("pageConfig");
  if (!(pageConfig && pageConfig.doc_id && pageConfig.doc_id.PolarisProfilePostsQuery)) runBeacon();
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
ensureAlarms().then(connect).then(ensureDocId);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "ig-bridge-watch" || alarm.name === "ig-bridge-retry") connect();
  else if (alarm.name === "ig-state-debounce") sendState();
  else if (alarm.name === "ig-beacon") { scheduleBeacon(); runBeacon(); }
});

chrome.cookies.onChanged.addListener(({ cookie }) => {
  const d = String(cookie.domain || "").replace(/^\./, "");
  if ((d === "instagram.com" || d.endsWith(".instagram.com")) && WATCHED_COOKIES.has(cookie.name)) {
    chrome.alarms.create("ig-state-debounce", { when: Date.now() + 30000 });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "capture") { onCapture(msg); return; }
  if (msg.type === "get-state") { getState().then(reply); return true; }
  if (msg.type === "reconnect") { retryStep = 0; disconnect(); connect(); reply({ ok: true }); return; }
  if (msg.type === "test") { selfTest().then(reply); return true; }
});

// --- соединение со шлюзом -------------------------------------------------

async function connect() {
  if (connecting) return;
  connecting = true;
  try { await openSocket(); } finally { connecting = false; }
}

async function openSocket() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    if (ws.readyState === WebSocket.OPEN && lastPong && Date.now() - lastPong > PONG_TIMEOUT_MS) disconnect();
    else return;
  }
  const s = await getSettings();
  if (!s.bridgeUrl || !s.token) { await setState("not_configured", "Укажите адрес шлюза и токен в настройках"); return; }
  const { lastStatus } = await getLocal("lastStatus");
  if (lastStatus === "bad_token") return; // без повторов до смены настроек
  let socket;
  try { socket = new WebSocket(s.bridgeUrl); } catch (e) { onClosed(1006); return; }
  ws = socket;
  socket.onopen = async () => {
    openedAt = Date.now();
    lastPong = Date.now();
    socket.send(JSON.stringify(await buildHello("hello", s)));
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastPong > PONG_TIMEOUT_MS) { socket.close(); return; }
      socket.send('{"type":"ping"}');
      if (openedAt && Date.now() - openedAt > STABLE_MS) retryStep = 0;
    }, PING_MS);
  };
  socket.onmessage = (event) => {
    let msg = null;
    try { msg = JSON.parse(event.data); } catch (_) { return; }
    onServerMessage(msg);
  };
  socket.onclose = (event) => { if (ws === socket) { ws = null; onClosed(event.code); } };
  socket.onerror = () => {};
}

function disconnect() {
  if (ws) { try { ws.close(); } catch (_) {} ws = null; }
  clearInterval(pingTimer);
}

async function onClosed(code) {
  clearInterval(pingTimer);
  if (code === 4401) { await setState("bad_token", "Неверный токен в настройках расширения"); return; }
  failCount += 1;
  if (failCount >= 3) await setState("offline", "Нет связи с сервером MediaScanner");
  const delay = RETRY_STEPS_MS[Math.min(retryStep, RETRY_STEPS_MS.length - 1)];
  retryStep += 1;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, delay);
  if (delay >= 30000) chrome.alarms.create("ig-bridge-retry", { when: Date.now() + delay });
}

async function onServerMessage(msg) {
  console.log("ig-bridge: <-", msg.type, msg.op || msg.status || "");
  if (msg.type === "welcome" || msg.type === "status") {
    failCount = 0;
    const extra = { connectedAt: (await getLocal("connectedAt")).connectedAt || Date.now() };
    if (msg.type === "welcome") { extra.connectedAt = Date.now(); extra.account = msg.account || ""; }
    await setState(msg.status === "rejected" ? "logged_out" : msg.status, msg.message, extra);
  } else if (msg.type === "pong") {
    lastPong = Date.now();
  } else if (msg.type === "error" && msg.code === "bad_token") {
    await setState("bad_token", "Неверный токен в настройках расширения");
  } else if (msg.type === "job") {
    queue.push(msg);
    drain();
  }
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// --- что известно о сессии --------------------------------------------------

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function igInfo(settings) {
  const cookies = await chrome.cookies.getAll({ domain: "instagram.com" });
  const get = (name) => cookies.find((c) => c.name === name);
  const session = get("sessionid");
  const tab = await findTab();
  const info = { logged_in: !!session, tab: tab ? tabState(tab.url) : "none" };
  if (session) {
    info.ds_user_id = (get("ds_user_id") || {}).value || "";
    info.session_hash = await sha256Hex(session.value);
    info.session_expires_at = session.expirationDate ? Math.floor(session.expirationDate) : null;
    if (settings.igUsername) info.username = settings.igUsername;
  }
  return info;
}

async function browserInfo() {
  const out = {
    user_agent: navigator.userAgent,
    languages: navigator.languages || [],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  try {
    const d = navigator.userAgentData;
    if (d) {
      const high = await d.getHighEntropyValues(["fullVersionList", "platformVersion"]);
      out.ua_data = { brands: d.brands, mobile: d.mobile, platform: d.platform,
                      fullVersionList: high.fullVersionList, platformVersion: high.platformVersion };
    }
  } catch (_) {}
  return out;
}

async function pageConfigSummary() {
  const { pageConfig } = await getLocal("pageConfig");
  if (!pageConfig) return null;
  return {
    doc_id: pageConfig.doc_id || {},
    variables: Object.fromEntries(Object.entries(pageConfig.templates || {}).map(([k, v]) => [k, Object.keys(v || {})])),
    app_id: pageConfig.app_id || undefined,
    asbd_id: pageConfig.asbd_id || undefined,
  };
}

async function buildHello(type, settings) {
  settings = settings || (await getSettings());
  const { clientId } = await getLocal("clientId");
  const msg = { type, client_id: clientId, extension_version: VERSION, label: settings.label,
                ig: await igInfo(settings), page_config: await pageConfigSummary() };
  if (type === "hello") { msg.token = settings.token; msg.browser = await browserInfo(); }
  return msg;
}

async function sendState() {
  const msg = await buildHello("state");
  // Выход и проверку человек должен увидеть сразу, даже без связи со шлюзом.
  if (!msg.ig.logged_in || msg.ig.tab === "login") await setState("logged_out", "");
  else if (msg.ig.tab === "challenge") await setState("checkpoint", "");
  if (ws && ws.readyState === WebSocket.OPEN) send(msg);
}

// --- захват doc_id со страницы ----------------------------------------------

async function onCapture(msg) {
  if (!GRAPHQL_NAMES.includes(msg.name) || !/^\d{1,25}$/.test(msg.docId)) return;
  const { pageConfig } = await getLocal("pageConfig");
  const pc = pageConfig || { doc_id: {}, templates: {} };
  let changed = pc.doc_id[msg.name] !== msg.docId;
  pc.doc_id[msg.name] = msg.docId;
  if (msg.variables && typeof msg.variables === "object") {
    const tpl = JSON.parse(JSON.stringify(msg.variables));
    tpl.username = "";
    delete tpl.after;
    delete tpl.before;
    if (JSON.stringify(tpl) !== JSON.stringify(pc.templates[msg.name] || null)) changed = true;
    pc.templates[msg.name] = tpl;
  }
  if (msg.appId && /^\d{1,25}$/.test(msg.appId)) pc.app_id = msg.appId;
  if (msg.asbdId && /^\d{1,25}$/.test(msg.asbdId)) pc.asbd_id = msg.asbdId;
  pc.captured_at = Date.now();
  await setLocal({ pageConfig: pc });
  if (changed) { console.log("ig-bridge: захвачен doc_id", msg.name); sendState(); }
}

async function runBeacon() {
  if (beaconRunning) return;
  beaconRunning = true;
  try {
    const s = await getSettings();
    await visitBeacon(s.beaconProfile);
  } catch (e) {
    console.log("ig-bridge: маяк не удался", String(e && e.message || e));
  } finally {
    beaconRunning = false;
  }
}

// --- выполнение команд ------------------------------------------------------

async function rateAllowed() {
  const now = Date.now();
  const { opsHour, opsDay } = await getLocal(["opsHour", "opsDay"]);
  const hour = Math.floor(now / 3600000);
  const day = new Date(now).toDateString();
  const counter = opsHour && opsHour.hour === hour ? opsHour : { hour, count: 0 };
  if (counter.count >= MAX_PER_HOUR) return false;
  counter.count += 1;
  const daily = opsDay && opsDay.day === day ? opsDay : { day, count: 0 };
  daily.count += 1;
  await setLocal({ opsHour: counter, opsDay: daily });
  return true;
}

async function drain() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      const gap = MIN_GAP_MS - (Date.now() - lastOpAt);
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
      const result = await runJob(job);
      lastOpAt = Date.now();
      send(Object.assign({ type: "result", id: job.id }, result));
      await setLocal({ lastOp: { op: job.op, outcome: result.outcome, at: Date.now() } });
    }
  } finally {
    busy = false;
  }
}

async function runJob(job) {
  const t0 = Date.now();
  const { pageConfig } = await getLocal("pageConfig");
  let spec;
  try {
    spec = buildRequest(job.op, job.args, pageConfig || {});
  } catch (e) {
    if (e instanceof NotAllowed) return { ok: false, outcome: "not_allowed", detail: e.message };
    if (e.outcome === "parse_error") { runBeacon(); return { ok: false, outcome: "parse_error", detail: e.message }; }
    return { ok: false, outcome: "parse_error", detail: String(e.message || e) };
  }
  if (!(await rateAllowed())) return { ok: false, outcome: "busy", detail: "лимит команд в час" };
  if (beaconRunning) return { ok: false, outcome: "busy", detail: "идёт обновление doc_id" };
  let tab;
  try { tab = await ensureTab(); } catch (e) { return { ok: false, outcome: "network_error", detail: "нет вкладки" }; }
  const state = tabState(tab.url);
  if (state !== "ok") {
    sendState();
    return { ok: false, outcome: state === "challenge" ? "checkpoint" : "login_wall", detail: `вкладка: ${state}` };
  }
  spec.appId = (pageConfig && pageConfig.app_id) || DEFAULT_APP_ID;
  spec.asbdId = (pageConfig && pageConfig.asbd_id) || DEFAULT_ASBD_ID;
  spec.timeoutMs = Math.max(5000, Math.min(Number(job.deadline_ms) || 40000, 60000) - 2000);
  let resp;
  try {
    resp = await runInTab(tab.id, pageFetch, [spec]);
  } catch (e) {
    return { ok: false, outcome: "network_error", detail: "вкладка не выполнила запрос" };
  }
  if (!resp) return { ok: false, outcome: "network_error", detail: "пустой ответ вкладки" };
  const { outcome, json } = classify(resp);
  const meta = { ms: Date.now() - t0, bytes: (resp.text || "").length };
  if (outcome === "checkpoint" || outcome === "login_wall") sendState();
  if (outcome !== "ok") {
    return { ok: false, outcome, http_status: resp.status, meta,
             detail: json ? String(json.message || "").slice(0, 200) : (resp.error || "") };
  }
  const data = project(job.op, json);
  if (!data) {
    if (job.op === "profile_posts") runBeacon();
    return { ok: false, outcome: "parse_error", http_status: resp.status, meta,
             detail: json && json.errors ? String((json.errors[0] || {}).message || "").slice(0, 200) : "нет данных в ответе" };
  }
  console.log("ig-bridge:", job.op, outcome, `${meta.ms} мс`);
  return { ok: true, outcome: "ok", http_status: resp.status, data, meta };
}

// --- для popup и options -----------------------------------------------------

async function getState() {
  const s = await getLocal(["lastStatus", "lastMessage", "account", "connectedAt", "opsHour", "opsDay", "lastOp", "pageConfig"]);
  return {
    status: s.lastStatus || "offline",
    message: s.lastMessage || "",
    account: s.account || "",
    connected: !!(ws && ws.readyState === WebSocket.OPEN),
    connectedAt: s.connectedAt || null,
    opsHour: (s.opsHour && s.opsHour.hour === Math.floor(Date.now() / 3600000)) ? s.opsHour.count : 0,
    opsDay: (s.opsDay && s.opsDay.day === new Date().toDateString()) ? s.opsDay.count : 0,
    lastOp: s.lastOp || null,
    docIdCapturedAt: s.pageConfig && s.pageConfig.doc_id && s.pageConfig.doc_id.PolarisProfilePostsQuery
      ? s.pageConfig.captured_at : null,
    version: VERSION,
  };
}

async function selfTest() {
  const result = await runJob({ id: "self-test", op: "verify", args: {}, deadline_ms: 30000 });
  return { verify: result.outcome, detail: result.detail || "", connected: !!(ws && ws.readyState === WebSocket.OPEN) };
}
