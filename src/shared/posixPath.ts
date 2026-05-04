export function isAbsolutePosixPath(input: string): boolean {
  return input.startsWith("/");
}

export function normalizePosixPath(input: string): string {
  if (!input) {
    return ".";
  }

  const isAbs = input.startsWith("/");
  const hasTrailingSlash = input.length > 1 && input.endsWith("/");
  const parts = input.split("/");
  const out: string[] = [];

  for (const part of parts) {
    if (!part || part === ".") {
      continue;
    }

    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else if (!isAbs) {
        out.push("..");
      }
      continue;
    }

    out.push(part);
  }

  let result = `${isAbs ? "/" : ""}${out.join("/")}`;
  if (!result) {
    result = isAbs ? "/" : ".";
  }
  if (hasTrailingSlash && result !== "/") {
    result += "/";
  }
  return result;
}

export function joinPosixPath(...parts: string[]): string {
  let out = "";

  for (const part of parts) {
    if (!part) {
      continue;
    }

    if (!out) {
      out = part;
    } else if (out.endsWith("/")) {
      out += part;
    } else {
      out += `/${part}`;
    }
  }

  return normalizePosixPath(out);
}

export function dirnamePosixPath(input: string): string {
  const normalized = normalizePosixPath(input);
  if (normalized === "/" || normalized === ".") {
    return normalized;
  }

  const idx = normalized.lastIndexOf("/");
  if (idx < 0) {
    return ".";
  }
  if (idx === 0) {
    return "/";
  }
  return normalized.slice(0, idx);
}

export function basenamePosixPath(input: string, ext = ""): string {
  const normalized = normalizePosixPath(input);
  if (normalized === "/") {
    return "/";
  }

  const idx = normalized.lastIndexOf("/");
  let base = idx >= 0 ? normalized.slice(idx + 1) : normalized;

  if (ext && base.endsWith(ext)) {
    base = base.slice(0, -ext.length);
  }

  return base;
}

export function extnamePosixPath(input: string): string {
  const base = basenamePosixPath(input);

  if (!base || base === "." || base === "..") {
    return "";
  }

  const dot = base.lastIndexOf(".");
  if (dot <= 0) {
    return "";
  }

  return base.slice(dot);
}

export function resolvePosixPath(base: string, target: string): string {
  if (!target) {
    return normalizePosixPath(base);
  }

  if (isAbsolutePosixPath(target)) {
    return normalizePosixPath(target);
  }

  return normalizePosixPath(joinPosixPath(base, target));
}

export function safeResolvePosixPath(base: string, target: string): string {
  const resolved = resolvePosixPath(base, target);
  const normalizedBase = normalizePosixPath(base);
  if (resolved === normalizedBase) {
    return resolved;
  }

  const prefix = normalizedBase === "/" ? "/" : `${normalizedBase}/`;
  if (!resolved.startsWith(prefix)) {
    throw new Error(`Unsafe zip path blocked: ${target}`);
  }

  return resolved;
}

export function replaceExtPosixPath(input: string, ext: string): string {
  const dir = dirnamePosixPath(input);
  const base = basenamePosixPath(input);
  const currentExt = extnamePosixPath(base);
  const stem = currentExt ? base.slice(0, -currentExt.length) : base;

  if (dir === ".") {
    return `${stem}${ext}`;
  }

  return joinPosixPath(dir, `${stem}${ext}`);
}

export function splitPosixPath(input: string): string[] {
  return normalizePosixPath(input)
    .split("/")
    .filter(Boolean);
}
