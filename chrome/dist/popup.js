"use strict";
(() => {
  // chrome/src/popup.ts
  var CAPTURE_MODE_STORAGE_KEY = "mdo.captureMode";
  var button = document.getElementById("captureBtn");
  var titleInput = document.getElementById("titleInput");
  var captureModeSelect = document.getElementById("captureMode");
  var status = document.getElementById("status");
  void initializePopup();
  if (button && status && captureModeSelect) {
    button.addEventListener("click", async () => {
      button.disabled = true;
      const captureMode = getSelectedCaptureMode();
      setStatus(`Capturing ${formatCaptureModeLabel(captureMode).toLowerCase()} content...`);
      try {
        await chrome.storage.local.set({ [CAPTURE_MODE_STORAGE_KEY]: captureMode });
        const response = await chrome.runtime.sendMessage({
          type: "mdo:capture-active-tab",
          captureMode,
          title: titleInput?.value.trim() || void 0
        });
        if (!response || !response.ok) {
          throw new Error(response?.error || "Capture failed.");
        }
        setStatus(`Saved ${response.result.filename} from ${formatCaptureModeLabel(response.result.captureModeUsed)}.`);
      } catch (err) {
        setStatus(err?.message || String(err), true);
      } finally {
        button.disabled = false;
      }
    });
  }
  async function initializePopup() {
    try {
      await Promise.all([
        initializeCaptureMode(),
        initializeTitleInput()
      ]);
    } catch (err) {
      setStatus(err?.message || String(err), true);
    }
  }
  async function initializeCaptureMode() {
    if (!captureModeSelect) {
      return;
    }
    const stored = await chrome.storage.local.get(CAPTURE_MODE_STORAGE_KEY);
    const captureMode = isCaptureMode(stored[CAPTURE_MODE_STORAGE_KEY]) ? stored[CAPTURE_MODE_STORAGE_KEY] : "article";
    captureModeSelect.value = captureMode;
  }
  async function initializeTitleInput() {
    if (!titleInput) {
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    titleInput.value = (tab?.title || "").trim();
  }
  function getSelectedCaptureMode() {
    const value = captureModeSelect?.value;
    return isCaptureMode(value) ? value : "article";
  }
  function isCaptureMode(value) {
    return value === "selection" || value === "article" || value === "full";
  }
  function formatCaptureModeLabel(captureMode) {
    if (captureMode === "selection") {
      return "Selection";
    }
    if (captureMode === "full") {
      return "Full page";
    }
    if (captureMode === "pdf") {
      return "PDF";
    }
    return "Article";
  }
  function setStatus(message, isError = false) {
    if (!status) {
      return;
    }
    status.textContent = message;
    status.classList.toggle("error", isError);
  }
})();
//# sourceMappingURL=popup.js.map
