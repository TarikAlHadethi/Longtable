"use client";

import Link from "next/link";
import { useState } from "react";
import { Mark } from "@/components/mark";
import { browserClient } from "@/lib/supabase/browser";
import styles from "./settings.module.css";

type Person = { id: string; display_name: string; role: "owner" | "developer" | "client"; color: string };
type Table = { id: string; name: string; undo_seconds: number; client_chat: string | null; final_seat: string | null; when_final_offline: string };

const ROLE = { owner: "Owner", developer: "Developer", client: "Client" } as const;

// Settings in plain words: the table, who writes the final answer, and the people at the table.
export function SettingsForm({ table, me, people: initialPeople, chats }: {
  table: Table;
  me: string;
  people: Person[];
  chats: { id: string; name: string; is_general: boolean }[];
}) {
  const supabase = browserClient();
  const [name, setName] = useState(table.name);
  const [undo, setUndo] = useState(String(table.undo_seconds));
  const [requests, setRequests] = useState(table.client_chat ?? "");
  const [seat, setSeat] = useState(table.final_seat ?? "");
  const [offline, setOffline] = useState(table.when_final_offline);
  const [people, setPeople] = useState(initialPeople);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const team = people.filter((p) => p.role !== "client");

  async function saveTable(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaved("");
    const { error } = await supabase.rpc("update_table", {
      t: table.id, table_name: name.trim(), undo: Number(undo), requests_chat: requests || null,
    });
    if (error) return setError(error.message);
    setSaved("table");
  }

  async function saveAnswers(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaved("");
    const { error } = await supabase.rpc("set_final_seat", { t: table.id, seat: seat || null, offline });
    if (error) return setError(error.message);
    setSaved("answers");
  }

  async function remove(id: string) {
    setError("");
    const { error } = await supabase.rpc("remove_member", { m: id });
    setConfirming(null);
    if (error) return setError(error.message);
    setPeople((prev) => prev.filter((p) => p.id !== id));
    if (seat === id) setSeat("");
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link href={`/t/${table.id}`} className={styles.back}><Mark size={24} /> Back to {table.name}</Link>
      </header>
      <main className={styles.main}>
        <h1 className={styles.title}>Settings</h1>
        {error && <div className="error" role="alert">{error}</div>}

        <form className={styles.card} onSubmit={saveTable} aria-label="The table">
          <div className={styles.cardTitle}>The table</div>
          <label className="label" htmlFor="s-name">Name</label>
          <input id="s-name" className="field" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          <label className="label" htmlFor="s-undo">Undo window, in seconds</label>
          <input id="s-undo" className="field" type="number" min={5} max={300} value={undo} onChange={(e) => setUndo(e.target.value)} />
          <div className="note">How long a decision can be undone before the client hears it. 5 to 300.</div>
          <label className="label" htmlFor="s-requests">Client requests go to</label>
          <select id="s-requests" className="field" value={requests} onChange={(e) => setRequests(e.target.value)}>
            <option value="">General</option>
            {chats.filter((c) => !c.is_general).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <div className={styles.actions}>
            <button className="btn">Save</button>
            {saved === "table" && <span className={styles.saved} role="status">Saved</span>}
          </div>
        </form>

        <form className={styles.card} onSubmit={saveAnswers} aria-label="Final answers">
          <div className={styles.cardTitle}>Final answers</div>
          <label className="label" htmlFor="s-seat">Whose Claude writes the final answer</label>
          <select id="s-seat" className="field" value={seat} onChange={(e) => setSeat(e.target.value)}>
            <option value="">The owner&apos;s (default)</option>
            {team.map((p) => <option key={p.id} value={p.id}>{p.display_name}&apos;s</option>)}
          </select>
          <div className={styles.radios} role="radiogroup" aria-label="When their computer is off">
            <label><input type="radio" name="offline" checked={offline === "wait"} onChange={() => setOffline("wait")} /> Wait for it</label>
            <label><input type="radio" name="offline" checked={offline === "next"} onChange={() => setOffline("next")} /> Let another connected Claude write it</label>
          </div>
          <div className={styles.actions}>
            <button className="btn">Save</button>
            {saved === "answers" && <span className={styles.saved} role="status">Saved</span>}
          </div>
        </form>

        <section className={styles.card} aria-label="People">
          <div className={styles.cardTitle}>People</div>
          {people.map((p) => (
            <div key={p.id} className={styles.person} data-person={p.display_name}>
              <span className={styles.dot} style={{ background: p.color }} />
              <span className={styles.personName}>{p.display_name}{p.id === me ? " (you)" : ""}</span>
              <span className={styles.role}>{ROLE[p.role]}</span>
              {p.role !== "owner" && (confirming === p.id ? (
                <>
                  <button className="btn" onClick={() => remove(p.id)}>Take {p.display_name.split(" ")[0]} off</button>
                  <button className="btn btn-quiet" onClick={() => setConfirming(null)}>Keep</button>
                </>
              ) : (
                <button className="btn btn-quiet" onClick={() => setConfirming(p.id)}>Take off the table</button>
              ))}
            </div>
          ))}
          <div className="note">Taking someone off ends their access at once and disconnects their AI. Their messages stay.</div>
        </section>
      </main>
    </div>
  );
}
