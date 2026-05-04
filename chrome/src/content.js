"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const PLACEHOLDER_PREFIX = "mdo-resource://";
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".bmp", ".tiff", ".tif"]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv", ".ogv"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"]);
const ATTACHMENT_EXTS = new Set([".pdf", ".csv", ".json", ".txt", ".md", ".zip", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"]);
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "mdo:capture") {
        return;
    }
    Promise.resolve()
        .then(() => captureSnapshot())
        .then((snapshot) => sendResponse({ ok: true, snapshot }))
        .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
});
function captureSnapshot() {
    const root = selectCaptureRoot();
    const clone = root.cloneNode(true);
    const resources = [];
    const seen = new Set();
    let seq = 0;
    removeNoiseNodes(clone);
    rewriteCapturedResources(clone, (url, kind, filenameHint) => {
        const cleaned = resolveUrl(url);
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
    const fragmentHtml = root.tagName.toLowerCase() === "body" ? clone.innerHTML : clone.outerHTML;
    return {
        kind: "webpage",
        title: document.title || location.hostname || "Captured page",
        sourceUrl: location.href,
        fragmentHtml,
        resources
    };
}
function selectCaptureRoot() {
    const candidates = [
        document.querySelector("article"),
        document.querySelector("main"),
        document.querySelector('[role="main"]'),
        document.body
    ].filter(Boolean);
    if (candidates.length > 0) {
        return candidates[0];
    }
    return document.documentElement;
}
function removeNoiseNodes(root) {
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
        "iframe",
        "object",
        "embed",
        "link",
        "meta",
        "[hidden]",
        "[aria-hidden='true']"
    ];
    root.querySelectorAll(selectors.join(",")).forEach((el) => el.remove());
}
function rewriteCapturedResources(root, register) {
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
function rewriteImage(node, register) {
    const url = pickImageUrl(node);
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
function rewriteMediaElement(node, kind, register) {
    const existing = node.getAttribute("src") || "";
    const source = existing || pickSourceUrl(node);
    if (!source) {
        return;
    }
    const placeholder = register(source, kind, inferFilename(source, kind));
    if (!placeholder) {
        return;
    }
    node.setAttribute("src", placeholder);
    node.removeAttribute("srcset");
    const poster = node.getAttribute("poster");
    if (poster) {
        const posterPlaceholder = register(poster, "image", inferFilename(poster, "image"));
        if (posterPlaceholder) {
            node.setAttribute("poster", posterPlaceholder);
        }
    }
}
function rewriteAttachmentLink(node, register) {
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
function rewriteIframe(node) {
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
function pickImageUrl(node) {
    const lazyAttrs = ["src", "data-src", "data-original", "data-lazy-src", "data-url"];
    for (const attr of lazyAttrs) {
        const value = node.getAttribute(attr);
        if (value && !isPlaceholder(value)) {
            return resolveUrl(value) || "";
        }
    }
    const srcset = node.getAttribute("srcset") || node.getAttribute("data-srcset") || "";
    return pickBestFromSrcset(srcset) || "";
}
function pickSourceUrl(node) {
    const sources = Array.from(node.querySelectorAll("source"));
    for (const source of sources) {
        const src = source.getAttribute("src") || source.getAttribute("data-src") || "";
        if (src && !isPlaceholder(src)) {
            return resolveUrl(src) || "";
        }
        const srcset = source.getAttribute("srcset") || source.getAttribute("data-srcset") || "";
        const chosen = pickBestFromSrcset(srcset);
        if (chosen) {
            return resolveUrl(chosen) || "";
        }
    }
    return "";
}
function pickBestFromSrcset(srcset) {
    if (!srcset) {
        return "";
    }
    const entries = srcset.split(",").map((entry) => entry.trim()).filter(Boolean);
    let bestUrl = "";
    let bestScore = -1;
    for (const entry of entries) {
        const parts = entry.split(/\s+/);
        const candidate = parts[0];
        const descriptor = parts[1] || "";
        let score = 1;
        const widthMatch = descriptor.match(/^(\d+)w$/);
        const densityMatch = descriptor.match(/^(\d+(?:\.\d+)?)x$/);
        if (widthMatch) {
            score = Number(widthMatch[1]);
        }
        else if (densityMatch) {
            score = Number(densityMatch[1]) * 1000;
        }
        if (score > bestScore) {
            bestScore = score;
            bestUrl = candidate;
        }
    }
    return bestUrl;
}
function resolveUrl(value) {
    try {
        return new URL(value, location.href).href;
    }
    catch {
        return value.trim();
    }
}
function isIgnoredScheme(value) {
    const lower = value.trim().toLowerCase();
    return (!lower ||
        lower.startsWith("javascript:") ||
        lower.startsWith("mailto:") ||
        lower.startsWith("tel:") ||
        lower.startsWith("data:"));
}
function isPlaceholder(value) {
    return value.startsWith(PLACEHOLDER_PREFIX);
}
function inferKind(url) {
    const ext = getExtension(url);
    if (IMAGE_EXTS.has(ext))
        return "image";
    if (VIDEO_EXTS.has(ext))
        return "video";
    if (AUDIO_EXTS.has(ext))
        return "audio";
    if (ATTACHMENT_EXTS.has(ext))
        return "attachment";
    return null;
}
function inferFilename(url, kind) {
    let base = "resource";
    try {
        const parsed = new URL(url, location.href);
        base = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || base);
    }
    catch {
        base = url.split("/").filter(Boolean).pop() || base;
    }
    base = base.split("?")[0].split("#")[0];
    if (!pathHasExtension(base)) {
        base += defaultExtension(kind);
    }
    return base || `resource${defaultExtension(kind)}`;
}
function uniqueFilename(name, resources) {
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
function pathHasExtension(name) {
    return /\.[a-z0-9]+$/i.test(name);
}
function defaultExtension(kind) {
    if (kind === "image")
        return ".png";
    if (kind === "video")
        return ".mp4";
    if (kind === "audio")
        return ".mp3";
    return ".bin";
}
function getExtension(url) {
    try {
        const pathname = new URL(url, location.href).pathname.toLowerCase();
        const dot = pathname.lastIndexOf(".");
        return dot >= 0 ? pathname.slice(dot) : "";
    }
    catch {
        const dot = url.toLowerCase().lastIndexOf(".");
        return dot >= 0 ? url.toLowerCase().slice(dot) : "";
    }
}
function guessMime(name) {
    const ext = getExtension(name);
    const table = {
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
//# sourceMappingURL=content.js.map