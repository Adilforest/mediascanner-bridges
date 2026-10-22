const FIELDS = ["server", "token", "label", "ttAccount"];
const DEFAULTS = { server: "https://app.mediascanner.kz", token: "", label: "tt-pc-1", ttAccount: "" };
const SERVER = {
  ok: "на связи, токен принят",
  not_configured: "токен не указан",
  bad_token: "неверный токен",
  offline: "нет связи",
};
const TIKTOK = {
  ok: "вход выполнен, вкладка tiktok.com закреплена",
  login: "входа нет: войдите на tiktok.com в этом профиле Chrome",
  checkpoint: "TikTok просит проверку: откройте tiktok.com и пройдите её",
  no_tab: "не удалось открыть вкладку tiktok.com",
};
const out = (text) => { document.getElementById("result").textContent = text; };

async function load() {
  const s = await chrome.storage.local.get(FIELDS);
  for (const f of FIELDS) document.getElementById(f).value = s[f] ?? DEFAULTS[f];
}

document.getElementById("save").addEventListener("click", async () => {
  const values = {};
  for (const f of FIELDS) values[f] = document.getElementById(f).value.trim() || DEFAULTS[f];
  if (!/^https:\/\//.test(values.server)) return out("Адрес сервера должен начинаться с https://");
  await chrome.storage.local.set(Object.assign(values, { nextAt: 0 }));
  out("Сохранено. Нажмите «Проверить».");
});

document.getElementById("test").addEventListener("click", async () => {
  out("Проверяю…");
  const r = await chrome.runtime.sendMessage({ type: "test" });
  out([
    `Сервер: ${SERVER[r.server] || r.server}`,
    `TikTok: ${TIKTOK[r.tiktok] || r.tiktok}${r.account ? ` (аккаунт ${r.account})` : ""}`,
    r.detail ? `Подробности: ${r.detail}` : "",
  ].filter(Boolean).join("\n"));
});

load();
