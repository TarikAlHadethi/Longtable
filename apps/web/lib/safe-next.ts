// Only ever send people back to a page on this site, never to another site named in a link.
export function safeNext(value: string | string[] | undefined, fallback = "/start") {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v || !v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\")) return fallback;
  // A browser drops tabs and line breaks from an address and reads a backslash as a slash, so "/<tab>/other.site"
  // is "//other.site" by the time it is followed. None of them belongs in a page's address here.
  if (/[\u0000-\u001f\\]/.test(v)) return fallback;
  return v;
}
