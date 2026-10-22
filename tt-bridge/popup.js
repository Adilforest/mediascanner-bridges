const STATES = {
  ok: "Работает",
  not_configured: "Не настроено: укажите токен в настройках",
  login: "Вход в TikTok потерян: войдите в этом профиле",
  checkpoint: "TikTok просит проверку: откройте tiktok.com",
  bad_token: "Неверный токен",
  offline: "Нет связи с сервером MediaScanner",
};
const time = (ms) => (ms ? new Date(ms).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "—");

async function render() {
  const s = await chrome.storage.local.get(["state", "last", "stats", "nextAt", "lastError", "ttAccount", "ttAccountSeen", "label"]);
  document.getElementById("account").textContent = [s.label, s.ttAccountSeen || s.ttAccount].filter(Boolean).join(" · ");
  document.getElementById("state").textContent = STATES[s.state] || "Ожидание первой проверки";
  const l = s.last;
  document.getElementById("last").textContent = l
    ? `Последняя проверка ${time(l.at)}: ${l.url.replace("https://www.tiktok.com/", "")}, ${l.status}, постов ${l.posts}, новых ${l.created}`
    : "";
  const st = s.stats || { checks: 0, created: 0 };
  document.getElementById("stats").textContent = `С установки: проверок ${st.checks}, новых постов ${st.created}`
    + (s.lastError ? ` · ошибка: ${s.lastError}` : "");
  document.getElementById("next").textContent = s.nextAt ? `Следующий запрос к серверу ${time(s.nextAt)}` : "";
}

document.getElementById("run").addEventListener("click", async () => {
  document.getElementById("state").textContent = "Собираю следующий аккаунт…";
  await chrome.runtime.sendMessage({ type: "run_now" });
  render();
});
document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
render();
