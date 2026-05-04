export function collapseLinkedMediaWrappers(markdown: string): string {
  let out = markdown;

  out = out.replace(/\[\s*(?:\n\s*)*(!\[[\s\S]*?\]\([^)]+\))\s*(?:\n\s*)*\]\([^)]+\)/g, "$1");
  out = out.replace(/^\[\s*$/gm, "");
  out = out.replace(/^\]\([^)]+\)\s*$/gm, "");

  return out.replace(/\n{3,}/g, "\n\n").trim();
}
