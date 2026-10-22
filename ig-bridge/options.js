const FIELDS = ["bridgeUrl", "token", "label", "igUsername", "beaconProfile"];
const DEFAULTS = { bridgeUrl: "wss://ig-bridge.mediascanner.kz/ws", label: "office-pc-1", beaconProfile: "oskemencity" };
const OUTCOMES = {
  ok: "Instagram отвечает, сессия живая",
  login_wall: "Instagram показывает форму входа: войдите в этом профиле Chrome",
  checkpoint: "Instagram просит подтвердить вход: откройте instagram.com и пройдите проверку",
  rate_limited: "Instagram просит подождать (429): попробуйте позже",
  network_error: "Нет вкладки instagram.com или сети",
};

async function load() {
  const s = await chrome.storage.local.get(FIELDS);
  for (const f of FIELDS) document.getElementById(f).value = s[f] ?? DEFAULTS[f] ?? "";
}

document.getElementById("save").addEventListener("click", async () => {
  const values = {};
  for (const f of FIELDS) values[f] = document.getElementById(f).value.trim();
  if (values.bridgeUrl && !/^wss?:\/\//.test(values.bridgeUrl)) {
    document.getElementById("result").textContent = "Адрес шлюза должен начинаться с wss://";
    return;
  }
  // Новый токен: снять «неверный токен», чтобы расширение снова подключилось.
  await chrome.storage.local.set(Object.assign(values, { lastStatus: "offline" }));
  await chrome.runtime.sendMessage({ type: "reconnect" });
  document.getElementById("result").textContent = "Сохранено, подключаюсь…";
});

document.getElementById("test").addEventListener("click", async () => {
  document.getElementById("result").textContent = "Проверяю…";
  const r = await chrome.runtime.sendMessage({ type: "test" });
  const state = await chrome.runtime.sendMessage({ type: "get-state" });
  document.getElementById("result").textContent = [
    `Instagram: ${OUTCOMES[r.verify] || r.verify}${r.detail ? " (" + r.detail + ")" : ""}`,
    `Шлюз: ${r.connected ? "на связи" : "нет связи"}${state.message ? ", " + state.message : ""}`,
  ].join("\n");
});

load();
