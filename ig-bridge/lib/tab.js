// IG Bridge: закреплённая вкладка instagram.com, в которой выполняются запросы.
//
// Запросы из service worker не годятся: POST /graphql/query оттуда отдаёт
// ответ без данных (spike 06.10.2026). Внутри вкладки запрос идёт с теми же
// куками, заголовками и токенами, что у самого сайта.

const HOME = "https://www.instagram.com/";

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
    chrome.tabs.get(tabId).then((t) => { if (t && t.status === "complete") finish(); }).catch(finish);
    setTimeout(finish, timeoutMs);
  });
}

export function tabState(url) {
  const u = String(url || "");
  if (/\/challenge\//.test(u)) return "challenge";
  if (/\/accounts\/login/.test(u)) return "login";
  if (!/^https:\/\/www\.instagram\.com\//.test(u)) return "none";
  return "ok";
}

export async function findTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.instagram.com/*" });
  return tabs.find((t) => t.pinned) || tabs[0] || null;
}

export async function ensureTab() {
  let tab = await findTab();
  if (!tab) {
    tab = await chrome.tabs.create({ url: HOME, pinned: true, active: false });
    await waitComplete(tab.id, 30000);
    tab = await chrome.tabs.get(tab.id);
  } else if (tab.status !== "complete") {
    await waitComplete(tab.id, 20000);
    tab = await chrome.tabs.get(tab.id);
  }
  if (!tab.pinned) {
    try { await chrome.tabs.update(tab.id, { pinned: true }); } catch (_) {}
  }
  return tab;
}

export async function runInTab(tabId, func, args) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func, args });
  return res ? res.result : null;
}

// Профиль-маяк: страница сама делает PolarisProfilePostsQuery, захватчик
// (content/capture.js) снимает свежий doc_id и форму variables. Заодно куки
// обновляются естественным путём, как у живого пользователя.
export async function visitBeacon(profile) {
  const name = String(profile || "").replace(/[^A-Za-z0-9._]/g, "");
  if (!name) return false;
  const tab = await ensureTab();
  await chrome.tabs.update(tab.id, { url: `${HOME}${name}/` });
  await waitComplete(tab.id, 30000);
  await wait(20000 + Math.random() * 20000);
  await chrome.tabs.update(tab.id, { url: HOME });
  await waitComplete(tab.id, 30000);
  return true;
}
