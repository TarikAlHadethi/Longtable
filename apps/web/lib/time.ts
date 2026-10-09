// 12-hour time everywhere, written the way the design writes it: "9:15 am".
export function formatTime(iso: string) {
  const d = new Date(iso);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? "am" : "pm"}`;
}

// When something happened, the way the design's timelines write it: "Just now", "Today, 10:42 am", "Yesterday",
// "Wednesday", "14 September".
export function formatWhen(iso: string, now = new Date()) {
  const d = new Date(iso);
  if (now.getTime() - d.getTime() < 2 * 60 * 1000) return "Just now";
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86400000);
  if (days === 0) return `Today, ${formatTime(iso)}`;
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString("en-GB", { weekday: "long" });
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long" });
}

// The day and time for a log line: "9 Oct, 9:15 am".
export function formatStamp(iso: string) {
  return `${new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${formatTime(iso)}`;
}
