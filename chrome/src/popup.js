"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const button = document.getElementById("captureBtn");
const status = document.getElementById("status");
if (button && status) {
    button.addEventListener("click", async () => {
        button.disabled = true;
        setStatus("Capturing the active tab...");
        try {
            const response = await chrome.runtime.sendMessage({ type: "mdo:capture-active-tab" });
            if (!response || !response.ok) {
                throw new Error(response?.error || "Capture failed.");
            }
            setStatus(`Saved ${response.result.filename}`);
        }
        catch (err) {
            setStatus(err?.message || String(err), true);
        }
        finally {
            button.disabled = false;
        }
    });
}
function setStatus(message, isError = false) {
    if (!status) {
        return;
    }
    status.textContent = message;
    status.classList.toggle("error", isError);
}
//# sourceMappingURL=popup.js.map