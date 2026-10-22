"use client";

import { useEffect, useState } from "react";
import { useClosing, useEscape } from "@/components/use-escape";
import { Select } from "@/components/select";
import { browserClient } from "@/lib/supabase/browser";
import { Grow } from "@/components/grow";
import { Switch } from "./seat-windows";
import type { Chat, Member } from "./types";
import styles from "./room.module.css";

type Who = "everyone" | "some" | "me";
type Answers = "normal" | "named" | "silent";

const ANSWERS: { value: Answers; label: string }[] = [
  { value: "normal", label: "When they are needed" },
  { value: "named", label: "Only when someone names an AI" },
  { value: "silent", label: "Never: they only read" },
];

// Setting a chat up: its name and what it is for, who is in it (everyone, people picked, or just you), whether an AI
// keeps notes of it, and how the AIs answer. A new chat from the "+" is made here; an existing one (the table's own
// Chat room, or any its maker or an owner opens) is changed here. Who is in a private chat is kept by the database.
export function ChatSetup({ tableId, me, people, chat, name: typed = "", onDone, onClose }: {
  tableId: string;
  me: string;
  people: Member[];
  chat: Chat | null;
  name?: string;
  onDone: (id: string) => void;
  onClose: () => void;
}) {
  const [shut, close] = useClosing(onClose);
  useEscape(close);
  const first = chat && !chat.set_up;
  const [name, setName] = useState(chat?.name ?? typed);
  const [about, setAbout] = useState(chat?.about ?? "");
  const [who, setWho] = useState<Who>(chat?.private ? "some" : "everyone");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState(chat?.notes ?? false);
  const [answers, setAnswers] = useState<Answers>(chat?.answers ?? "normal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const team = people.filter((p) => p.role !== "client" && p.id !== me);
  // A private chat being changed starts from who is in it now: just its maker, or the people picked.
  useEffect(() => {
    if (!chat?.private) return;
    browserClient().from("chat_people").select("member_id").eq("chat_id", chat.id).then(({ data }: { data: { member_id: string }[] | null }) => {
      const others = ((data ?? []) as { member_id: string }[]).map((r) => r.member_id).filter((x) => x !== me);
      setPicked(new Set(others));
      setWho(others.length ? "some" : "me");
    });
  }, [chat?.id, chat?.private, me]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Give the chat a name.");
    setBusy(true);
    setError("");
    // How the AIs answer is a choice only alongside the note-taker; without notes they answer as usual.
    const args = { chat_name: name.trim(), chat_about: about.trim(), who, people: who === "some" ? [...picked] : [], take_notes: notes, ai_answers: notes ? answers : "normal" };
    const { data, error } = chat
      ? await browserClient().rpc("setup_chat", { c: chat.id, ...args })
      : await browserClient().rpc("make_chat", { t: tableId, ...args });
    setBusy(false);
    if (error) return setError(error.message);
    onDone(chat ? chat.id : (data as string));
    close();
  }

  const tile = (value: Who, title: string, line: string) => (
    <button type="button" className={`${styles.roleTile} ${who === value ? styles.roleTileOn : ""}`} aria-pressed={who === value}
      onClick={() => setWho(value)} data-testid={`who-${value}`}><b>{title}</b><span>{line}</span></button>
  );

  return (
    <div className={`${styles.modalBack} ${shut ? styles.closing : ""}`} onClick={close}>
      <form className={styles.modal} onClick={(e) => e.stopPropagation()} onSubmit={save} role="dialog" aria-label="Set up the chat" data-testid="chat-setup">
        <div className={styles.modalTitle}>{chat ? (first ? `Set up ${chat.name}` : `${chat.name}: how it is set up`) : "A new chat"}</div>
        <div className={styles.inviteForm}>
          <input className="field" autoFocus={!chat} maxLength={60} value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Name the chat" aria-label={chat ? "The chat's name" : "Name the new chat"} data-testid="setup-name" />
          <input className="field" maxLength={140} value={about} onChange={(e) => setAbout(e.target.value)}
            placeholder="What it is for (optional)" aria-label="What the chat is for" />
          {!chat?.is_general && (
            <>
              <div className={styles.setupLabel}>Who is in it</div>
              <div className={`${styles.roleTiles} ${styles.roleTiles3}`}>
                {tile("everyone", "Everyone", "The whole team")}
                {tile("some", "People I pick", "Only them and you")}
                {tile("me", "Just me", "Nobody else sees it")}
              </div>
              <Grow>
                {who === "some" && (
                  <div className={styles.setupPeople} data-testid="setup-people">
                    {team.length === 0 && <div className="note">Nobody else is on the team yet.</div>}
                    {team.map((p) => (
                      <label key={p.id} className={styles.setupPerson}>
                        <input type="checkbox" checked={picked.has(p.id)} onChange={(e) => setPicked((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(p.id); else next.delete(p.id);
                          return next;
                        })} />
                        {p.display_name}
                      </label>
                    ))}
                  </div>
                )}
              </Grow>
            </>
          )}
          <Switch on={notes} onChange={setNotes} title="An AI takes notes" about="It reads along without answering and keeps the notes as a handout." testid="setup-notes" />
          {/* Greyed until notes are on: with nobody taking notes, AIs that never answer would be no use. */}
          <div className={`${styles.setupAnswers} ${notes ? "" : styles.setupAnswersOff}`} aria-disabled={!notes} data-testid="setup-answers">
            <div className={styles.setupLabel}>The AIs answer</div>
            <Select value={notes ? answers : "normal"} options={ANSWERS} onChange={(v) => setAnswers(v as Answers)} label="How the AIs answer" />
            {!notes && <div className={styles.setupHint}>Turn on notes to choose this.</div>}
          </div>
        </div>
        {error && <div className="error">{error}</div>}
        <div className={styles.modalActions}>
          <button type="button" className="btn btn-quiet" onClick={close}>Cancel</button>
          <button className="btn" disabled={busy || !name.trim()} data-testid="setup-save">{chat ? (first ? "Set it up" : "Save") : "Make the chat"}</button>
        </div>
      </form>
    </div>
  );
}
