"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const jszip_1 = __importDefault(require("jszip"));
const MDO_VERSION = "0.1";
const MAIN_MD_NAME = "document.md";
const MANIFEST_NAME = "manifest.json";
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
        .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
});
async function handleCaptureActiveTab() {
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
async function captureTab(tab) {
    const url = tab.url || "";
    if (looksLikePdf(url)) {
        return await capturePdfTab(tab, url);
    }
    try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: "mdo:capture" });
        if (response?.ok && response.snapshot) {
            return response.snapshot;
        }
    }
    catch {
        // Fall through to PDF handling or an error below.
    }
    if (looksLikePdf(url)) {
        return await capturePdfTab(tab, url);
    }
    throw new Error("The current tab could not be captured. Try a normal webpage or a direct PDF URL.");
}
async function capturePdfTab(tab, sourceUrl) {
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
async function buildMdoArchive(snapshot) {
    if (snapshot.kind === "pdf") {
        return await buildPdfArchive(snapshot);
    }
    return await buildWebpageArchive(snapshot);
}
async function buildWebpageArchive(snapshot) {
    const zip = new jszip_1.default();
    const records = [];
    const missingRefs = [];
    const usedAssets = new Set();
    const usedAttachments = new Set();
    const placeholderToPath = new Map();
    for (const resource of snapshot.resources) {
        const folder = pickStorageFolder(resource.kind);
        const used = folder === "assets" ? usedAssets : usedAttachments;
        const storedName = uniqueName(resource.filename, used);
        const storedPath = `${folder}/${storedName}`;
        const placeholder = `${PLACEHOLDER_PREFIX}${resource.id}`;
        try {
            const bytes = await fetchResourceBytes(resource.url);
            zip.file(storedPath, bytes);
            const record = {
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
        }
        catch {
            missingRefs.push(resource.url);
            placeholderToPath.set(placeholder, resource.url);
        }
    }
    const markdown = buildWebpageDocument(snapshot, rewritePlaceholders(snapshot.fragmentHtml, placeholderToPath));
    zip.file(MAIN_MD_NAME, markdown);
    const manifest = {
        format: "mdo",
        version: MDO_VERSION,
        createdUnix: Math.floor(Date.now() / 1000),
        createdLocal: new Date().toLocaleString(),
        title: snapshot.title,
        main: MAIN_MD_NAME,
        sourceUrl: snapshot.sourceUrl,
        files: records,
        missingRefs
    };
    zip.file(MANIFEST_NAME, JSON.stringify(manifest, null, 2));
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    return { blob: new Blob([bytes], { type: "application/zip" }), manifest };
}
async function buildPdfArchive(snapshot) {
    const zip = new jszip_1.default();
    const usedAttachments = new Set();
    const storedName = uniqueName(snapshot.pdfFilename, usedAttachments);
    const storedPath = `attachments/${storedName}`;
    zip.file(storedPath, snapshot.pdfBytes);
    zip.file(MAIN_MD_NAME, [
        `<h1>${escapeHtml(snapshot.title)}</h1>`,
        `<p>Source: <a href="${escapeAttr(snapshot.sourceUrl)}">${escapeHtml(snapshot.sourceUrl)}</a></p>`,
        `<p><a href="${escapeAttr(storedPath)}">Original PDF</a></p>`
    ].join("\n\n"));
    const manifest = {
        format: "mdo",
        version: MDO_VERSION,
        createdUnix: Math.floor(Date.now() / 1000),
        createdLocal: new Date().toLocaleString(),
        title: snapshot.title,
        main: MAIN_MD_NAME,
        sourceUrl: snapshot.sourceUrl,
        files: [
            {
                originalPath: snapshot.sourceUrl,
                storedPath,
                originalName: snapshot.pdfFilename,
                mime: "application/pdf",
                type: "pdf",
                sizeBytes: snapshot.pdfBytes.byteLength,
                sha256: await sha256(snapshot.pdfBytes),
                referencedInMarkdown: true
            }
        ],
        missingRefs: []
    };
    zip.file(MANIFEST_NAME, JSON.stringify(manifest, null, 2));
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    return { blob: new Blob([bytes], { type: "application/zip" }), manifest };
}
function buildWebpageDocument(snapshot, fragmentHtml) {
    return [
        `<h1>${escapeHtml(snapshot.title)}</h1>`,
        `<p>Source: <a href="${escapeAttr(snapshot.sourceUrl)}">${escapeHtml(snapshot.sourceUrl)}</a></p>`,
        "",
        fragmentHtml
    ].join("\n");
}
function rewritePlaceholders(fragmentHtml, placeholderToPath) {
    let out = fragmentHtml;
    for (const [placeholder, path] of placeholderToPath.entries()) {
        out = out.split(placeholder).join(path);
    }
    return out;
}
async function fetchResourceBytes(url) {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) {
        throw new Error(`Failed to fetch resource: ${response.status} ${response.statusText}`);
    }
    return new Uint8Array(await response.arrayBuffer());
}
async function downloadBlob(blob, filename) {
    const objectUrl = URL.createObjectURL(blob);
    try {
        await chrome.downloads.download({
            url: objectUrl,
            filename,
            saveAs: true
        });
    }
    finally {
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    }
}
async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab) {
        throw new Error("No active tab found.");
    }
    return tab;
}
function looksLikePdf(url) {
    return /\.pdf([?#].*)?$/i.test(url);
}
function sanitizeTitle(value) {
    return value.replace(/\s+/g, " ").trim() || "Captured page";
}
function sanitizeFilename(value) {
    return sanitizeTitle(value)
        .replace(/[^a-z0-9._-]+/gi, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "") || "captured-page";
}
function inferPdfFilename(url, title) {
    try {
        const parsed = new URL(url);
        const base = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "");
        if (base.toLowerCase().endsWith(".pdf")) {
            return base;
        }
    }
    catch {
        // fall through
    }
    return `${sanitizeFilename(title)}.pdf`;
}
function pickStorageFolder(kind) {
    return kind === "image" || kind === "video" || kind === "audio" ? "assets" : "attachments";
}
function uniqueName(name, used) {
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
function detectType(fileName) {
    const ext = getExtension(fileName);
    if (IMAGE_EXTS.has(ext))
        return "image";
    if (VIDEO_EXTS.has(ext))
        return "video";
    if (AUDIO_EXTS.has(ext))
        return "audio";
    if (ext === ".pdf")
        return "pdf";
    return "attachment";
}
function guessMime(fileName) {
    const ext = getExtension(fileName);
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
function getExtension(fileName) {
    const dot = fileName.lastIndexOf(".");
    return dot >= 0 ? fileName.slice(dot).toLowerCase() : "";
}
function escapeHtml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}
function escapeAttr(value) {
    return escapeHtml(value).replace(/"/g, "&quot;");
}
async function sha256(bytes) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}
//# sourceMappingURL=background.js.map