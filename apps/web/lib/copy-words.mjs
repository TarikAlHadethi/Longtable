// Which of a client's lines became a change in their copy. The team's assistant writes the change out itself ("yes do
// it" becomes the whole change), so the two rarely match word for word: what ties them is order. A change belongs to
// the client's line the assistant had just heard, when nothing else was said in between. The change then carries that
// line, in the client's own words: it is not shown twice, and the assistant is not still "thinking" about it.

const WITHIN_MS = 600000;
const CLOCKS_MS = 2000;
const ms = (at) => new Date(at).getTime();

export function copyWords(lines, changes) {
  const sorted = [...lines].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const lineIds = new Set();
  const saidFor = new Map();
  for (const change of changes) {
    const at = ms(change.created_at);
    const line = sorted.filter((l) => ms(l.created_at) <= at + CLOCKS_MS).at(-1);
    if (!line || line.who !== "client" || !line.by_table || at - ms(line.created_at) >= WITHIN_MS) continue;
    lineIds.add(line.id);
    saidFor.set(change.id, line.body);
  }
  return { lineIds, saidFor };
}
