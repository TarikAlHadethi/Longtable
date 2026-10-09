// Only ever send people back to a page on this site, never to another site named in a link.
export function safeNext(value: string | string[] | undefined, fallback = "/start") {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v || !v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\")) return fallback;
  return v;
}
