type CaptureMessage =
  | {
      ok: true;
      result: {
        filename: string;
      };
    }
  | {
      ok: false;
      error: string;
    };

const button = document.getElementById("captureBtn") as HTMLButtonElement | null;
const status = document.getElementById("status") as HTMLDivElement | null;

if (button && status) {
  button.addEventListener("click", async () => {
    button.disabled = true;
    setStatus("Capturing the active tab...");

    try {
      const response = await chrome.runtime.sendMessage({ type: "mdo:capture-active-tab" }) as CaptureMessage;
      if (!response || !response.ok) {
        throw new Error(response?.error || "Capture failed.");
      }

      setStatus(`Saved ${response.result.filename}`);
    } catch (err: any) {
      setStatus(err?.message || String(err), true);
    } finally {
      button.disabled = false;
    }
  });
}

function setStatus(message: string, isError = false): void {
  if (!status) {
    return;
  }

  status.textContent = message;
  status.classList.toggle("error", isError);
}
