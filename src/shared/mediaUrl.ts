const MEDIA_VARIANT_SUFFIX_RE =
  /\.(png|jpe?g|webp|gif|svg|bmp|tiff?|mp4|webm|mov|m4v|avi|mkv|ogv|mp3|wav|ogg|m4a|flac|aac|pdf|csv|json|txt|md|zip|docx?|xlsx?|pptx?)(\d+)(?=$|[?#])/gi;

export function extractEmbeddedHttpUrl(value: string): string {
  const httpsIndex = value.lastIndexOf("https://");
  const httpIndex = value.lastIndexOf("http://");
  const index = Math.max(httpsIndex, httpIndex);
  if (index >= 0) {
    return value.slice(index);
  }

  return "";
}

export function stripUrlDecorations(value: string): string {
  let clean = value.trim();

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
    // keep the original text if decoding fails
  }

  if (clean.startsWith("file://")) {
    clean = clean.replace("file://", "");
  }

  return clean;
}

export function stripSyntheticMediaVariantSuffix(value: string): string {
  return value.replace(MEDIA_VARIANT_SUFFIX_RE, (_match, ext: string) => `.${ext}`);
}

export function normalizeMediaReference(value: string): string {
  const clean = stripUrlDecorations(value);
  const embedded = extractEmbeddedHttpUrl(clean);
  return stripSyntheticMediaVariantSuffix((embedded || clean).replace(/\\/g, "/"));
}

export function normalizeRemoteMediaUrl(value: string): string {
  const raw = value.trim();
  const candidates = [raw];

  try {
    const decoded = decodeURIComponent(raw);
    if (decoded !== raw) {
      candidates.push(decoded);
    }
  } catch {
    // Keep the raw value when decoding fails.
  }

  for (const candidate of candidates) {
    const embedded = extractEmbeddedHttpUrl(candidate) || candidate;

    try {
      const parsed = new URL(embedded);
      parsed.pathname = stripSyntheticMediaVariantSuffix(parsed.pathname).replace(/\\/g, "/");
      parsed.hash = "";
      return parsed.toString();
    } catch {
      // Try the next candidate or the fallback below.
    }
  }

  const fallback = (extractEmbeddedHttpUrl(candidates[candidates.length - 1]) || candidates[candidates.length - 1])
    .replace(/\\/g, "/")
    .replace(/#.*$/, "");

  return stripSyntheticMediaVariantSuffix(fallback);
}
