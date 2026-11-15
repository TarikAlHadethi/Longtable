"use client";

import { Fragment, useMemo, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { firstName } from "@/lib/names";
import { CODEX_NAMES, SLASH, slashEntry } from "@/lib/slash.mjs";
import { AttachButtons, type useAttach } from "./attach";
import type { Chat, Command, Connection, Member } from "./types";
import styles from "./room.module.css";

// Names both Claude Code and Codex have: shown for a Claude too.
const CLAUDE_ALSO: Record<string, true> = { model: true, status: true, effort: true, usage: true, rename: true, color: true, compact: true, mcp: true };

// Whether a "/" name is one their own AI runs here: theirs, or one the table does in its own words.
export const runsHere = (myCommands: Command[], name: string) => myCommands.some((c) => c.name.toLowerCase() === name.toLowerCase() && (c.kind !== "builtin" || !!c.about));

// The box a person writes in, with their own "/" commands and the team's people to ping offered as they type.
export function Composer({ draft, setDraft, inputRef, grow, attach, myConnection, myCommands, members, me, chat, aiWord, send, askTable, doSlash, pastedRef }: {
  draft: string; setDraft: Dispatch<SetStateAction<string>>; inputRef: RefObject<HTMLTextAreaElement | null>; grow: () => void;
  attach: ReturnType<typeof useAttach>; myConnection: Connection | undefined; myCommands: Command[]; members: Member[]; me: Pick<Member, "id">;
  chat: Chat | undefined; aiWord: (id: string) => string; send: () => void; askTable: () => void; doSlash: (body: string) => boolean; pastedRef: RefObject<string[]>;
}) {
  const [slashAt, setSlashAt] = useState(0);
  // Their own AI's commands and skills, offered while the box holds only "/" and the start of a name.
  const slashWord = draft.match(/^\/([A-Za-z0-9:_-]*)$/)?.[1];
  const slashAll = useMemo(() => {
    if (!myConnection) return [] as Command[];
    const own = myCommands.filter((c) => c.kind !== "builtin" || c.about);
    const have = new Set(own.map((c) => c.name.toLowerCase()));
    const told = myCommands.filter((c) => c.kind === "builtin" && !c.about).map((c) => c.name);
    // Claude Code's own names, from this person's connection, and the ones the table knows even before it says.
    const rest = [...new Set([...(myConnection.kind === "claude" ? Object.keys(SLASH).filter((n) => !CODEX_NAMES.includes(n) || n in CLAUDE_ALSO) : CODEX_NAMES), ...told])].filter((n) => !have.has(n.toLowerCase()))
      .map((name) => ({ name, about: slashEntry(name, false).about, kind: "builtin" as const }));
    return [...own, ...rest];
  }, [myConnection, myCommands]);
  const runnable = (name: string) => runsHere(myCommands, name);
  const slash = slashWord === undefined ? [] : slashAll.filter((c) => c.name.toLowerCase().includes(slashWord.toLowerCase()))
    .sort((x, y) => slashRank(x) - slashRank(y)
      || Number(y.name.toLowerCase().startsWith(slashWord.toLowerCase())) - Number(x.name.toLowerCase().startsWith(slashWord.toLowerCase())) || x.name.localeCompare(y.name));
  // Their own first; then the ones their Claude runs here in the table's own words; then the rest of Claude Code's,
  // which Longtable's screens carry out or explain. Each group under a line saying so.
  function slashRank(c: Command) { return c.kind !== "builtin" ? 0 : c.about && runnable(c.name) ? 1 : 2; }
  const slashBuiltAt = slash.findIndex((c) => slashRank(c) === 1);
  const slashOwnAt = slash.findIndex((c) => slashRank(c) === 2);
  const slashIndex = Math.min(slashAt, Math.max(0, slash.length - 1));
  // "@" and the start of a name offers the team's people to ping; picking one sounds a chime for them when it is sent.
  const atWord = slash.length ? undefined : draft.match(/(?:^|\s)@([\p{L}\p{N}]*)$/u)?.[1];
  const pingable = members.filter((p) => p.role !== "client" && !p.test && p.id !== me.id);
  const atList = atWord === undefined ? [] : pingable.filter((p) => firstName(p.display_name).toLowerCase().startsWith(atWord.toLowerCase())
    || p.display_name.toLowerCase().includes(atWord.toLowerCase())).slice(0, 8);
  const atIndex = Math.min(slashAt, Math.max(0, atList.length - 1));
  function pickAt(p: Member) {
    setSlashAt(0);
    setDraft((d) => d.replace(/@[\p{L}\p{N}]*$/u, `@${firstName(p.display_name)} `));
    requestAnimationFrame(() => { grow(); inputRef.current?.focus(); });
  }
  function pickSlash(name: string) {
    setSlashAt(0);
    const e = slashEntry(name, runnable(name));
    // Ones that need nothing more are done at once; the rest wait for what comes after the name.
    if (e.act === "say" || (e.act === "open" && ["ai", "usage", "profile"].includes(e.where))) { setDraft(""); doSlash(`/${name}`); return; }
    setDraft(`/${name} `);
    requestAnimationFrame(() => { grow(); inputRef.current?.focus(); });
  }

  return (
    <>
      {slash.length > 0 && (
        <div className={styles.slash} role="listbox" aria-label={`Your ${aiWord(me.id)}'s own commands`} data-testid="slash-menu">
          {slash.map((c, i) => (
            <Fragment key={c.name}>
              {i === slashBuiltAt && i > 0 && <div className={styles.slashHead} role="presentation">Built in</div>}
              {i === slashOwnAt && i > 0 && <div className={styles.slashHead} role="presentation">Claude Code&apos;s own</div>}
              <button type="button" role="option" aria-selected={i === slashIndex} className={`${styles.slashItem} ${i === slashIndex ? styles.slashOn : ""}`} style={{ "--i": i } as React.CSSProperties}
                ref={i === slashIndex ? (el) => { el?.scrollIntoView({ block: "nearest" }); } : undefined}
                onMouseMove={() => { if (i !== slashIndex) setSlashAt(i); }} onMouseDown={(e) => { e.preventDefault(); pickSlash(c.name); }}>
                <b>/{c.name}</b><span>{c.about || (c.kind === "builtin" ? "Built in" : c.kind === "skill" ? "A skill of yours" : "A command of yours")}</span>
              </button>
            </Fragment>
          ))}
        </div>
      )}
      {atList.length > 0 && (
        <div className={styles.slash} role="listbox" aria-label="Ping someone" data-testid="at-menu">
          {atList.map((p, i) => (
            <button key={p.id} type="button" role="option" aria-selected={i === atIndex} className={`${styles.slashItem} ${i === atIndex ? styles.slashOn : ""}`} style={{ "--i": i } as React.CSSProperties}
              onMouseMove={() => { if (i !== atIndex) setSlashAt(i); }} onMouseDown={(e) => { e.preventDefault(); pickAt(p); }}>
              <b>@{firstName(p.display_name)}</b><span>{p.display_name}{p.role === "owner" ? ", owner" : ""}</span>
            </button>
          ))}
        </div>
      )}
      <form className={styles.composer} onSubmit={(e) => { e.preventDefault(); send(); }}>
        <textarea
          ref={inputRef}
          className={styles.input}
          rows={1}
          maxLength={8000}
          value={draft}
          placeholder={`Message ${chat?.name ?? "the table"}`}
          aria-label="Message the table"
          onPaste={(e) => {
            const t = e.clipboardData.getData("text/plain");
            if (t && (t.length >= 150 || (t.match(/\n/g) || []).length >= 2)) pastedRef.current.push(t);
          }}
          onChange={(e) => { setDraft(e.target.value); setSlashAt(0); grow(); }}
          onKeyDown={(e) => {
            // With the list of their own commands open, the arrows move through it and Enter or Tab takes one.
            if (slash.length > 0) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); return setSlashAt((slashIndex + (e.key === "ArrowDown" ? 1 : slash.length - 1)) % slash.length); }
              if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") { e.preventDefault(); return pickSlash(slash[slashIndex].name); }
              if (e.key === "Escape") { e.preventDefault(); return setDraft(""); }
            }
            if (atList.length > 0) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); return setSlashAt((atIndex + (e.key === "ArrowDown" ? 1 : atList.length - 1)) % atList.length); }
              if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") { e.preventDefault(); return pickAt(atList[atIndex]); }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (e.ctrlKey || e.metaKey) askTable();
              else send();
            }
          }}
        />
        <AttachButtons a={attach} />
        <button className="btn" disabled={(!draft.trim() && attach.pending.length === 0) || attach.busy || attach.recording}>Send</button>
      </form>
    </>
  );
}
