import { Fragment, type ReactNode } from "react";

// A small, safe formatter for chat text: `code` and **bold**, nothing else. It builds React elements from plain
// text, so nothing in a message is ever treated as HTML.
export function Inline({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index! > last) out.push(<Fragment key={key++}>{text.slice(last, m.index)}</Fragment>);
    const token = m[0];
    if (token.startsWith("`")) out.push(<code key={key++} className="inline-code">{token.slice(1, -1)}</code>);
    else out.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    last = m.index! + token.length;
  }
  if (last < text.length) out.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);
  return <>{out}</>;
}
