type CaptureMode = "selection" | "article" | "full";

type CaptureMessage =
  | {
      ok: true;
      result: {
        filename: string;
        captureModeUsed: CaptureMode | "pdf";
      };
    }
  | {
      ok: false;
      error: string;
    };

const CAPTURE_MODE_STORAGE_KEY = "mdo.captureMode";

const button = document.getElementById("captureBtn") as HTMLButtonElement | null;
const titleInput = document.getElementById("titleInput") as HTMLInputElement | null;
const captureModeSelect = document.getElementById("captureMode") as HTMLSelectElement | null;
const status = document.getElementById("status") as HTMLDivElement | null;

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
        title: titleInput?.value.trim() || undefined
      }) as CaptureMessage;
      if (!response || !response.ok) {
        throw new Error(response?.error || "Capture failed.");
      }

      setStatus(`Saved ${response.result.filename} from ${formatCaptureModeLabel(response.result.captureModeUsed)}.`);
    } catch (err: any) {
      setStatus(err?.message || String(err), true);
    } finally {
      button.disabled = false;
    }
  });
}

async function initializePopup(): Promise<void> {
  try {
    await Promise.all([
      initializeCaptureMode(),
      initializeTitleInput()
    ]);
  } catch (err: any) {
    setStatus(err?.message || String(err), true);
  }
}

async function initializeCaptureMode(): Promise<void> {
  if (!captureModeSelect) {
    return;
  }

  const stored = await chrome.storage.local.get(CAPTURE_MODE_STORAGE_KEY);
  const captureMode = isCaptureMode(stored[CAPTURE_MODE_STORAGE_KEY]) ? stored[CAPTURE_MODE_STORAGE_KEY] : "article";
  captureModeSelect.value = captureMode;
}

async function initializeTitleInput(): Promise<void> {
  if (!titleInput) {
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  titleInput.value = (tab?.title || "").trim();
}

function getSelectedCaptureMode(): CaptureMode {
  const value = captureModeSelect?.value;
  return isCaptureMode(value) ? value : "article";
}

function isCaptureMode(value: unknown): value is CaptureMode {
  return value === "selection" || value === "article" || value === "full";
}

function formatCaptureModeLabel(captureMode: CaptureMode | "pdf"): string {
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

function setStatus(message: string, isError = false): void {
  if (!status) {
    return;
  }

  status.textContent = message;
  status.classList.toggle("error", isError);
}
