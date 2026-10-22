const LABELS = {
  ok: "Работает", not_configured: "Не настроено", logged_out: "Выход из Instagram", checkpoint: "Нужна проверка",
  expired: "Сессия протухла", disabled: "Выключено на сервере", offline: "Нет связи", bad_token: "Неверный токен",
};

function time(ts) {
  return ts ? new Date(ts).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
}

async function render() {
  const s = await chrome.runtime.sendMessage({ type: "get-state" });
  document.getElementById("status").textContent = `${LABELS[s.status] || s.status}${s.account ? " · " + s.account : ""}`;
  document.getElementById("message").textContent = s.message || "";
  const last = s.lastOp ? `${s.lastOp.op}: ${s.lastOp.outcome} (${time(s.lastOp.at)})` : "—";
  document.getElementById("details").innerHTML = [
    `Соединение: ${s.connected ? "есть" : "нет"}, с ${time(s.connectedAt)}`,
    `Команд за час: ${s.opsHour}, за сутки: ${s.opsDay}`,
    `Последняя команда: ${last}`,
    `doc_id ленты: ${s.docIdCapturedAt ? "захвачен " + time(s.docIdCapturedAt) : "ещё не захвачен"}`,
    `Версия: ${s.version}`,
  ].map((x) => `<div>${x.replace(/</g, "&lt;")}</div>`).join("");
}

document.getElementById("reconnect").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "reconnect" });
  setTimeout(render, 1500);
});
document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
render();
