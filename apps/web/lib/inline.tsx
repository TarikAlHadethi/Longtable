import { Fragment, type ReactNode } from "react";

// A small, safe formatter for chat text: `code` and **bold**, nothing else. It builds React elements from plain
// text, so nothing in a message is ever treated as HTML.
// `link`, when given, turns a `code` piece into a link when it names something it can point at (a file in the team's
// repository); the address is built by the caller, never taken from the text.
// `pings`, when given, are first names whose @ is set apart, so a ping stands out in the message.
export function Inline({ text, link, pings }: { text: string; link?: (code: string) => string | null; pings?: string[] }) {
  const out: ReactNode[] = [];
  const names = (pings ?? []).filter((n) => n.length > 1).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const at = names.length ? new RegExp(`(?<![\\p{L}\\p{N}])@(?:${names.join("|")})(?![\\p{L}\\p{N}])`, "giu") : null;
  const plain = (part: string) => {
    if (!at || !part.includes("@")) return out.push(<Fragment key={key++}>{part}</Fragment>);
    let from = 0;
    for (const p of part.matchAll(at)) {
      if (p.index! > from) out.push(<Fragment key={key++}>{part.slice(from, p.index)}</Fragment>);
      out.push(<span key={key++} className="ping">{p[0]}</span>);
      from = p.index! + p[0].length;
    }
    if (from < part.length) out.push(<Fragment key={key++}>{part.slice(from)}</Fragment>);
  };
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index! > last) plain(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith("`")) {
      const inner = token.slice(1, -1);
      const href = link?.(inner);
      out.push(href ? <a key={key++} href={href} target="_blank" rel="noreferrer" className="code-link"><code className="inline-code">{inner}</code></a> : <code key={key++} className="inline-code">{inner}</code>);
    }
    else out.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    last = m.index! + token.length;
  }
  if (last < text.length) plain(text.slice(last));
  return <>{out}</>;
}

// An AI's answer, set like a page: paragraphs with air between them, real bullets and numbers, small headings. The
// same safety as Inline: every piece is a React element built from plain text.
export function Prose({ text, link }: { text: string; link?: (code: string) => string | null }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let para: string[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | null = null;
  let key = 0;
  const endPara = () => { if (para.length) blocks.push(<p key={key++}><Inline text={para.join("\n")} link={link} /></p>); para = []; };
  const endList = () => {
    if (!list) return;
    const items = list.items.map((it, i) => <li key={i}><Inline text={it} link={link} /></li>);
    blocks.push(list.ordered ? <ol key={key++} start={list.start}>{items}</ol> : <ul key={key++}>{items}</ul>);
    list = null;
  };
  let code: string[] | null = null;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (code) { blocks.push(<pre key={key++} className="code-block"><code>{code.join("\n")}</code></pre>); code = null; }
      else { endPara(); endList(); code = []; }
      continue;
    }
    if (code) { code.push(line); continue; }
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const number = line.match(/^\s*(\d{1,3})[.)]\s+(.*)$/);
    const head = line.match(/^#{1,4}\s+(.*)$/);
    if (bullet || number) {
      endPara();
      const ordered = !bullet;
      if (list && list.ordered !== ordered) endList();
      // A numbered list starts at the number it was written with: a blank line or a bullet under an item ends one
      // list and begins the next, and the next must carry on counting, not start again at 1.
      list ??= { ordered, start: number ? Number(number[1]) : 1, items: [] };
      list.items.push(bullet ? bullet[1] : number![2]);
    } else if (head) {
      endPara(); endList();
      blocks.push(<p key={key++}><strong>{head[1].replace(/\*\*/g, "")}</strong></p>);
    } else if (!line.trim()) {
      endPara(); endList();
    } else if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += "\n" + line.trim();
    } else {
      endList();
      para.push(line);
    }
  }
  // A block left open at the end is still shown as code.
  if (code) blocks.push(<pre key={key++} className="code-block"><code>{(code as string[]).join("\n")}</code></pre>);
  endPara(); endList();
  return <>{blocks}</>;
}
