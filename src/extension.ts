
import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import type { Dirent } from "fs";
import JSZip from "jszip";
import { marked } from "marked";
import { buildMdoMetadata, MDO_METADATA_NAME } from "./shared/mdoMetadata";
import { normalizeMediaReference } from "./shared/mediaUrl";
import { collapseLinkedMediaWrappers } from "./shared/markdownCleanup";

const MDO_VERSION = "0.1";
const MAIN_MD_NAME = "document.md";
const MANIFEST_NAME = "manifest.json";
const METADATA_NAME = MDO_METADATA_NAME;

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".bmp", ".tiff", ".tif"]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv", ".ogv"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"]);
const PDF_EXTS = new Set([".pdf"]);

type MdoFileRecord = {
  originalPath: string;
  storedPath: string;
  originalName: string;
  mime: string;
  type: string;
  sizeBytes: number;
  sha256: string;
  referencedInMarkdown: boolean;
};

type MdoManifest = {
  format: "mdo";
  version: string;
  createdUnix: number;
  createdLocal: string;
  title: string;
  main: string;
  metadata?: string;
  sourceUrl?: string;
  sourceMarkdown?: string;
  files: MdoFileRecord[];
  missingRefs: string[];
};

export function activate(context: vscode.ExtensionContext) {
  const provider = new MdoCustomEditorProvider(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      MdoCustomEditorProvider.viewType,
      provider,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        },
        supportsMultipleEditorsPerDocument: false
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mdo.createFromMarkdown", async (uri?: vscode.Uri) => {
      await createMdoFromMarkdownCommand(uri);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mdo.new", async () => {
      await createBlankMdoFileCommand();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mdo.extract", async (uri?: vscode.Uri) => {
      await extractMdoCommand(uri);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mdo.preview", async (uri?: vscode.Uri) => {
      const target = await getUriFromCommandOrDialog(uri, "Select MDO file", { "MDO files": ["mdo"] });
      if (!target) {
        return;
      }
      await vscode.commands.executeCommand("vscode.openWith", target, MdoCustomEditorProvider.viewType);
    })
  );
}

export function deactivate() {}

type MdoWebviewFile = {
  name: string;
  mime: string;
  dataBase64: string;
  size: number;
};

type MdoEditorState = {
  markdown: string;
  previewHtml: string;
  title: string;
  dirty: boolean;
  loadError?: string;
};

type LoadedMdoState = {
  markdown: string;
  manifest: MdoManifest;
  mainName: string;
  loadError?: string;
};

type MdoWebviewStateMessage =
  | {
      type: "ready";
    }
  | {
      type: "markdownChanged";
      markdown: string;
    }
  | {
      type: "dropFiles";
      files: MdoWebviewFile[];
      selectionStart?: number;
      selectionEnd?: number;
    }
  | {
      type: "save";
    }
  | {
      type: "saveAs";
    }
  | {
      type: "revert";
    }
  | {
      type: "openLink";
      href: string;
    };

class MdoCustomDocument implements vscode.CustomDocument {
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  private _uri: vscode.Uri;
  private _dirty = false;
  public panel: vscode.WebviewPanel | undefined;

  constructor(
    uri: vscode.Uri,
    public readonly workingDir: string,
    public markdown: string,
    public manifest: MdoManifest,
    public mainName: string,
    public loadError?: string
  ) {
    this._uri = uri;
  }

  get uri(): vscode.Uri {
    return this._uri;
  }

  set uri(value: vscode.Uri) {
    this._uri = value;
  }

  get dirty(): boolean {
    return this._dirty;
  }

  set dirty(value: boolean) {
    this._dirty = value;
  }

  dispose(): void {
    this.disposeEmitter.fire();
    this.disposeEmitter.dispose();
    void fs.rm(this.workingDir, { recursive: true, force: true }).catch(() => {});
  }
}

class MdoCustomEditorProvider implements vscode.CustomEditorProvider<MdoCustomDocument> {
  public static readonly viewType = "mdo.viewer";

  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent<MdoCustomDocument>>();
  public readonly onDidChangeCustomDocument = this.onDidChangeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): Promise<MdoCustomDocument> {
    if (openContext.backupId) {
      const backupUri = vscode.Uri.parse(openContext.backupId);
      const bytes = await fs.readFile(backupUri.fsPath);
      return await loadMdoDocumentFromBytes(uri, bytes, this.context);
    }

    if (openContext.untitledDocumentData) {
      return await loadMdoDocumentFromBytes(uri, openContext.untitledDocumentData, this.context);
    }

    try {
      const stat = await fs.stat(uri.fsPath);
      if (stat.size > 0) {
        const bytes = await fs.readFile(uri.fsPath);
        return await loadMdoDocumentFromBytes(uri, bytes, this.context);
      }
    } catch {
      // Treat missing or unreadable files as a new blank document so users can start editing immediately.
    }

    return await createBlankMdoDocument(uri, this.context);
  }

  async resolveCustomEditor(
    document: MdoCustomDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    document.panel = webviewPanel;
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(document.workingDir)]
    };

    const renderAndPost = async (
      selection?: { start?: number; end?: number }
    ): Promise<void> => {
      const state = await buildEditorState(document, webviewPanel.webview);
      await webviewPanel.webview.postMessage({
        type: "state",
        state: {
          ...state,
          selectionStart: selection?.start,
          selectionEnd: selection?.end
        }
      });
      webviewPanel.title = `${state.title}${state.dirty ? " *" : ""}`;
    };

    webviewPanel.webview.html = await buildEditorShellHtml(
      webviewPanel.webview,
      document,
      await buildEditorState(document, webviewPanel.webview)
    );

    const messageListener = webviewPanel.webview.onDidReceiveMessage(async (message: MdoWebviewStateMessage) => {
      if (message.type === "ready") {
        await renderAndPost();
        return;
      }

      if (message.type === "markdownChanged") {
        if (message.markdown !== document.markdown) {
          document.markdown = message.markdown;
          document.dirty = true;
          document.loadError = undefined;
          this.onDidChangeEmitter.fire({ document });
        }
        await renderAndPost();
        return;
      }

      if (message.type === "dropFiles") {
        const selection = await addDroppedFilesToDocument(document, message.files, message.selectionStart, message.selectionEnd);
        document.dirty = true;
        document.loadError = undefined;
        this.onDidChangeEmitter.fire({ document });
        await renderAndPost(selection);
        return;
      }

      if (message.type === "save") {
        await vscode.commands.executeCommand("workbench.action.files.save");
        return;
      }

      if (message.type === "saveAs") {
        await vscode.commands.executeCommand("workbench.action.files.saveAs");
        return;
      }

      if (message.type === "revert") {
        await this.revertCustomDocument(document, new vscode.CancellationTokenSource().token);
        return;
      }

      if (message.type === "openLink") {
        await openPreviewLink(document, message.href);
      }
    });

    webviewPanel.onDidDispose(() => {
      messageListener.dispose();
      document.panel = undefined;
    });
  }

  async saveCustomDocument(document: MdoCustomDocument, _cancellation: vscode.CancellationToken): Promise<void> {
    const destination = document.uri;
    const manifest = await saveMdoDocument(document, destination);
    document.manifest = manifest;
    document.dirty = false;
    await postEditorState(document);
  }

  async saveCustomDocumentAs(
    document: MdoCustomDocument,
    destination: vscode.Uri,
    _cancellation: vscode.CancellationToken
  ): Promise<void> {
    const previousUri = document.uri;
    const previousManifest = document.manifest;
    const currentDefaultTitle = getDefaultMdoTitle(document.uri);
    if (document.manifest.title === currentDefaultTitle) {
      document.manifest = {
        ...document.manifest,
        title: getDefaultMdoTitle(destination)
      };
    }

    try {
      const manifest = await saveMdoDocument(document, destination);
      document.uri = destination;
      document.manifest = manifest;
      document.dirty = false;
      await postEditorState(document);
    } catch (error) {
      document.uri = previousUri;
      document.manifest = previousManifest;
      throw error;
    }
  }

  async revertCustomDocument(document: MdoCustomDocument, _cancellation: vscode.CancellationToken): Promise<void> {
    try {
      const bytes = await fs.readFile(document.uri.fsPath);
      const state = await parseMdoArchive(bytes, document.workingDir, document.uri);
      document.markdown = state.markdown;
      document.manifest = state.manifest;
      document.mainName = state.mainName;
      document.loadError = undefined;
    } catch {
      await resetDocumentToBlank(document);
    }

    document.dirty = false;
    await postEditorState(document);
    this.onDidChangeEmitter.fire({ document });
  }

  async backupCustomDocument(
    document: MdoCustomDocument,
    context: vscode.CustomDocumentBackupContext,
    _cancellation: vscode.CancellationToken
  ): Promise<vscode.CustomDocumentBackup> {
    await fs.mkdir(path.dirname(context.destination.fsPath), { recursive: true });
    const bytes = await buildMdoArchiveBytes(document);
    await fs.writeFile(context.destination.fsPath, bytes);

    return {
      id: context.destination.toString(),
      delete: () => {
        void fs.rm(context.destination.fsPath, { force: true }).catch(() => {});
      }
    };
  }
}

async function createBlankMdoDocument(uri: vscode.Uri, context: vscode.ExtensionContext): Promise<MdoCustomDocument> {
  const workingDir = await createWorkingDir(uri);
  const manifest = createDefaultManifest(uri);
  return new MdoCustomDocument(uri, workingDir, "", manifest, MAIN_MD_NAME);
}

async function loadMdoDocumentFromBytes(
  uri: vscode.Uri,
  bytes: Uint8Array,
  context: vscode.ExtensionContext
): Promise<MdoCustomDocument> {
  const workingDir = await createWorkingDir(uri);

  try {
    const state = await parseMdoArchive(bytes, workingDir, uri);
    return new MdoCustomDocument(uri, workingDir, state.markdown, state.manifest, state.mainName, state.loadError);
  } catch (err: any) {
    await fs.rm(workingDir, { recursive: true, force: true }).catch(() => {});
    const blank = await createBlankMdoDocument(uri, context);
    blank.loadError = err?.message || String(err);
    return blank;
  }
}

async function resetDocumentToBlank(document: MdoCustomDocument): Promise<void> {
  await fs.rm(document.workingDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(document.workingDir, { recursive: true });
  document.markdown = "";
  document.manifest = createDefaultManifest(document.uri);
  document.mainName = MAIN_MD_NAME;
  document.loadError = "Reverted to a blank MDO document.";
}

async function postEditorState(document: MdoCustomDocument, selection?: { start?: number; end?: number }): Promise<void> {
  if (!document.panel) {
    return;
  }

  const state = await buildEditorState(document, document.panel.webview);
  await document.panel.webview.postMessage({
    type: "state",
    state: {
      ...state,
      selectionStart: selection?.start,
      selectionEnd: selection?.end
    }
  });
  document.panel.title = `${state.title}${state.dirty ? " *" : ""}`;
}

async function buildEditorState(document: MdoCustomDocument, webview: vscode.Webview): Promise<MdoEditorState> {
  const title = document.manifest.title || getDefaultMdoTitle(document.uri);
  const previewHtml = await buildPreviewHtml(webview, document.workingDir, document.markdown);

  return {
    markdown: document.markdown,
    previewHtml,
    title,
    dirty: document.dirty,
    loadError: document.loadError
  };
}

async function buildEditorShellHtml(
  webview: vscode.Webview,
  document: MdoCustomDocument,
  initialState: MdoEditorState
): Promise<string> {
  const nonce = getNonce();
  const stateJson = serializeForScript(initialState);

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta
  http-equiv="Content-Security-Policy"
  content="
    default-src 'none';
    img-src ${webview.cspSource} data: blob: https: http:;
    media-src ${webview.cspSource} data: blob: https: http:;
    style-src ${webview.cspSource} 'unsafe-inline';
    script-src 'nonce-${nonce}';
  "
>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(initialState.title)}</title>
<style>
:root {
  --bg: var(--vscode-editor-background);
  --fg: var(--vscode-editor-foreground);
  --muted: var(--vscode-descriptionForeground);
  --border: var(--vscode-panel-border);
  --link: var(--vscode-textLink-foreground);
  --code-bg: var(--vscode-textCodeBlock-background);
  --button-bg: var(--vscode-button-background);
  --button-fg: var(--vscode-button-foreground);
  --button-hover: var(--vscode-button-hoverBackground);
  --input-bg: var(--vscode-input-background);
  --input-fg: var(--vscode-input-foreground);
  --input-border: var(--vscode-input-border);
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  height: 100vh;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--vscode-font-family);
  overflow: hidden;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.toolbar button {
  appearance: none;
  border: 1px solid transparent;
  background: var(--button-bg);
  color: var(--button-fg);
  border-radius: 6px;
  padding: 6px 12px;
  cursor: pointer;
}
.toolbar button:hover {
  background: var(--button-hover);
}
.toolbar .spacer {
  flex: 1;
}
.title {
  font-weight: 600;
}
.status {
  color: var(--muted);
  font-size: 0.9em;
}
.banner {
  display: none;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  color: var(--vscode-errorForeground);
  background: color-mix(in srgb, var(--vscode-errorForeground) 10%, transparent);
}
.shell {
  display: grid;
  grid-template-columns: minmax(320px, 1fr) minmax(360px, 1fr);
  height: calc(100vh - 50px);
  min-height: 0;
}
.pane {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.pane-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  color: var(--muted);
  font-size: 0.9em;
}
.editor-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
}
textarea {
  width: 100%;
  height: 100%;
  border: 0;
  outline: none;
  resize: none;
  padding: 12px;
  background: var(--input-bg);
  color: var(--input-fg);
  font-family: var(--vscode-editor-font-family);
  font-size: var(--vscode-editor-font-size);
  line-height: 1.6;
}
.drop-hint {
  position: absolute;
  right: 12px;
  bottom: 12px;
  padding: 6px 8px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.15);
  color: var(--muted);
  font-size: 0.8em;
  pointer-events: none;
}
.preview-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 28px;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  line-height: 1.65;
}
.preview-content .mdo-preview {
  max-width: 980px;
  margin: 0 auto;
}
.preview-content h1,
.preview-content h2,
.preview-content h3 {
  line-height: 1.25;
}
.preview-content h1 {
  border-bottom: 1px solid var(--border);
  padding-bottom: 0.35em;
}
.preview-content img {
  max-width: 100%;
  height: auto;
  display: block;
  border-radius: 8px;
  margin: 16px 0;
}
.preview-content video {
  width: 100%;
  max-height: 72vh;
  display: block;
  border-radius: 10px;
  background: #000;
}
.preview-content audio {
  width: 100%;
}
.preview-content figure.media-block {
  margin: 20px 0;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
}
.preview-content figcaption {
  color: var(--muted);
  font-size: 0.9em;
  margin-top: 8px;
}
.preview-content pre {
  background: var(--code-bg);
  padding: 14px;
  border-radius: 8px;
  overflow-x: auto;
}
.preview-content code {
  background: var(--code-bg);
  padding: 0.15em 0.35em;
  border-radius: 4px;
}
.preview-content pre code {
  padding: 0;
}
.preview-content table {
  border-collapse: collapse;
  width: 100%;
}
.preview-content th,
.preview-content td {
  border: 1px solid var(--border);
  padding: 6px 8px;
}
.preview-content a {
  color: var(--link);
}
.preview-content blockquote {
  border-left: 4px solid var(--border);
  padding-left: 14px;
  color: var(--muted);
}
.preview-content details.attachment-preview {
  margin: 16px 0;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
}
.preview-content summary {
  cursor: pointer;
}
.preview-content .table-wrap {
  overflow-x: auto;
}
.preview-content .preview-note {
  color: var(--muted);
  font-size: 0.9em;
}
@media (max-width: 900px) {
  .shell {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr 1fr;
  }
  .pane:first-child {
    border-bottom: 1px solid var(--border);
  }
}
</style>
</head>
<body>
<div class="toolbar">
  <button id="saveBtn" type="button">Save</button>
  <button id="saveAsBtn" type="button">Save As</button>
  <button id="revertBtn" type="button">Revert</button>
  <button id="addFilesBtn" type="button">Add Files</button>
  <span class="spacer"></span>
  <span class="title" id="title">${escapeHtml(initialState.title)}</span>
  <span class="status" id="status">${initialState.dirty ? "Unsaved" : "Saved"}</span>
</div>
<div class="banner" id="banner"></div>
<div class="shell">
  <section class="pane">
    <div class="pane-header">
      <span>Markdown</span>
      <span>Drop media into the editor to package it</span>
    </div>
    <div class="editor-wrap">
      <textarea id="markdown" spellcheck="false"></textarea>
      <div class="drop-hint">Drag files here</div>
    </div>
  </section>
  <section class="pane">
    <div class="pane-header">
      <span>Preview</span>
      <span>Live render</span>
    </div>
    <div id="preview" class="preview-content"></div>
  </section>
</div>
<input id="filePicker" type="file" multiple hidden />
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const initialState = ${stateJson};
const markdown = document.getElementById("markdown");
const preview = document.getElementById("preview");
const banner = document.getElementById("banner");
const title = document.getElementById("title");
const status = document.getElementById("status");
const filePicker = document.getElementById("filePicker");
const saveBtn = document.getElementById("saveBtn");
const saveAsBtn = document.getElementById("saveAsBtn");
const revertBtn = document.getElementById("revertBtn");
const addFilesBtn = document.getElementById("addFilesBtn");
let changeTimer = null;

function renderState(state) {
  if (typeof state.markdown === "string" && markdown.value !== state.markdown) {
    markdown.value = state.markdown;
    if (typeof state.selectionStart === "number" && typeof state.selectionEnd === "number") {
      try {
        markdown.setSelectionRange(state.selectionStart, state.selectionEnd);
        markdown.focus();
      } catch {}
    }
  }

  if (typeof state.previewHtml === "string") {
    preview.innerHTML = state.previewHtml;
  }

  if (typeof state.title === "string") {
    title.textContent = state.title;
  }

  if (typeof state.dirty === "boolean") {
    status.textContent = state.dirty ? "Unsaved" : "Saved";
  }

  if (typeof state.loadError === "string" && state.loadError) {
    banner.style.display = "block";
    banner.textContent = state.loadError;
  } else {
    banner.style.display = "none";
    banner.textContent = "";
  }
}

function scheduleMarkdownChange() {
  if (changeTimer) {
    clearTimeout(changeTimer);
  }
  changeTimer = setTimeout(() => {
    vscode.postMessage({
      type: "markdownChanged",
      markdown: markdown.value
    });
  }, 150);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function collectFiles(files) {
  const out = [];
  for (const file of files) {
    const data = await file.arrayBuffer();
    out.push({
      name: file.name,
      mime: file.type || "",
      dataBase64: arrayBufferToBase64(data),
      size: file.size
    });
  }
  return out;
}

async function handleSelectedFiles(fileList) {
  if (!fileList || fileList.length === 0) {
    return;
  }
  const files = await collectFiles(fileList);
  const selectionStart = markdown.selectionStart ?? markdown.value.length;
  const selectionEnd = markdown.selectionEnd ?? markdown.value.length;
  vscode.postMessage({
    type: "dropFiles",
    files,
    selectionStart,
    selectionEnd
  });
}

markdown.addEventListener("input", scheduleMarkdownChange);
markdown.addEventListener("dragover", (event) => {
  event.preventDefault();
});
markdown.addEventListener("drop", async (event) => {
  event.preventDefault();
  if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length > 0) {
    await handleSelectedFiles(event.dataTransfer.files);
  }
});

preview.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }

  const anchor = event.target.closest("a");
  if (!anchor) {
    return;
  }

  event.preventDefault();
  vscode.postMessage({
    type: "openLink",
    href: anchor.getAttribute("href") || anchor.href || ""
  });
});

saveBtn.addEventListener("click", () => vscode.postMessage({ type: "save" }));
saveAsBtn.addEventListener("click", () => vscode.postMessage({ type: "saveAs" }));
revertBtn.addEventListener("click", () => vscode.postMessage({ type: "revert" }));
addFilesBtn.addEventListener("click", () => filePicker.click());
filePicker.addEventListener("change", async () => {
  await handleSelectedFiles(filePicker.files);
  filePicker.value = "";
});

window.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || message.type !== "state") {
    return;
  }
  renderState(message.state);
});

markdown.value = initialState.markdown || "";
renderState(initialState);
vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}

async function addDroppedFilesToDocument(
  document: MdoCustomDocument,
  files: MdoWebviewFile[],
  selectionStart?: number,
  selectionEnd?: number
): Promise<{ start?: number; end?: number }> {
  if (!files.length) {
    return {};
  }

  const usedNamesByFolder = new Map<string, Set<string>>();
  const insertedBlocks: string[] = [];

  for (const file of files) {
    const insertDir = pickStorageFolderForFile(file);
    let usedNames = usedNamesByFolder.get(insertDir);
    if (!usedNames) {
      usedNames = await collectExistingNames(path.join(document.workingDir, insertDir));
      usedNamesByFolder.set(insertDir, usedNames);
    }

    const buffer = Buffer.from(file.dataBase64, "base64");
    const unique = uniqueName(file.name, usedNames);
    const storedPath = path.posix.join(insertDir, unique);
    const abs = path.join(document.workingDir, storedPath.replace(/\//g, path.sep));

    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, buffer);

    const mime = file.mime || guessMime(unique);
    const type = detectType(unique);
    const label = path.basename(unique, path.extname(unique)) || unique;
    const markdownRef = type === "image" ? `![${label}](${storedPath})` : `[${label}](${storedPath})`;
    insertedBlocks.push(markdownRef);
  }

  const insertion = insertedBlocks.join("\n\n");
  const normalizedStart = clampSelectionIndex(selectionStart ?? document.markdown.length, document.markdown.length);
  const normalizedEnd = clampSelectionIndex(selectionEnd ?? normalizedStart, document.markdown.length);
  const result = insertMarkdownBlock(document.markdown, insertion, normalizedStart, normalizedEnd);
  document.markdown = result.markdown;
  return { start: result.cursor, end: result.cursor };
}

function pickStorageFolderForFile(file: MdoWebviewFile): string {
  const type = detectType(file.name);
  return type === "image" || type === "video" || type === "audio" ? "assets" : "attachments";
}

function insertMarkdownBlock(
  markdown: string,
  insertion: string,
  selectionStart: number,
  selectionEnd: number
): { markdown: string; cursor: number } {
  const before = markdown.slice(0, selectionStart);
  const after = markdown.slice(selectionEnd);
  const needsLeadingBreak = before.length > 0 && !before.endsWith("\n");
  const needsTrailingBreak = after.length > 0 && !after.startsWith("\n");
  const prefix = needsLeadingBreak ? "\n" : "";
  const suffix = needsTrailingBreak ? "\n" : "";
  const nextMarkdown = `${before}${prefix}${insertion}${suffix}${after}`;
  const cursor = (before + prefix + insertion).length;
  return { markdown: nextMarkdown, cursor };
}

function clampSelectionIndex(value: number, max: number): number {
  if (!Number.isFinite(value)) {
    return max;
  }
  return Math.max(0, Math.min(max, Math.floor(value)));
}

async function collectExistingNames(dir: string): Promise<Set<string>> {
  const names = new Set<string>();
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        names.add(entry.name);
      }
    }
  } catch {
    // Directory may not exist yet.
  }
  return names;
}

async function createWorkingDir(uri: vscode.Uri): Promise<string> {
  const baseName = sanitizeTempComponent(path.basename(uri.fsPath || "mdo"));
  return await fs.mkdtemp(path.join(os.tmpdir(), `vscode-mdo-${baseName}-`));
}

function sanitizeTempComponent(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "mdo";
}

function createDefaultManifest(uri: vscode.Uri): MdoManifest {
  const now = new Date();
  return {
    format: "mdo",
    version: MDO_VERSION,
    createdUnix: Math.floor(Date.now() / 1000),
    createdLocal: now.toLocaleString(),
    title: getDefaultMdoTitle(uri),
    main: MAIN_MD_NAME,
    metadata: METADATA_NAME,
    files: [],
    missingRefs: []
  };
}

function getDefaultMdoTitle(uri: vscode.Uri): string {
  const base = path.basename(uri.fsPath || "", ".mdo");
  return base || "MDO Document";
}

async function parseMdoArchive(bytes: Uint8Array, workingDir: string, uri: vscode.Uri): Promise<LoadedMdoState> {
  const zip = await JSZip.loadAsync(bytes);

  const manifestFile = zip.file(MANIFEST_NAME);
  if (!manifestFile) {
    throw new Error("Invalid MDO: manifest.json not found");
  }

  const manifest = JSON.parse(await manifestFile.async("string")) as MdoManifest;
  const mainName = manifest.main || MAIN_MD_NAME;
  const mainFile = zip.file(mainName);

  if (!mainFile) {
    throw new Error(`Invalid MDO: ${mainName} not found`);
  }

  await fs.rm(workingDir, { recursive: true, force: true });
  await fs.mkdir(workingDir, { recursive: true });
  await extractZipToFolder(zip, workingDir);

  return {
    markdown: repairMarkdownImageLinkWrappers(await mainFile.async("string")),
    manifest,
    mainName
  };
}

async function saveMdoDocument(document: MdoCustomDocument, destination: vscode.Uri): Promise<MdoManifest> {
  const bytes = await buildMdoArchiveBytes(document);
  await fs.mkdir(path.dirname(destination.fsPath), { recursive: true });
  await fs.writeFile(destination.fsPath, bytes);
  return await buildManifestForDocument(document);
}

async function buildMdoArchiveBytes(document: MdoCustomDocument): Promise<Buffer> {
  const zip = new JSZip();
  const records = await collectArchiveRecords(document);
  const missingRefs = await collectMissingRefs(document);

  for (const record of records) {
    const filePath = path.join(document.workingDir, record.storedPath.split("/").join(path.sep));
    const data = await fs.readFile(filePath);
    zip.file(record.storedPath, data);
  }

  zip.file(document.mainName || MAIN_MD_NAME, document.markdown);

  const manifest = buildManifestFromRecords(document, records, missingRefs);
  zip.file(MANIFEST_NAME, JSON.stringify(manifest, null, 2));
  zip.file(
    METADATA_NAME,
    JSON.stringify(
      buildMdoMetadata({
        title: manifest.title,
        main: manifest.main,
        markdown: document.markdown,
        createdUnix: manifest.createdUnix,
        createdLocal: manifest.createdLocal,
        sourceUrl: manifest.sourceUrl,
        sourceMarkdown: manifest.sourceMarkdown,
        sourceKind: manifest.sourceMarkdown ? "markdown-import" : manifest.sourceUrl ? "browser-or-web" : "editor",
        files: records,
        missingRefs
      }),
      null,
      2
    )
  );

  return await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE"
  });
}

async function buildManifestForDocument(document: MdoCustomDocument): Promise<MdoManifest> {
  const records = await collectArchiveRecords(document);
  const missingRefs = await collectMissingRefs(document);
  return buildManifestFromRecords(document, records, missingRefs);
}

function buildManifestFromRecords(
  document: MdoCustomDocument,
  records: MdoFileRecord[],
  missingRefs: string[]
): MdoManifest {
  const createdUnix = document.manifest.createdUnix || Math.floor(Date.now() / 1000);
  const createdLocal = document.manifest.createdLocal || new Date(createdUnix * 1000).toLocaleString();
  return {
    format: "mdo",
    version: MDO_VERSION,
    createdUnix,
    createdLocal,
    title: document.manifest.title || getDefaultMdoTitle(document.uri),
    main: document.mainName || MAIN_MD_NAME,
    metadata: METADATA_NAME,
    sourceUrl: document.manifest.sourceUrl,
    sourceMarkdown: document.manifest.sourceMarkdown,
    files: records,
    missingRefs
  };
}

async function collectArchiveRecords(document: MdoCustomDocument): Promise<MdoFileRecord[]> {
  const files = await listWorkingFiles(document.workingDir);
  const referenced = collectNormalizedMarkdownRefs(document.markdown);
  const records: MdoFileRecord[] = [];

  for (const relPath of files) {
    if (relPath === MANIFEST_NAME || relPath === METADATA_NAME || relPath === document.mainName) {
      continue;
    }

    const abs = path.join(document.workingDir, relPath.split("/").join(path.sep));
    const data = await fs.readFile(abs);
    const stat = await fs.stat(abs);
    records.push({
      originalPath: abs,
      storedPath: relPath,
      originalName: path.basename(relPath),
      mime: guessMime(relPath),
      type: detectType(relPath),
      sizeBytes: stat.size,
      sha256: sha256(data),
      referencedInMarkdown: referenced.has(relPath)
    });
  }

  return records;
}

async function listWorkingFiles(rootDir: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(currentDir: string, relativeDir = ""): Promise<void> {
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const rel = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const abs = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }

  await walk(rootDir);
  return out;
}

function collectNormalizedMarkdownRefs(markdown: string): Set<string> {
  const refs = new Set<string>();
  for (const ref of collectMarkdownRefs(markdown)) {
    if (isExternalRef(ref)) {
      continue;
    }

    const normalized = normalizeArchiveRef(ref);
    if (normalized) {
      refs.add(normalized);
    }
  }

  return refs;
}

function repairMarkdownImageLinkWrappers(markdown: string): string {
  return collapseLinkedMediaWrappers(markdown);
}

function normalizeArchiveRef(ref: string): string {
  const clean = stripUrlSuffix(ref).replace(/\\/g, "/");
  const normalized = path.posix.normalize(clean);
  if (normalized === "." || normalized === "/") {
    return "";
  }

  return normalized.replace(/^\.\//, "").replace(/^\//, "");
}

async function collectMissingRefs(document: MdoCustomDocument): Promise<string[]> {
  const missing: string[] = [];
  const root = path.resolve(document.workingDir);

  for (const ref of collectMarkdownRefs(document.markdown)) {
    if (isExternalRef(ref)) {
      continue;
    }

    const normalized = normalizeArchiveRef(ref);
    if (!normalized) {
      continue;
    }

    const abs = path.resolve(document.workingDir, normalized.split("/").join(path.sep));
    const relative = path.relative(root, abs);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      missing.push(ref);
      continue;
    }

    try {
      await fs.stat(abs);
    } catch {
      missing.push(ref);
    }
  }

  return missing;
}

async function createMdoFromMarkdownCommand(uri?: vscode.Uri): Promise<void> {
  const mdUri = await getUriFromCommandOrDialog(uri, "Select Markdown file", {
    "Markdown files": ["md", "markdown", "txt"]
  });

  if (!mdUri) {
    return;
  }

  const defaultOutput = vscode.Uri.file(mdUri.fsPath.replace(/\.(md|markdown|txt)$/i, ".mdo"));

  const outputUri = await vscode.window.showSaveDialog({
    title: "Save MDO file",
    defaultUri: defaultOutput,
    filters: { "MDO files": ["mdo"] }
  });

  if (!outputUri) {
    return;
  }

  try {
    const manifest = await packMarkdownToMdo(mdUri.fsPath, outputUri.fsPath);
    const msg = `Created ${path.basename(outputUri.fsPath)} with ${manifest.files.length} packaged file(s).`;
    if (manifest.missingRefs.length > 0) {
      vscode.window.showWarningMessage(`${msg} Missing/skipped refs: ${manifest.missingRefs.length}`);
    } else {
      vscode.window.showInformationMessage(msg);
    }
  } catch (err: any) {
    vscode.window.showErrorMessage(`MDO create failed: ${err?.message || String(err)}`);
  }
}

async function createBlankMdoFileCommand(): Promise<void> {
  const target = await vscode.window.showSaveDialog({
    title: "Create New MDO File",
    filters: { "MDO files": ["mdo"] },
    saveLabel: "Create"
  });

  if (!target) {
    return;
  }

  try {
    try {
      const stat = await fs.stat(target.fsPath);
      if (stat.size > 0) {
        const choice = await vscode.window.showWarningMessage(
          `${path.basename(target.fsPath)} already exists. Overwrite it?`,
          { modal: true },
          "Overwrite"
        );
        if (choice !== "Overwrite") {
          return;
        }
      }
    } catch {
      // File does not exist yet.
    }

    await fs.writeFile(target.fsPath, "");
    await vscode.commands.executeCommand("vscode.openWith", target, MdoCustomEditorProvider.viewType);
  } catch (err: any) {
    vscode.window.showErrorMessage(`MDO create failed: ${err?.message || String(err)}`);
  }
}

async function extractMdoCommand(uri?: vscode.Uri): Promise<void> {
  const mdoUri = await getUriFromCommandOrDialog(uri, "Select MDO file", {
    "MDO files": ["mdo"]
  });

  if (!mdoUri) {
    return;
  }

  const folders = await vscode.window.showOpenDialog({
    title: "Select output folder",
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false
  });

  if (!folders || folders.length === 0) {
    return;
  }

  try {
    const outDir = path.join(folders[0].fsPath, path.basename(mdoUri.fsPath, ".mdo"));
    await fs.mkdir(outDir, { recursive: true });

    const bytes = await fs.readFile(mdoUri.fsPath);
    const zip = await JSZip.loadAsync(bytes);
    await extractZipToFolder(zip, outDir);

    vscode.window.showInformationMessage(`Extracted MDO to ${outDir}`);
  } catch (err: any) {
    vscode.window.showErrorMessage(`MDO extract failed: ${err?.message || String(err)}`);
  }
}

async function getUriFromCommandOrDialog(
  uri: vscode.Uri | undefined,
  title: string,
  filters: Record<string, string[]>
): Promise<vscode.Uri | undefined> {
  if (uri && uri.scheme === "file") {
    return uri;
  }

  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && active.scheme === "file") {
    const ext = path.extname(active.fsPath).replace(".", "").toLowerCase();
    const allowed = Object.values(filters).flat().map(x => x.toLowerCase());
    if (allowed.includes(ext)) {
      return active;
    }
  }

  const picked = await vscode.window.showOpenDialog({
    title,
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters
  });

  return picked?.[0];
}

async function packMarkdownToMdo(mdPath: string, outputPath: string): Promise<MdoManifest> {
  const mdAbs = path.resolve(mdPath);
  const mdDir = path.dirname(mdAbs);
  let mdText = await fs.readFile(mdAbs, "utf8");

  const refs = collectMarkdownRefs(mdText);
  const missingRefs: string[] = [];
  const refToFile = new Map<string, string>();

  for (const ref of refs) {
    if (isExternalRef(ref)) {
      continue;
    }

    const clean = stripUrlSuffix(ref);
    if (!clean) {
      continue;
    }

    const candidate = path.isAbsolute(clean) ? clean : path.resolve(mdDir, clean);

    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        refToFile.set(ref, candidate);
      }
    } catch {
      missingRefs.push(ref);
    }
  }

  const zip = new JSZip();
  const usedAssets = new Set<string>();
  const usedAttachments = new Set<string>();
  const fileToStored = new Map<string, string>();
  const records: MdoFileRecord[] = [];

  for (const [ref, filePath] of refToFile.entries()) {
    if (fileToStored.has(filePath)) {
      continue;
    }

    const ext = path.extname(filePath).toLowerCase();
    const folder = isMediaExt(ext) ? "assets" : "attachments";
    const used = folder === "assets" ? usedAssets : usedAttachments;
    const unique = uniqueName(path.basename(filePath), used);
    const storedPath = `${folder}/${unique}`;

    const data = await fs.readFile(filePath);
    zip.file(storedPath, data);

    const stat = await fs.stat(filePath);
    const record: MdoFileRecord = {
      originalPath: filePath,
      storedPath,
      originalName: path.basename(filePath),
      mime: guessMime(filePath),
      type: detectType(filePath),
      sizeBytes: stat.size,
      sha256: sha256(data),
      referencedInMarkdown: true
    };

    records.push(record);
    fileToStored.set(filePath, storedPath);
  }

  // Rewrite Markdown refs to internal package paths.
  // Sort longest first to reduce accidental partial replacement.
  const sortedRefs = [...refToFile.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [ref, filePath] of sortedRefs) {
    const stored = fileToStored.get(filePath);
    if (stored) {
      mdText = mdText.split(ref).join(stored);
    }
  }

  zip.file(MAIN_MD_NAME, mdText);

  const manifest: MdoManifest = {
    format: "mdo",
    version: MDO_VERSION,
    createdUnix: Math.floor(Date.now() / 1000),
    createdLocal: new Date().toLocaleString(),
    title: path.basename(mdAbs, path.extname(mdAbs)),
    main: MAIN_MD_NAME,
    metadata: METADATA_NAME,
    sourceMarkdown: mdAbs,
    files: records,
    missingRefs
  };

  zip.file(MANIFEST_NAME, JSON.stringify(manifest, null, 2));

  const outBytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE"
  });

  await fs.writeFile(outputPath, outBytes);
  return manifest;
}

function collectMarkdownRefs(mdText: string): string[] {
  const refs: string[] = [];

  const imgRe = /!\[[^\]]*\]\(([^)]+)\)/g;
  const linkRe = /(?<!!)\[[^\]]+\]\(([^)]+)\)/g;
  const htmlRe = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;

  let m: RegExpExecArray | null;

  while ((m = imgRe.exec(mdText)) !== null) {
    refs.push(m[1].trim());
  }

  while ((m = linkRe.exec(mdText)) !== null) {
    refs.push(m[1].trim());
  }

  while ((m = htmlRe.exec(mdText)) !== null) {
    refs.push(m[1].trim());
  }

  return refs;
}

function isExternalRef(ref: string): boolean {
  const lower = ref.trim().toLowerCase();

  if (!lower || lower.startsWith("#")) {
    return true;
  }

  return (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("data:") ||
    lower.startsWith("mailto:") ||
    lower.startsWith("tel:") ||
    lower.startsWith("ftp://")
  );
}

function stripUrlSuffix(ref: string): string {
  return normalizeMediaReference(ref);
}

async function cacheExternalMediaUrl(url: string, extractDir: string): Promise<string | null> {
  const resolved = normalizePreviewMediaUrl(url);
  if (!resolved) {
    return null;
  }

  const candidates = [resolved, normalizeMediaReference(resolved)];
  let response: Response | null = null;

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    try {
      const attempt = await fetch(candidate);
      if (attempt.ok) {
        response = attempt;
        break;
      }
    } catch {
      // Try the next candidate.
    }
  }

  if (!response) {
    return null;
  }

  const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!contentType.startsWith("image/") && !contentType.startsWith("video/") && !contentType.startsWith("audio/")) {
    return null;
  }

  const cacheRoot = path.join(extractDir, ".mdo-cache");
  await fs.mkdir(cacheRoot, { recursive: true });

  const ext = path.extname(stripUrlSuffix(resolved)).toLowerCase() || mimeToExtension(contentType);
  const hash = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 16);
  const fileName = `${hash}${ext || ""}`;
  const filePath = path.join(cacheRoot, fileName);

  try {
    await fs.access(filePath);
    return filePath;
  } catch {
    const bytes = new Uint8Array(await response.arrayBuffer());
    await fs.writeFile(filePath, bytes);
    return filePath;
  }
}

function normalizePreviewMediaUrl(ref: string): string {
  const clean = stripUrlSuffix(ref);
  const httpsIndex = clean.lastIndexOf("https://");
  const httpIndex = clean.lastIndexOf("http://");
  const embeddedIndex = Math.max(httpsIndex, httpIndex);
  if (embeddedIndex >= 0) {
    return normalizeMediaReference(clean.slice(embeddedIndex));
  }

  return clean;
}

function mimeToExtension(mime: string): string {
  const table: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpeg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/mp4": ".m4a"
  };

  return table[mime] || "";
}

function isMediaExt(ext: string): boolean {
  return IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext) || AUDIO_EXTS.has(ext);
}

function detectType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();

  if (IMAGE_EXTS.has(ext)) {
    return "image";
  }
  if (VIDEO_EXTS.has(ext)) {
    return "video";
  }
  if (AUDIO_EXTS.has(ext)) {
    return "audio";
  }
  if (PDF_EXTS.has(ext)) {
    return "pdf";
  }
  return "attachment";
}

function guessMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();

  const table: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".m4v": "video/x-m4v",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
    ".ogv": "video/ogg",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".flac": "audio/flac",
    ".aac": "audio/aac",
    ".pdf": "application/pdf",
    ".csv": "text/csv",
    ".json": "application/json",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".stl": "model/stl",
    ".obj": "model/obj",
    ".ply": "application/octet-stream"
  };

  return table[ext] || "application/octet-stream";
}

function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }

  const ext = path.extname(name);
  const stem = path.basename(name, ext);

  let i = 2;
  while (true) {
    const candidate = `${stem}_${i}${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    i += 1;
  }
}

function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function extractZipToTempDir(zip: JSZip, sourcePath: string): Promise<string> {
  const base = path.join(
    os.tmpdir(),
    "vscode-mdo",
    `${path.basename(sourcePath, ".mdo")}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );

  await fs.mkdir(base, { recursive: true });
  await extractZipToFolder(zip, base);
  return base;
}

async function extractZipToFolder(zip: JSZip, outputDir: string): Promise<void> {
  const entries = Object.values(zip.files);

  for (const entry of entries) {
    const dest = safeJoin(outputDir, entry.name);
    if (entry.dir) {
      await fs.mkdir(dest, { recursive: true });
      continue;
    }

    await fs.mkdir(path.dirname(dest), { recursive: true });
    const data = await entry.async("nodebuffer");
    await fs.writeFile(dest, data);
  }
}

function safeJoin(base: string, target: string): string {
  const targetPath = path.resolve(base, target);
  const basePath = path.resolve(base);

  const relative = path.relative(basePath, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe zip path blocked: ${target}`);
  }

  return targetPath;
}

async function openPreviewLink(document: MdoCustomDocument, href: string): Promise<void> {
  const target = href.trim();
  if (!target) {
    return;
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    await vscode.env.openExternal(vscode.Uri.parse(target, true));
    return;
  }

  const filePath = safeJoin(document.workingDir, stripUrlSuffix(target));
  await vscode.env.openExternal(vscode.Uri.file(filePath));
}

async function buildPreviewHtml(
  webview: vscode.Webview,
  extractDir: string,
  mdText: string
): Promise<string> {
  const transformed = await markdownLinksToEmbeds(mdText, extractDir);
  let body = await marked.parse(transformed, {
    gfm: true,
    breaks: false
  });

  body = await rewriteHtmlResourceUrls(webview, extractDir, body);

  return `<main class="mdo-preview">
${body}
</main>`;
}


async function markdownLinksToEmbeds(mdText: string, extractDir: string): Promise<string> {
  const linkRe = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;
  const replacements: Array<{ full: string; replacement: string }> = [];

  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(mdText)) !== null) {
    const full = match[0];
    const label = match[1];
    const ref = match[2].trim();
    const clean = stripUrlSuffix(ref);
    const ext = path.extname(clean).toLowerCase();

    if (VIDEO_EXTS.has(ext)) {
      replacements.push({
        full,
        replacement: `<figure class="media-block"><video controls preload="metadata" src="${escapeAttr(ref)}"></video><figcaption>${escapeHtml(label)}</figcaption></figure>`
      });
      continue;
    }

    if (AUDIO_EXTS.has(ext)) {
      replacements.push({
        full,
        replacement: `<figure class="media-block"><audio controls preload="metadata" src="${escapeAttr(ref)}"></audio><figcaption>${escapeHtml(label)}</figcaption></figure>`
      });
      continue;
    }

    if (ext === ".csv") {
      try {
        const csvPath = safeJoin(extractDir, clean);
        const csvText = await fs.readFile(csvPath, "utf8");
        replacements.push({
          full,
          replacement: renderCsvMarkdownBlock(label, ref, csvText)
        });
      } catch {
        replacements.push({
          full,
          replacement: `[${label}](${ref})`
        });
      }
      continue;
    }

    if (ext === ".json") {
      try {
        const jsonPath = safeJoin(extractDir, clean);
        const jsonText = await fs.readFile(jsonPath, "utf8");
        const pretty = JSON.stringify(JSON.parse(jsonText), null, 2);
        replacements.push({
          full,
          replacement: `<details class="attachment-preview" open><summary>${escapeHtml(label)} JSON</summary><pre><code>${escapeHtml(pretty)}</code></pre><p><a href="${escapeAttr(ref)}">Open original file</a></p></details>`
        });
      } catch {
        replacements.push({
          full,
          replacement: `[${label}](${ref})`
        });
      }
      continue;
    }

    if (ext === ".txt" || ext === ".log" || ext === ".py" || ext === ".js" || ext === ".ts" || ext === ".html" || ext === ".css") {
      try {
        const filePath = safeJoin(extractDir, clean);
        const fileText = await fs.readFile(filePath, "utf8");
        const limited = limitText(fileText, 20000);
        replacements.push({
          full,
          replacement: `<details class="attachment-preview"><summary>${escapeHtml(label)} text preview</summary><pre><code>${escapeHtml(limited)}</code></pre><p><a href="${escapeAttr(ref)}">Open original file</a></p></details>`
        });
      } catch {
        replacements.push({
          full,
          replacement: `[${label}](${ref})`
        });
      }
      continue;
    }
  }

  let out = mdText;
  for (const r of replacements) {
    out = out.split(r.full).join(r.replacement);
  }

  return out;
}

function renderCsvMarkdownBlock(label: string, ref: string, csvText: string): string {
  const rows = parseCsv(csvText);
  const maxRows = 200;
  const shownRows = rows.slice(0, maxRows);

  if (shownRows.length === 0) {
    return `<details class="attachment-preview" open><summary>${escapeHtml(label)} CSV</summary><p>CSV is empty.</p><p><a href="${escapeAttr(ref)}">Open original file</a></p></details>`;
  }

  const header = shownRows[0];
  const bodyRows = shownRows.slice(1);

  const thead = `<thead><tr>${header.map(cell => `<th>${escapeHtml(cell)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${bodyRows.map(row => {
    const cells = normalizeCsvRow(row, header.length);
    return `<tr>${cells.map(cell => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`;
  }).join("")}</tbody>`;

  const clippedNotice = rows.length > maxRows
    ? `<p class="preview-note">Showing first ${maxRows} rows of ${rows.length}. Open the original file to view everything.</p>`
    : "";

  return `<details class="attachment-preview csv-preview" open>
<summary>${escapeHtml(label)} CSV preview</summary>
<div class="table-wrap"><table>${thead}${tbody}</table></div>
${clippedNotice}
<p><a href="${escapeAttr(ref)}">Open original CSV</a></p>
</details>`;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") {
        i++;
      }
      row.push(cell);
      if (row.some(x => x.length > 0)) {
        rows.push(row);
      }
      row = [];
      cell = "";
      continue;
    }

    cell += ch;
  }

  row.push(cell);
  if (row.some(x => x.length > 0)) {
    rows.push(row);
  }

  return rows;
}

function normalizeCsvRow(row: string[], n: number): string[] {
  const out = row.slice(0, n);
  while (out.length < n) {
    out.push("");
  }
  return out;
}

function limitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars) + `\n\n... clipped preview, original file is larger ...`;
}

async function rewriteHtmlResourceUrls(webview: vscode.Webview, extractDir: string, htmlText: string): Promise<string> {
  const attrRe = /\b(src|href)=["']([^"']+)["']/gi;
  const replacements: Array<{ full: string; replacement: string }> = [];

  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(htmlText)) !== null) {
    const full = match[0];
    const attr = match[1];
    const url = match[2];

    if (isExternalRef(url)) {
      if (attr === "src") {
        const cachedPath = await cacheExternalMediaUrl(url, extractDir);
        if (cachedPath) {
          const webviewUri = webview.asWebviewUri(vscode.Uri.file(cachedPath));
          replacements.push({
            full,
            replacement: `${attr}="${webviewUri}"`
          });
        }
      }
      continue;
    }

    const clean = stripUrlSuffix(url);
    let fullPath: string;
    try {
      fullPath = safeJoin(extractDir, clean);
    } catch {
      continue;
    }

    const webviewUri = webview.asWebviewUri(vscode.Uri.file(fullPath));
    replacements.push({
      full,
      replacement: `${attr}="${webviewUri}"`
    });
  }

  let out = htmlText;
  for (const replacement of replacements) {
    out = out.split(replacement.full).join(replacement.replacement);
  }

  return out;
}

function getNonce(): string {
  return crypto.randomBytes(16).toString("base64");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

function serializeForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function errorHtml(message: string): string {
  return `<!doctype html>
<html>
<body>
<h2>MDO preview error</h2>
<pre>${escapeHtml(message)}</pre>
</body>
</html>`;
}
