import TurndownService from "turndown";
import { normalizeRemoteMediaUrl, stripSyntheticMediaVariantSuffix } from "../../src/shared/mediaUrl";
import { collapseLinkedMediaWrappers } from "../../src/shared/markdownCleanup";

type CaptureMode = "selection" | "article" | "full";
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
  captureModeUsed: CaptureMode;
  title: string;
  sourceUrl: string;
  markdown: string;
  resources: ResourceSpec[];
};

type CaptureRequest = {
  type: "mdo:capture";
  captureMode?: CaptureMode;
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

const PLACEHOLDER_PREFIX = "mdo-resource://";
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".bmp", ".tiff", ".tif"]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv", ".ogv"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"]);
const ATTACHMENT_EXTS = new Set([".pdf", ".csv", ".json", ".txt", ".md", ".zip", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"]);

type GenericElement = HTMLElement;

function isGenericElement(node: Node): node is GenericElement {
  return node instanceof HTMLElement;
}

type MdoCaptureGlobal = typeof globalThis & {
  __mdoCaptureListenerInstalled?: boolean;
};

const captureGlobal = globalThis as MdoCaptureGlobal;

if (!captureGlobal.__mdoCaptureListenerInstalled) {
  captureGlobal.__mdoCaptureListenerInstalled = true;

  chrome.runtime.onMessage.addListener((message: CaptureRequest, _sender, sendResponse) => {
    if (!message || message.type !== "mdo:capture") {
      return;
    }

    Promise.resolve()
      .then(() => captureSnapshot(message.captureMode || "article"))
      .then((snapshot) => sendResponse({ ok: true, snapshot } satisfies CaptureResponse))
      .catch((err: any) => sendResponse({ ok: false, error: err?.message || String(err) } satisfies CaptureResponse));

    return true;
  });
}

function captureSnapshot(captureMode: CaptureMode): CaptureSnapshot {
  const { root, captureModeUsed } = selectCaptureRoot(captureMode);
  const clone = root.cloneNode(true) as HTMLElement;
  const resources: ResourceSpec[] = [];
  const seen = new Set<string>();
  let seq = 0;

  convertCanvasesToImages(clone);
  removeNoiseNodes(clone);
  rewriteCapturedResources(clone, (url, kind, filenameHint) => {
    const cleaned = normalizeCapturedUrl(url);
    if (!cleaned || isIgnoredScheme(cleaned)) {
      return null;
    }

    if (seen.has(cleaned)) {
      const existing = resources.find((resource) => resource.url === cleaned);
      return existing ? `${PLACEHOLDER_PREFIX}${existing.id}` : null;
    }

    const id = `r${seq += 1}`;
    const filename = uniqueFilename(filenameHint || inferFilename(cleaned, kind), resources);
    resources.push({
      id,
      url: cleaned,
      kind,
      filename,
      mime: guessMime(filename)
    });
    seen.add(cleaned);
    return `${PLACEHOLDER_PREFIX}${id}`;
  });

  const fragmentHtml = getCaptureFragmentHtml(clone, captureModeUsed);
  const markdown = htmlToMarkdown(fragmentHtml);
  return {
    kind: "webpage",
    captureModeUsed,
    title: document.title || location.hostname || "Captured page",
    sourceUrl: location.href,
    markdown,
    resources
  };
}

function selectCaptureRoot(captureMode: CaptureMode): { root: HTMLElement; captureModeUsed: CaptureMode } {
  if (captureMode === "selection") {
    const selectionRoot = buildSelectionRoot();
    if (selectionRoot) {
      return {
        root: selectionRoot,
        captureModeUsed: "selection"
      };
    }

    captureMode = "article";
  }

  if (captureMode === "full") {
    return {
      root: document.body || document.documentElement,
      captureModeUsed: "full"
    };
  }

  return {
    root: selectArticleRoot(),
    captureModeUsed: "article"
  };
}

function selectArticleRoot(): HTMLElement {
  const candidates = [
    document.querySelector("article"),
    document.querySelector("main"),
    document.querySelector('[role="main"]'),
    document.body
  ].filter(Boolean) as HTMLElement[];

  if (candidates.length > 0) {
    return candidates[0];
  }

  return document.documentElement;
}

function buildSelectionRoot(): HTMLElement | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  const container = document.createElement("div");
  for (let i = 0; i < selection.rangeCount; i += 1) {
    const fragment = selection.getRangeAt(i).cloneContents();
    if (!fragment.hasChildNodes()) {
      continue;
    }

    container.append(fragment);
  }

  const text = container.textContent?.replace(/\s+/g, " ").trim() || "";
  if (!text && !container.querySelector("img, video, audio, a, svg, table, figure, pre, code")) {
    return null;
  }

  return container;
}

function getCaptureFragmentHtml(root: HTMLElement, captureModeUsed: CaptureMode): string {
  if (captureModeUsed === "selection") {
    return root.innerHTML;
  }

  return root.tagName.toLowerCase() === "body" ? root.innerHTML : root.outerHTML;
}

function removeNoiseNodes(root: HTMLElement): void {
  const selectors = [
    "script",
    "style",
    "noscript",
    "template",
    "canvas",
    "form",
    "input",
    "textarea",
    "select",
    "button",
    "object",
    "embed",
    "link",
    "meta",
    "[hidden]"
  ];

  root.querySelectorAll(selectors.join(",")).forEach((el) => el.remove());

  root.querySelectorAll("[aria-hidden='true']").forEach((el) => {
    if (!el.querySelector("img, video, audio, svg")) {
      el.remove();
    }
  });
}

function convertCanvasesToImages(root: HTMLElement): void {
  root.querySelectorAll("canvas").forEach((canvas) => {
    try {
      const dataUrl = canvas.toDataURL("image/png");
      if (dataUrl.length > 300) {
        const img = document.createElement("img");
        img.src = dataUrl;
        img.alt = canvas.getAttribute("aria-label") || canvas.getAttribute("title") || "Converted canvas image";
        canvas.replaceWith(img);
      }
    } catch {
      // Cross-origin or tainted canvas cannot be exported
    }
  });
}

function rewriteCapturedResources(
  root: HTMLElement,
  register: (url: string, kind: ResourceKind, filenameHint: string) => string | null
): void {
  root.querySelectorAll("img, video, audio, a[href], iframe").forEach((node) => {
    if (!(node instanceof HTMLElement)) {
      return;
    }

    if (node.tagName === "IMG") {
      rewriteImage(node, register);
      return;
    }

    if (node.tagName === "VIDEO") {
      rewriteMediaElement(node, "video", register);
      return;
    }

    if (node.tagName === "AUDIO") {
      rewriteMediaElement(node, "audio", register);
      return;
    }

    if (node.tagName === "A") {
      rewriteAttachmentLink(node, register);
      return;
    }

    if (node.tagName === "IFRAME") {
      rewriteIframe(node);
    }
  });

  root.querySelectorAll("picture source, video source, audio source").forEach((node) => node.remove());
}

function rewriteImage(node: HTMLImageElement, register: (url: string, kind: ResourceKind, filenameHint: string) => string | null): void {
  let url = pickImageUrl(node);
  if (!url) {
    const picture = node.closest("picture");
    if (picture) {
      url = pickPictureSourceUrl(picture);
    }
  }
  if (!url) {
    return;
  }

  const placeholder = register(url, "image", inferFilename(url, "image"));
  if (!placeholder) {
    return;
  }

  node.setAttribute("src", placeholder);
  node.removeAttribute("srcset");
  node.removeAttribute("data-srcset");
  node.removeAttribute("sizes");
  node.removeAttribute("data-src");
  node.removeAttribute("data-original");
  node.removeAttribute("data-lazy-src");
  node.removeAttribute("data-url");
}

function rewriteMediaElement(
  node: HTMLElement,
  kind: "video" | "audio",
  register: (url: string, kind: ResourceKind, filenameHint: string) => string | null
): void {
  const existing = node.getAttribute("src") || "";
  const source = existing || pickSourceUrl(node);
  if (!source) {
    return;
  }

  const placeholder = register(source, kind, inferFilename(source, kind));
  if (!placeholder) {
    return;
  }

  const poster = node.getAttribute("poster");
  if (kind === "video" && poster) {
    const posterPlaceholder = register(normalizeCapturedUrl(poster), "image", inferFilename(poster, "image"));
    if (posterPlaceholder) {
      const link = document.createElement("a");
      link.href = placeholder;

      const image = document.createElement("img");
      image.src = posterPlaceholder;
      image.alt = getMediaLabel(node, kind);
      link.append(image);
      node.replaceWith(link);
      return;
    }
  }

  const link = document.createElement("a");
  link.href = placeholder;
  link.textContent = getMediaLabel(node, kind);
  node.replaceWith(link);
}

function rewriteAttachmentLink(
  node: HTMLAnchorElement,
  register: (url: string, kind: ResourceKind, filenameHint: string) => string | null
): void {
  const href = node.getAttribute("href") || "";
  const kind = inferKind(href);
  if (!kind) {
    return;
  }

  const placeholder = register(href, kind, inferFilename(href, kind));
  if (!placeholder) {
    return;
  }

  node.setAttribute("href", placeholder);
}

function rewriteIframe(node: HTMLIFrameElement): void {
  const src = node.getAttribute("src") || "";
  if (!src) {
    node.remove();
    return;
  }

  const wrapper = document.createElement("p");
  const link = document.createElement("a");
  link.href = src;
  link.textContent = "Open embedded content";
  wrapper.append("Embedded content: ");
  wrapper.append(link);
  node.replaceWith(wrapper);
}

function pickImageUrl(node: HTMLImageElement): string {
  const srcset = node.getAttribute("srcset") || node.getAttribute("data-srcset") || "";
  if (srcset) {
    const picked = pickBestFromSrcset(srcset);
    if (picked) {
      return normalizeCapturedUrl(picked) || "";
    }
  }

  const lazyAttrs = ["data-src", "data-original", "data-lazy-src", "data-url", "src"];
  for (const attr of lazyAttrs) {
    const value = node.getAttribute(attr);
    if (value && !isPlaceholder(value)) {
      return normalizeCapturedUrl(value) || "";
    }
  }

  return "";
}

function pickSourceUrl(node: HTMLElement): string {
  const sources = Array.from(node.querySelectorAll("source"));
  for (const source of sources) {
    const src = source.getAttribute("src") || source.getAttribute("data-src") || "";
    if (src && !isPlaceholder(src)) {
      return normalizeCapturedUrl(src) || "";
    }
    const srcset = source.getAttribute("srcset") || source.getAttribute("data-srcset") || "";
    const chosen = pickBestFromSrcset(srcset);
    if (chosen) {
      return normalizeCapturedUrl(chosen) || "";
    }
  }

  return "";
}

function pickPictureSourceUrl(picture: HTMLPictureElement): string {
  const sources = Array.from(picture.querySelectorAll(":scope > source"));
  let bestUrl = "";
  let bestWidth = 0;

  for (const source of sources) {
    const src = source.getAttribute("src") || source.getAttribute("data-src") || "";
    if (src && !isPlaceholder(src)) {
      return normalizeCapturedUrl(src) || "";
    }

    const srcset = source.getAttribute("srcset") || source.getAttribute("data-srcset") || "";
    if (srcset) {
      const chosen = pickBestFromSrcset(srcset);
      if (chosen) {
        const width = estimateSrcsetMaxWidth(srcset);
        if (width > bestWidth) {
          bestWidth = width;
          bestUrl = chosen;
        }
      }
    }
  }

  return normalizeCapturedUrl(bestUrl) || "";
}

function estimateSrcsetMaxWidth(srcset: string): number {
  const entries = srcset.split(",").map((entry) => entry.trim()).filter(Boolean);
  let maxWidth = 0;

  for (const entry of entries) {
    const parts = entry.split(/\s+/).filter(Boolean);
    const descriptor = parts[1] || "";
    const widthMatch = descriptor.match(/^(\d+)w$/);
    if (widthMatch) {
      maxWidth = Math.max(maxWidth, Number(widthMatch[1]));
      continue;
    }

    const densityMatch = descriptor.match(/^(\d+(?:\.\d+)?)x$/);
    if (densityMatch) {
      maxWidth = Math.max(maxWidth, Math.round(Number(densityMatch[1]) * 1000));
    }
  }

  return maxWidth;
}

function pickBestFromSrcset(srcset: string): string {
  if (!srcset) {
    return "";
  }

  const entries = srcset.split(",").map((entry) => entry.trim()).filter(Boolean);
  let bestUrl = "";
  let bestWidth = 0;
  let bestDensity = 0;

  for (const entry of entries) {
    const parts = entry.split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      continue;
    }

    const url = parts[0];
    const descriptor = parts[1] || "";

    const widthMatch = descriptor.match(/^(\d+)w$/);
    if (widthMatch) {
      const width = Number(widthMatch[1]);
      if (width > bestWidth) {
        bestWidth = width;
        bestUrl = url;
      }
      continue;
    }

    const densityMatch = descriptor.match(/^(\d+(?:\.\d+)?)x$/);
    if (densityMatch) {
      const density = Number(densityMatch[1]);
      if (density > bestDensity) {
        bestDensity = density;
        bestUrl = url;
      }
      continue;
    }

    if (!bestUrl) {
      bestUrl = url;
    }
  }

  return bestUrl;
}

function pickBestFigureImage(node: GenericElement): HTMLImageElement | null {
  const images = Array.from(node.querySelectorAll("img")).filter((candidate): candidate is HTMLImageElement => {
    return candidate instanceof HTMLImageElement;
  });

  let bestImage: HTMLImageElement | null = null;
  let bestScore = -Infinity;

  for (const image of images) {
    const score = scoreFigureImage(image);
    if (score > bestScore) {
      bestScore = score;
      bestImage = image;
    }
  }

  return bestImage;
}

function scoreFigureImage(image: HTMLImageElement): number {
  const width = parsePositiveDimension(image.getAttribute("width")) || estimateSrcsetWidth(image);
  const height = parsePositiveDimension(image.getAttribute("height"));

  let score = 0;
  if (width && height) {
    score = width * height;
  } else if (width) {
    score = width;
  } else if (height) {
    score = height;
  } else {
    score = 1;
  }

  const hint = `${image.getAttribute("alt") || ""} ${image.getAttribute("title") || ""}`.toLowerCase();
  if (/\bavatar\b|\bprofile\b|\bicon\b|\blogo\b|\bthumbnail\b/.test(hint)) {
    score *= 0.1;
  }

  if (image.closest("figcaption")) {
    score *= 0.25;
  }

  if (image.hasAttribute("hidden") || image.getAttribute("aria-hidden") === "true") {
    score *= 0.5;
  }

  return score;
}

function parsePositiveDimension(value: string | null): number {
  if (!value) {
    return 0;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function estimateSrcsetWidth(image: HTMLImageElement): number {
  const srcset = image.getAttribute("srcset") || image.getAttribute("data-srcset") || "";
  if (!srcset) {
    return 0;
  }

  const entries = srcset.split(",").map((entry) => entry.trim()).filter(Boolean);
  let bestWidth = 0;

  for (const entry of entries) {
    const parts = entry.split(/\s+/);
    const descriptor = parts[1] || "";
    const widthMatch = descriptor.match(/^(\d+)w$/);
    if (widthMatch) {
      bestWidth = Math.max(bestWidth, Number(widthMatch[1]));
      continue;
    }

    const densityMatch = descriptor.match(/^(\d+(?:\.\d+)?)x$/);
    if (densityMatch && bestWidth === 0) {
      bestWidth = Math.max(bestWidth, Math.round(Number(densityMatch[1]) * 1000));
    }
  }

  return bestWidth;
}

function resolveUrl(value: string): string {
  try {
    return new URL(value, location.href).href;
  } catch {
    return value.trim();
  }
}

function normalizeCapturedUrl(value: string): string {
  return normalizeRemoteMediaUrl(resolveUrl(value));
}

function isIgnoredScheme(value: string): boolean {
  const lower = value.trim().toLowerCase();
  return (
    !lower ||
    lower.startsWith("javascript:") ||
    lower.startsWith("mailto:") ||
    lower.startsWith("tel:") ||
    lower.startsWith("data:")
  );
}

function isPlaceholder(value: string): boolean {
  return value.startsWith(PLACEHOLDER_PREFIX);
}

function inferKind(url: string): ResourceKind | null {
  const ext = getExtension(url);
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (ATTACHMENT_EXTS.has(ext)) return "attachment";
  return null;
}

function inferFilename(url: string, kind: ResourceKind): string {
  let base = "resource";

  try {
    const parsed = new URL(url, location.href);
    const decodedPath = decodeURIComponent(parsed.pathname);
    base = decodedPath.split("/").filter(Boolean).pop() || base;
  } catch {
    try {
      const decodedUrl = decodeURIComponent(url);
      base = decodedUrl.split("/").filter(Boolean).pop() || base;
    } catch {
      base = url.split("/").filter(Boolean).pop() || base;
    }
  }

  base = base.split("?")[0].split("#")[0];
  base = stripSyntheticMediaVariantSuffix(base);
  if (!pathHasExtension(base)) {
    base += defaultExtension(kind);
  }
  return base || `resource${defaultExtension(kind)}`;
}

function uniqueFilename(name: string, resources: ResourceSpec[]): string {
  const used = new Set(resources.map((resource) => resource.filename));
  if (!used.has(name)) {
    return name;
  }

  const ext = name.includes(".") ? `.${name.split(".").pop()}` : "";
  const stem = ext ? name.slice(0, -ext.length) : name;
  let i = 2;
  while (true) {
    const candidate = `${stem}_${i}${ext}`;
    if (!used.has(candidate)) {
      return candidate;
    }
    i += 1;
  }
}

function pathHasExtension(name: string): boolean {
  return /\.[a-z0-9]+$/i.test(name);
}

function defaultExtension(kind: ResourceKind): string {
  if (kind === "image") return ".png";
  if (kind === "video") return ".mp4";
  if (kind === "audio") return ".mp3";
  return ".bin";
}

function getExtension(url: string): string {
  try {
    const pathname = stripSyntheticMediaVariantSuffix(new URL(url, location.href).pathname.toLowerCase());
    const dot = pathname.lastIndexOf(".");
    return dot >= 0 ? pathname.slice(dot) : "";
  } catch {
    const clean = stripSyntheticMediaVariantSuffix(url.toLowerCase());
    const dot = clean.lastIndexOf(".");
    return dot >= 0 ? clean.slice(dot) : "";
  }
}

function guessMime(name: string): string {
  const ext = getExtension(name);
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

function getMediaLabel(node: HTMLElement, kind: "video" | "audio"): string {
  return (
    node.getAttribute("aria-label") ||
    node.getAttribute("title") ||
    node.getAttribute("data-title") ||
    node.getAttribute("alt") ||
    (kind === "video" ? "Video" : "Audio")
  );
}

function htmlToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*"
  });

  turndownService.addRule("button", {
    filter: "button",
    replacement: (content: string) => content
  });

  turndownService.addRule("figure", {
    filter: "figure",
    replacement: (content: string, node: Node) => {
      if (!isGenericElement(node)) {
        return content;
      }

      const img = pickBestFigureImage(node);
      if (!(img instanceof HTMLImageElement)) {
        return content;
      }

      const hasParagraphsOutsideFigcaption = Array.from(node.querySelectorAll("p")).some((paragraph) => {
        let ancestor = paragraph.parentElement;
        while (ancestor && ancestor !== node) {
          if (ancestor.nodeName === "FIGCAPTION") {
            return false;
          }
          ancestor = ancestor.parentElement;
        }
        return true;
      });

      if (hasParagraphsOutsideFigcaption) {
        return content;
      }

      const alt = img.getAttribute("alt") || "";
      const src = pickImageUrl(img);
      if (!src) {
        return content;
      }

      const figcaption = node.querySelector("figcaption");
      const caption = figcaption ? turndownService.turndown(figcaption.outerHTML).trim() : "";
      return caption ? `![${alt}](${src})\n\n${caption}\n\n` : `![${alt}](${src})\n\n`;
    }
  });

  turndownService.addRule("linkedMedia", {
    filter: (node: Node): boolean => {
      if (!isGenericElement(node) || node.nodeName !== "A") {
        return false;
      }

      return isSingleMediaAnchor(node);
    },
    replacement: (content: string) => content.trim()
  });

  const markdown = turndownService.turndown(html);
  return collapseLinkedMediaWrappers(markdown);
}

function isSingleMediaAnchor(node: GenericElement): boolean {
  let mediaCount = 0;

  for (const child of Array.from(node.childNodes || [])) {
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.textContent || "").trim()) {
        return false;
      }
      continue;
    }

    if (child.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }

    const element = child as HTMLElement;
    if (element.nodeName === "IMG" || element.nodeName === "VIDEO" || element.nodeName === "AUDIO") {
      mediaCount += 1;
      continue;
    }

    if (element.nodeName === "PICTURE" && element.querySelector("img")) {
      mediaCount += 1;
      continue;
    }

    if (element.getAttribute("aria-hidden") === "true" || element.hasAttribute("hidden")) {
      continue;
    }

    if (!(element.textContent || "").trim()) {
      continue;
    }

    return false;
  }

  return mediaCount === 1;
}
