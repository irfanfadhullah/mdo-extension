import { normalizePosixPath } from "./posixPath";
import { normalizeMediaReference } from "./mediaUrl";

export const MDO_METADATA_VERSION = "1.0";
export const MDO_METADATA_NAME = "metadata.json";

export type MdoMetadataFileRecord = {
  originalPath: string;
  storedPath: string;
  originalName: string;
  mime: string;
  type: string;
  sizeBytes: number;
  sha256: string;
  referencedInMarkdown: boolean;
};

export type MdoMetadataBlockKind =
  | "heading"
  | "paragraph"
  | "list"
  | "quote"
  | "code"
  | "table"
  | "media"
  | "html";

export type MdoMetadataRelationType = "contains" | "references" | "illustrates";

export type MdoMetadata = {
  format: "mdo-metadata";
  version: string;
  createdUnix: number;
  createdLocal: string;
  document: {
    title: string;
    main: string;
    sourceUrl?: string;
    sourceMarkdown?: string;
    sourceKind?: string;
  };
  stats: {
    blockCount: number;
    mediaCount: number;
    missingRefCount: number;
    wordCount: number;
    charCount: number;
  };
  missingRefs: string[];
  media: MdoMetadataMedia[];
  blocks: MdoMetadataBlock[];
  relations: MdoMetadataRelation[];
};

type MdoMetadataMedia = {
  id: string;
  path: string;
  originalPath: string;
  originalName: string;
  kind: string;
  type: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  referencedInMarkdown: boolean;
};

type MdoMetadataBlock = {
  id: string;
  kind: MdoMetadataBlockKind;
  text: string;
  lineStart: number;
  lineEnd: number;
  charCount: number;
  wordCount: number;
  refs: string[];
  mediaIds: string[];
};

type MdoMetadataRelation = {
  from: string;
  to: string;
  type: MdoMetadataRelationType;
};

type MetadataBlockSlice = {
  text: string;
  lineStart: number;
  lineEnd: number;
};

type BuildMetadataInput = {
  title: string;
  main: string;
  markdown: string;
  createdUnix: number;
  createdLocal: string;
  sourceUrl?: string;
  sourceMarkdown?: string;
  sourceKind?: string;
  files: MdoMetadataFileRecord[];
  missingRefs: string[];
};

export function buildMdoMetadata(input: BuildMetadataInput): MdoMetadata {
  const media = input.files.map((file, index) => ({
    id: `media-${index + 1}`,
    path: file.storedPath,
    originalPath: file.originalPath,
    originalName: file.originalName,
    kind: file.type,
    type: file.type,
    mime: file.mime,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
    referencedInMarkdown: file.referencedInMarkdown
  }));

  const pathToMediaId = new Map<string, string>();
  for (const item of media) {
    const normalizedPath = normalizeMetadataRef(item.path);
    if (normalizedPath) {
      pathToMediaId.set(normalizedPath, item.id);
    }
    const normalizedOriginal = normalizeMetadataRef(item.originalPath);
    if (normalizedOriginal) {
      pathToMediaId.set(normalizedOriginal, item.id);
    }
  }

  const blocks = splitMarkdownBlocks(input.markdown).map((block, index) => {
    const refs = uniqueStrings(
      collectMarkdownRefs(block.text)
        .map((ref) => normalizeMetadataRef(ref))
        .filter(Boolean)
    );
    const mediaIds = uniqueStrings(
      refs
        .map((ref) => pathToMediaId.get(ref))
        .filter((value): value is string => Boolean(value))
    );

    return {
      id: `block-${index + 1}`,
      kind: classifyBlock(block.text),
      text: block.text,
      lineStart: block.lineStart,
      lineEnd: block.lineEnd,
      charCount: block.text.length,
      wordCount: countWords(block.text),
      refs,
      mediaIds
    };
  });

  const relations: MdoMetadataRelation[] = [];
  for (const block of blocks) {
    relations.push({
      from: "document",
      to: block.id,
      type: "contains"
    });

    for (const mediaId of block.mediaIds) {
      relations.push({
        from: block.id,
        to: mediaId,
        type: block.kind === "media" ? "illustrates" : "references"
      });
    }
  }

  for (const item of media) {
    relations.push({
      from: "document",
      to: item.id,
      type: "contains"
    });
  }

  return {
    format: "mdo-metadata",
    version: MDO_METADATA_VERSION,
    createdUnix: input.createdUnix,
    createdLocal: input.createdLocal,
    document: {
      title: input.title,
      main: input.main,
      sourceUrl: input.sourceUrl,
      sourceMarkdown: input.sourceMarkdown,
      sourceKind: input.sourceKind
    },
    stats: {
      blockCount: blocks.length,
      mediaCount: media.length,
      missingRefCount: input.missingRefs.length,
      wordCount: countWords(input.markdown),
      charCount: input.markdown.length
    },
    missingRefs: uniqueStrings(input.missingRefs),
    media,
    blocks,
    relations
  };
}

function splitMarkdownBlocks(markdown: string): MetadataBlockSlice[] {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const blocks: MetadataBlockSlice[] = [];
  let currentLines: string[] = [];
  let currentStart = 1;
  let fenceMarker: "```" | "~~~" | null = null;

  const flush = (endLine: number): void => {
    if (currentLines.length === 0) {
      return;
    }

    blocks.push({
      text: currentLines.join("\n"),
      lineStart: currentStart,
      lineEnd: endLine
    });
    currentLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const fenceMatch = line.match(/^(\s*)(```+|~~~+)/);

    if (fenceMatch) {
      const marker = fenceMatch[2].startsWith("```") ? "```" : "~~~";
      if (fenceMarker === null) {
        fenceMarker = marker;
      } else if (fenceMarker === marker) {
        fenceMarker = null;
      }

      if (currentLines.length === 0) {
        currentStart = lineNo;
      }

      currentLines.push(line);
      continue;
    }

    if (fenceMarker === null && line.trim() === "") {
      flush(lineNo - 1);
      continue;
    }

    if (currentLines.length === 0) {
      currentStart = lineNo;
    }

    currentLines.push(line);
  }

  flush(lines.length);
  return blocks;
}

function classifyBlock(text: string): MdoMetadataBlockKind {
  const trimmed = text.trim();
  if (!trimmed) {
    return "paragraph";
  }

  if (/^#{1,6}\s/m.test(trimmed)) {
    return "heading";
  }

  if (/^(```|~~~)/m.test(trimmed)) {
    return "code";
  }

  if (/^>/m.test(trimmed)) {
    return "quote";
  }

  if (/<table[\s>]/i.test(trimmed)) {
    return "table";
  }

  if (/<(?:img|video|audio|figure|source)\b/i.test(trimmed) || /!\[[^\]]*\]\([^)]+\)/.test(trimmed)) {
    return "media";
  }

  if (isListBlock(trimmed)) {
    return "list";
  }

  if (/^</.test(trimmed)) {
    return "html";
  }

  return "paragraph";
}

function isListBlock(text: string): boolean {
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return false;
  }

  return lines.every((line) => {
    const trimmed = line.trimStart();
    return /^(?:[-*+]\s|\d+\.\s)/.test(trimmed) || /^\s{2,}\S/.test(line);
  });
}

function collectMarkdownRefs(mdText: string): string[] {
  const refs: string[] = [];
  const imgRe = /!\[[^\]]*\]\(([^)]+)\)/g;
  const linkRe = /(?<!!)\[[^\]]+\]\(([^)]+)\)/g;
  const htmlRe = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;

  let match: RegExpExecArray | null;
  while ((match = imgRe.exec(mdText)) !== null) {
    refs.push(match[1].trim());
  }

  while ((match = linkRe.exec(mdText)) !== null) {
    refs.push(match[1].trim());
  }

  while ((match = htmlRe.exec(mdText)) !== null) {
    refs.push(match[1].trim());
  }

  return refs;
}

function normalizeMetadataRef(ref: string): string {
  const clean = normalizeMediaReference(ref);
  if (!clean) {
    return "";
  }

  if (isExternalRef(clean)) {
    return "";
  }

  const normalized = normalizePosixPath(clean);
  if (normalized === "." || normalized === "/") {
    return "";
  }

  return normalized.replace(/^\.\//, "").replace(/^\//, "");
}

function stripUrlSuffix(ref: string): string {
  return normalizeMediaReference(ref);
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

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
}

function countWords(text: string): number {
  const stripped = text.replace(/\s+/g, " ").trim();
  if (!stripped) {
    return 0;
  }

  return stripped.split(" ").filter(Boolean).length;
}
