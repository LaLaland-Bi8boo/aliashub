export function htmlToText(value) {
  return String(value || "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>|<\/div\s*>|<\/li\s*>|<\/tr\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (match, entity) => {
      const codePoint = entity.toLowerCase().startsWith("x")
        ? Number.parseInt(entity.slice(1), 16)
        : Number.parseInt(entity, 10);
      try { return String.fromCodePoint(codePoint); } catch { return match; }
    })
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/gi, (match, entity) => ({
      nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'",
    })[entity.toLowerCase()] || match)
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

export function decodeDataUrl(value) {
  const raw = String(value || "");
  const match = raw.match(/^data:([^,]*?),(.*)$/s);
  if (!match) return raw;
  try {
    return /;base64(?:;|$)/i.test(match[1])
      ? Buffer.from(match[2], "base64").toString("utf8")
      : decodeURIComponent(match[2]);
  } catch {
    return "";
  }
}
