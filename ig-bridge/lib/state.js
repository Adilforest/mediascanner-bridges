// IG Bridge: состояние, бейдж и уведомления (план Instagram v2, 02).

export const DEFAULTS = {
  bridgeUrl: "wss://ig-bridge.mediascanner.kz/ws",
  token: "",
  label: "office-pc-1",
  igUsername: "",
  beaconProfile: "oskemencity",
};

const BADGES = {
  ok: { text: "", color: "#2e7d32" },
  not_configured: { text: "SET", color: "#9e9e9e" },
  logged_out: { text: "IN", color: "#c62828" },
  rejected: { text: "IN", color: "#c62828" },
  checkpoint: { text: "!", color: "#c62828" },
  expired: { text: "EXP", color: "#c62828" },
  disabled: { text: "OFF", color: "#9e9e9e" },
  offline: { text: "ERR", color: "#ef6c00" },
  bad_token: { text: "KEY", color: "#c62828" },
};

const NOTIFY = {
  not_configured: ["IG Bridge", "Откройте настройки расширения и укажите токен", false],
  logged_out: ["IG Bridge: вход в Instagram", "Вы вышли из Instagram в профиле IG Bridge, войдите снова", true],
  checkpoint: ["IG Bridge: нужна проверка", "Instagram просит подтвердить вход: откройте instagram.com в этом профиле и пройдите проверку", true],
  expired: ["IG Bridge: сессия не работает", "Выйдите и войдите в Instagram заново", true],
  offline: ["IG Bridge: нет связи", "Нет связи с сервером MediaScanner", false],
  bad_token: ["IG Bridge: неверный токен", "Неверный токен в настройках расширения", true],
};

const NOTIFY_EVERY_MS = 3 * 60 * 60 * 1000;

export async function getSettings() {
  const s = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return Object.assign({}, DEFAULTS, s);
}

export async function getLocal(keys) {
  return chrome.storage.local.get(keys);
}

export async function setLocal(values) {
  await chrome.storage.local.set(values);
}

export async function setState(state, message, extra = {}) {
  const prev = (await chrome.storage.local.get("lastStatus")).lastStatus;
  await chrome.storage.local.set(Object.assign({ lastStatus: state, lastMessage: message || "" }, extra));
  const badge = BADGES[state] || BADGES.offline;
  try {
    await chrome.action.setBadgeText({ text: badge.text });
    await chrome.action.setBadgeBackgroundColor({ color: badge.color });
    const s = await chrome.storage.local.get(["account", "connectedAt", "opsHour"]);
    const since = s.connectedAt ? new Date(s.connectedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "—";
    await chrome.action.setTitle({
      title: state === "ok"
        ? `OK · на связи с ${since} · ${s.account || ""} · команд за час: ${(s.opsHour && s.opsHour.count) || 0}`
        : `IG Bridge: ${message || state}`,
    });
  } catch (_) {}
  if (state !== prev) await maybeNotify(state, message);
}

async function maybeNotify(state, message) {
  const n = NOTIFY[state];
  if (!n) return;
  const key = `notified_${state}`;
  const last = (await chrome.storage.local.get(key))[key] || 0;
  if (Date.now() - last < NOTIFY_EVERY_MS) return;
  await chrome.storage.local.set({ [key]: Date.now() });
  try {
    await chrome.notifications.create(`ig-bridge-${state}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: n[0],
      message: message || n[1],
      requireInteraction: n[2],
      priority: n[2] ? 2 : 0,
    });
  } catch (_) {}
}
