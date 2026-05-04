import JSZip from "jszip";
import { buildMdoMetadata, MDO_METADATA_NAME } from "../../src/shared/mdoMetadata";
import { normalizeMediaReference } from "../../src/shared/mediaUrl";

type ResourceKind = "image" | "video" | "audio" | "attachment";

type ResourceSpec = {
  id: string;
  url: string;
  kind: ResourceKind;
  filename: string;
  mime: string;
};

type CaptureSnapshot = {
  kind: "webpage";
  title: string;
  sourceUrl: string;
  markdown: string;
  resources: ResourceSpec[];
};

type PdfSnapshot = {
  kind: "pdf";
  title: string;
  sourceUrl: string;
  pdfBytes: Uint8Array;
  pdfFilename: string;
};

type PdfPageCapture = {
  pageNumber: number;
  textMarkdown: string;
  links: string[];
  image?: {
    bytes: Uint8Array;
    name: string;
    mime: string;
  };
};

type CaptureResponse =
  | {
    ok: true;
    snapshot: CaptureSnapshot;
  }
  | {
    ok: false;
    error: string;
  };

type CaptureResult =
  | CaptureSnapshot
  | PdfSnapshot;

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
  files: MdoFileRecord[];
  missingRefs: string[];
};

const MDO_VERSION = "0.1";
const MAIN_MD_NAME = "document.md";
const MANIFEST_NAME = "manifest.json";
const METADATA_NAME = MDO_METADATA_NAME;
const PLACEHOLDER_PREFIX = "mdo-resource://";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".bmp", ".tiff", ".tif"]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv", ".ogv"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"]);
const ATTACHMENT_EXTS = new Set([".pdf", ".csv", ".json", ".txt", ".md", ".zip", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"]);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "mdo:capture-active-tab") {
    return;
  }

  void handleCaptureActiveTab()
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err: any) => sendResponse({ ok: false, error: err?.message || String(err) }));

  return true;
});

async function handleCaptureActiveTab(): Promise<{ filename: string; manifest: MdoManifest }> {
  const tab = await getActiveTab();
  if (!tab.id) {
    throw new Error("No active tab found.");
  }

  const snapshot = await captureTab(tab);
  const { blob, manifest } = await buildMdoArchive(snapshot);
  const filename = sanitizeFilename(snapshot.title || "captured-page") + ".mdo";
  await downloadBlob(blob, filename);
  return { filename, manifest };
}

async function captureTab(tab: chrome.tabs.Tab): Promise<CaptureResult> {
  const pdfUrl = getPdfSourceUrl(tab);
  if (pdfUrl) {
    return await capturePdfTab(tab, pdfUrl);
  }

  if (typeof tab.id !== "number") {
    throw new Error("No active tab found.");
  }

  const firstAttempt = await captureSnapshotFromTab(tab.id);
  if (firstAttempt) {
    return firstAttempt;
  }

  try {
    await ensureCaptureContentScript(tab.id);
  } catch {
    // Ignore injection failures here. A direct message retry still gives us a chance
    // to reuse an already-present listener on tabs where the content script is loaded.
  }

  const retry = await captureSnapshotFromTab(tab.id);
  if (retry) {
    return retry;
  }

  throw new Error("The current tab could not be captured. Reload the page and try again, or open a direct PDF URL.");
}

async function capturePdfTab(tab: chrome.tabs.Tab, sourceUrl: string): Promise<PdfSnapshot> {
  const title = sanitizeTitle(tab.title || sourceUrl);
  const pdfFilename = inferPdfFilename(sourceUrl, title);
  const response = await fetch(sourceUrl, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Failed to fetch PDF: ${response.status} ${response.statusText}`);
  }

  const pdfBytes = new Uint8Array(await response.arrayBuffer());
  return {
    kind: "pdf",
    title,
    sourceUrl,
    pdfBytes,
    pdfFilename
  };
}

async function captureSnapshotFromTab(tabId: number): Promise<CaptureSnapshot | null> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "mdo:capture" });
    if (response?.ok && response.snapshot) {
      return response.snapshot as CaptureSnapshot;
    }
  } catch {
    // The content script is absent or not yet ready.
  }

  return null;
}

async function ensureCaptureContentScript(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["dist/content.js"]
  });
}

function getPdfSourceUrl(tab: chrome.tabs.Tab): string {
  const candidates = [tab.url || "", tab.pendingUrl || ""];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    if (looksLikePdf(candidate)) {
      return candidate;
    }

    const viewerPdf = extractPdfViewerSource(candidate);
    if (viewerPdf) {
      return viewerPdf;
    }
  }

  return "";
}

function extractPdfViewerSource(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const isChromePdfViewer = host === "mhjfbmdgcfjbbpaeojofohoefgiehjai" || host === "pdf-viewer";
    if (!isChromePdfViewer) {
      return "";
    }

    const raw = parsed.searchParams.get("file") || parsed.searchParams.get("url") || parsed.searchParams.get("src") || "";
    if (!raw) {
      return "";
    }

    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  } catch {
    return "";
  }
}

async function buildMdoArchive(snapshot: CaptureResult): Promise<{ blob: Blob; manifest: MdoManifest }> {
  if (snapshot.kind === "pdf") {
    return await buildPdfArchive(snapshot);
  }

  return await buildWebpageArchive(snapshot);
}

async function buildWebpageArchive(snapshot: CaptureSnapshot): Promise<{ blob: Blob; manifest: MdoManifest }> {
  const zip = new JSZip();
  const records: MdoFileRecord[] = [];
  const missingRefs: string[] = [];
  const usedAssets = new Set<string>();
  const usedAttachments = new Set<string>();
  const placeholderToPath = new Map<string, string>();

  for (const resource of snapshot.resources) {
    const folder = pickStorageFolder(resource.kind);
    const used = folder === "assets" ? usedAssets : usedAttachments;
    const storedName = uniqueName(sanitizeFilename(resource.filename), used);
    const storedPath = `${folder}/${storedName}`;
    const placeholder = `${PLACEHOLDER_PREFIX}${resource.id}`;

    try {
      const bytes = await fetchResourceBytes(resource.url);
      zip.file(storedPath, bytes);

      const record: MdoFileRecord = {
        originalPath: resource.url,
        storedPath,
        originalName: resource.filename,
        mime: resource.mime || guessMime(resource.filename),
        type: detectType(resource.filename),
        sizeBytes: bytes.byteLength,
        sha256: await sha256(bytes),
        referencedInMarkdown: true
      };

      records.push(record);
      placeholderToPath.set(placeholder, storedPath);
    } catch {
      missingRefs.push(resource.url);
      placeholderToPath.set(placeholder, resource.url);
    }
  }

  const markdown = buildWebpageDocument(snapshot, rewritePlaceholders(snapshot.markdown, placeholderToPath));
  zip.file(MAIN_MD_NAME, markdown);

  const manifest: MdoManifest = {
    format: "mdo",
    version: MDO_VERSION,
    createdUnix: Math.floor(Date.now() / 1000),
    createdLocal: new Date().toLocaleString(),
    title: snapshot.title,
    main: MAIN_MD_NAME,
    metadata: METADATA_NAME,
    sourceUrl: snapshot.sourceUrl,
    files: records,
    missingRefs
  };

  zip.file(MANIFEST_NAME, JSON.stringify(manifest, null, 2));
  zip.file(
    METADATA_NAME,
    JSON.stringify(
      buildMdoMetadata({
        title: snapshot.title,
        main: MAIN_MD_NAME,
        markdown,
        createdUnix: manifest.createdUnix,
        createdLocal: manifest.createdLocal,
        sourceUrl: snapshot.sourceUrl,
        sourceKind: "browser-webpage",
        files: records,
        missingRefs
      }),
      null,
      2
    )
  );

  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return { blob: new Blob([bytes], { type: "application/x-mdo" }), manifest };
}

async function buildPdfArchive(snapshot: PdfSnapshot): Promise<{ blob: Blob; manifest: MdoManifest }> {
  const zip = new JSZip();
  const usedAssets = new Set<string>();
  const usedAttachments = new Set<string>();
  const records: MdoFileRecord[] = [];
  const markdownParts: string[] = [];

  const storedName = uniqueName(sanitizeFilename(snapshot.pdfFilename), usedAttachments);
  const storedPath = `attachments/${storedName}`;
  zip.file(storedPath, snapshot.pdfBytes);
  records.push({
    originalPath: snapshot.sourceUrl,
    storedPath,
    originalName: snapshot.pdfFilename,
    mime: "application/pdf",
    type: "pdf",
    sizeBytes: snapshot.pdfBytes.byteLength,
    sha256: await sha256(snapshot.pdfBytes),
    referencedInMarkdown: true
  });

  markdownParts.push(
    `# ${escapeMarkdownInline(snapshot.title)}`,
    "",
    `Source: <${snapshot.sourceUrl}>`,
    "",
    `Original PDF: [${escapeMarkdownInline(snapshot.pdfFilename)}](${storedPath})`,
    ""
  );

  let extractedPages: PdfPageCapture[] = [];
  try {
    extractedPages = await extractPdfPages(snapshot.pdfBytes);
  } catch (err: any) {
    markdownParts.push("_PDF text extraction failed. The original PDF is still packaged in this MDO._");
    if (err?.message) {
      markdownParts.push("");
      markdownParts.push(`_Extraction error: ${escapeMarkdownInline(err.message)}_`);
    }
    markdownParts.push("");
  }
  for (const page of extractedPages) {
    markdownParts.push(`## Page ${page.pageNumber}`);
    markdownParts.push("");

    if (page.image) {
      const storedName = uniqueName(sanitizeFilename(page.image.name), usedAssets);
      const storedPath = `assets/${storedName}`;
      zip.file(storedPath, page.image.bytes);
      records.push({
        originalPath: `${snapshot.sourceUrl}#page=${page.pageNumber}`,
        storedPath,
        originalName: page.image.name,
        mime: page.image.mime,
        type: "image",
        sizeBytes: page.image.bytes.byteLength,
        sha256: await sha256(page.image.bytes),
        referencedInMarkdown: true
      });
      markdownParts.push(`![Page ${page.pageNumber}](${storedPath})`);
      markdownParts.push("");
    }

    if (page.textMarkdown) {
      markdownParts.push(page.textMarkdown);
      markdownParts.push("");
    } else {
      markdownParts.push("_No extractable text found on this page._");
      markdownParts.push("");
    }

    if (page.links.length > 0) {
      markdownParts.push("Links:");
      for (const link of page.links) {
        markdownParts.push(`- <${link}>`);
      }
      markdownParts.push("");
    }
  }

  const markdown = markdownParts.join("\n").trim();
  zip.file(MAIN_MD_NAME, markdown);

  const manifest: MdoManifest = {
    format: "mdo",
    version: MDO_VERSION,
    createdUnix: Math.floor(Date.now() / 1000),
    createdLocal: new Date().toLocaleString(),
    title: snapshot.title,
    main: MAIN_MD_NAME,
    metadata: METADATA_NAME,
    sourceUrl: snapshot.sourceUrl,
    files: records,
    missingRefs: []
  };

  zip.file(MANIFEST_NAME, JSON.stringify(manifest, null, 2));
  zip.file(
    METADATA_NAME,
    JSON.stringify(
      buildMdoMetadata({
        title: snapshot.title,
        main: MAIN_MD_NAME,
        markdown,
        createdUnix: manifest.createdUnix,
        createdLocal: manifest.createdLocal,
        sourceUrl: snapshot.sourceUrl,
        sourceKind: "browser-pdf",
        files: records,
        missingRefs: []
      }),
      null,
      2
    )
  );

  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return { blob: new Blob([bytes], { type: "application/x-mdo" }), manifest };
}

function buildWebpageDocument(snapshot: CaptureSnapshot, fragmentMarkdown: string): string {
  return [
    `# ${escapeMarkdownInline(snapshot.title)}`,
    "",
    `Source: <${snapshot.sourceUrl}>`,
    "",
    fragmentMarkdown.trim()
  ].join("\n");
}

async function extractPdfPages(pdfBytes: Uint8Array): Promise<PdfPageCapture[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: pdfBytes,
    disableWorker: true,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0
  });

  const pdf = await loadingTask.promise;
  const pages: PdfPageCapture[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      try {
        const page = await pdf.getPage(pageNumber);
        try {
          const textContent = await page.getTextContent();
          const textMarkdown = pdfTextContentToMarkdown(textContent);
          const links = await extractPdfPageLinks(page);
          const image = await renderPdfPageImage(page, pageNumber);

          pages.push({
            pageNumber,
            textMarkdown,
            links,
            image: image
              ? {
                bytes: image.bytes,
                name: image.name,
                mime: image.mime
              }
              : undefined
          });
        } finally {
          page.cleanup();
        }
      } catch {
        pages.push({
          pageNumber,
          textMarkdown: "",
          links: []
        });
      }
    }
  } finally {
    pdf.cleanup();
    await pdf.destroy();
  }

  return pages;
}

function pdfTextContentToMarkdown(textContent: { items: Array<{ str?: string; hasEOL?: boolean }> }): string {
  const lines: string[] = [];
  let currentLine = "";

  for (const item of textContent.items) {
    const text = normalizePdfText(item.str || "");
    if (!text) {
      if (item.hasEOL && currentLine.trim()) {
        lines.push(currentLine.trim());
        currentLine = "";
      }
      continue;
    }

    currentLine += (currentLine ? " " : "") + text;
    if (item.hasEOL) {
      lines.push(currentLine.trim());
      currentLine = "";
    }
  }

  if (currentLine.trim()) {
    lines.push(currentLine.trim());
  }

  return lines
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

function normalizePdfText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function extractPdfPageLinks(page: any): Promise<string[]> {
  try {
    const annotations = await page.getAnnotations({ intent: "display" });
    const links = annotations
      .map((annotation: any) => annotation.url || annotation.unsafeUrl || "")
      .map((url: string) => {
        try {
          return new URL(url).href;
        } catch {
          return "";
        }
      })
      .filter(Boolean);

    return uniqueStrings(links);
  } catch {
    return [];
  }
}

async function renderPdfPageImage(
  page: any,
  pageNumber: number
): Promise<{ bytes: Uint8Array; name: string; mime: string } | null> {
  if (typeof OffscreenCanvas !== "function") {
    return null;
  }

  try {
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }

    await page.render({
      canvasContext: context,
      viewport
    }).promise;

    const blob = await canvas.convertToBlob({ type: "image/png" });
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      name: `page-${String(pageNumber).padStart(3, "0")}.png`,
      mime: "image/png"
    };
  } catch {
    return null;
  }
}

function rewritePlaceholders(fragmentHtml: string, placeholderToPath: Map<string, string>): string {
  let out = fragmentHtml;
  const sortedPlaceholders = [...placeholderToPath.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [placeholder, path] of sortedPlaceholders) {
    out = out.split(placeholder).join(path);
  }
  return out;
}

async function fetchResourceBytes(url: string): Promise<Uint8Array> {
  const normalized = normalizeResourceUrl(url);
  const candidates = uniqueStrings([url, normalized, normalizeMediaReference(normalized)]);

  let lastError = "";
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, { credentials: "include" });
      if (!response.ok) {
        lastError = `Failed to fetch resource: ${response.status} ${response.statusText}`;
        continue;
      }

      return new Uint8Array(await response.arrayBuffer());
    } catch (err: any) {
      lastError = err?.message || String(err);
    }
  }

  throw new Error(lastError || `Failed to fetch resource: ${url}`);
}

async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  const downloadUrl = await createDownloadUrl(blob);
  try {
    await chrome.downloads.download({
      url: downloadUrl,
      filename,
      saveAs: false
    });
  } finally {
    if (downloadUrl.startsWith("blob:")) {
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 60_000);
    }
  }
}

async function createDownloadUrl(blob: Blob): Promise<string> {
  if (typeof URL.createObjectURL === "function") {
    return URL.createObjectURL(blob);
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `data:application/x-mdo;base64,${bytesToBase64(bytes)}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab) {
    throw new Error("No active tab found.");
  }

  return tab;
}

function looksLikePdf(url: string): boolean {
  return /\.pdf([?#].*)?$/i.test(url);
}

function sanitizeTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim() || "Captured page";
}

function sanitizeFilename(value: string): string {
  return sanitizeTitle(value)
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "captured-page";
}

function inferPdfFilename(url: string, title: string): string {
  try {
    const parsed = new URL(url);
    const decodedPath = decodeURIComponent(parsed.pathname);
    const base = decodedPath.split("/").filter(Boolean).pop() || "";
    if (base.toLowerCase().endsWith(".pdf")) {
      return base;
    }
  } catch {
    // fall through
  }

  return `${sanitizeFilename(title)}.pdf`;
}

function pickStorageFolder(kind: ResourceKind): "assets" | "attachments" {
  return kind === "image" || kind === "video" || kind === "audio" ? "assets" : "attachments";
}

function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }

  const dot = name.lastIndexOf(".");
  const stem = dot >= 0 ? name.slice(0, dot) : name;
  const ext = dot >= 0 ? name.slice(dot) : "";
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

function detectType(fileName: string): string {
  const ext = getExtension(fileName);
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (ext === ".pdf") return "pdf";
  return "attachment";
}

function guessMime(fileName: string): string {
  const ext = getExtension(fileName);
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
    ".md": "text/markdown"
  };

  return table[ext] || "application/octet-stream";
}

function getExtension(fileName: string): string {
  const clean = normalizeMediaReference(fileName.toLowerCase());
  const dot = clean.lastIndexOf(".");
  return dot >= 0 ? clean.slice(dot) : "";
}

function escapeMarkdownInline(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-.!>])/g, "\\$1");
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeResourceUrl(ref: string): string {
  let clean = ref.trim();

  const hashIndex = clean.indexOf("#");
  if (hashIndex >= 0) {
    clean = clean.slice(0, hashIndex);
  }

  const queryIndex = clean.indexOf("?");
  if (queryIndex >= 0) {
    clean = clean.slice(0, queryIndex);
  }

  try {
    clean = decodeURIComponent(clean);
  } catch {
    // keep original if decoding fails
  }

  const httpsIndex = clean.lastIndexOf("https://");
  const httpIndex = clean.lastIndexOf("http://");
  const embeddedIndex = Math.max(httpsIndex, httpIndex);
  if (embeddedIndex >= 0) {
    clean = clean.slice(embeddedIndex);
  }

  return normalizeMediaReference(clean);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
