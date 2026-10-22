// IG Bridge: передача захваченной конфигурации из MAIN world в service worker.
// MAIN world не имеет доступа к chrome.runtime, ISOLATED имеет: этот скрипт
// только пересылает сообщение, ничего не читая со страницы сам.
window.addEventListener("message", (event) => {
  if (event.source !== window || !event.data || event.data.__igBridgeCapture !== true) return;
  const d = event.data;
  try {
    chrome.runtime.sendMessage({
      type: "capture",
      name: String(d.name || ""),
      docId: String(d.docId || ""),
      variables: d.variables && typeof d.variables === "object" ? d.variables : null,
      appId: d.appId ? String(d.appId) : null,
      asbdId: d.asbdId ? String(d.asbdId) : null,
    });
  } catch (_) {
    // расширение обновили, а страница ещё со старым скриптом: не страшно
  }
});
