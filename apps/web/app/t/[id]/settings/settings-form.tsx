"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Select } from "@/components/select";
import { downloadExport } from "@/lib/download";
import { browserClient } from "@/lib/supabase/browser";
import styles from "./settings.module.css";

type Person = { id: string; display_name: string; role: "owner" | "developer" | "client"; color: string };
type Extra = { undo_seconds: number; client_chat: string | null; final_seat: string | null; when_final_offline: string };
type Github = { connected: boolean; repo: string; last_event_at: string | null } | null;

const ROLE = { owner: "Owner", developer: "Developer", client: "Client" } as const;

// Settings in plain words: the table, who writes the final answer, GitHub, your data, and the people at the table.
// It opens inside the room at once and fills in the table's own settings a moment later.
export function SettingsForm({ table, me, people, chats, onRenamed, onRemoved }: {
  table: { id: string; name: string };
  me: string;
  people: Person[];
  chats: { id: string; name: string; is_general: boolean }[];
  onRenamed: (name: string) => void;
  onRemoved: (id: string) => void;
}) {
  const supabase = browserClient();
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState(table.name);
  const [undo, setUndo] = useState("30");
  const [requests, setRequests] = useState("");
  const [seat, setSeat] = useState("");
  const [offline, setOffline] = useState("wait");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const team = people.filter((p) => p.role !== "client");
  const [github, setGithub] = useState<Github>(null);
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [confirmName, setConfirmName] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      supabase.from("tables").select("undo_seconds, client_chat, final_seat, when_final_offline").eq("id", table.id).maybeSingle(),
      supabase.rpc("github_status", { t: table.id }),
    ]).then(([row, hub]: [{ data: unknown }, { data: unknown }]) => {
      if (cancelled) return;
      const x = row.data as Extra | null;
      if (x) { setUndo(String(x.undo_seconds)); setRequests(x.client_chat ?? ""); setSeat(x.final_seat ?? ""); setOffline(x.when_final_offline); }
      setGithub((hub.data as Github) ?? null);
      setLoaded(true);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table.id]);

  async function download() {
    setError("");
    const problem = await downloadExport("export_table", table.id, table.name);
    if (problem) setError(problem);
  }

  async function deleteTable(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const { error } = await supabase.rpc("delete_table", { t: table.id, confirm_name: confirmName });
    if (error) return setError(error.message);
    router.replace("/?deleted=1");
  }
  const [hook, setHook] = useState<{ url: string; secret: string } | null>(null);

  // A webhook for this table: the URL and a secret, shown once, to paste into the repo's settings on GitHub.
  async function connectGithub() {
    setError("");
    const { data, error } = await supabase.rpc("connect_github", { t: table.id });
    if (error || !data) return setError(error?.message ?? "That did not work. Try again.");
    setHook({ url: `${window.location.origin}/api/github/${table.id}`, secret: data as string });
    setGithub({ connected: true, repo: "", last_event_at: null });
  }

  async function disconnectGithub() {
    setError("");
    const { error } = await supabase.rpc("disconnect_github", { t: table.id });
    if (error) return setError(error.message);
    setGithub(null);
    setHook(null);
  }

  async function saveTable(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaved("");
    const { error } = await supabase.rpc("update_table", {
      t: table.id, table_name: name.trim(), undo: Number(undo), requests_chat: requests || null,
    });
    if (error) return setError(error.message);
    setSaved("table");
    onRenamed(name.trim());
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
    onRemoved(id);
    if (seat === id) setSeat("");
  }

  return (
    <div className={`${styles.cols} ${loaded ? "" : styles.loadingForm}`} data-testid="settings-panel">
        {error && <div className={`error ${styles.wide}`} role="alert">{error}</div>}

        <div className={styles.col}>
        <form className={styles.card} onSubmit={saveTable} aria-label="The table">
          <div className={styles.cardTitle}>The table</div>
          <label className="label" htmlFor="s-name">Name</label>
          <input id="s-name" className="field" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          <label className="label" htmlFor="s-undo">Undo window, in seconds</label>
          <input id="s-undo" className="field" type="number" min={5} max={300} value={undo} onChange={(e) => setUndo(e.target.value)} />
          <div className="note">How long a decision can be undone before the client hears it. 5 to 300.</div>
          <label className="label" htmlFor="s-requests">Client requests go to</label>
          <Select id="s-requests" value={requests} onChange={setRequests}
            options={[{ value: "", label: "General" }, ...chats.filter((c) => !c.is_general).map((c) => ({ value: c.id, label: c.name }))]} />
          <div className={styles.actions}>
            <button className="btn">Save</button>
            {saved === "table" && <span className={styles.saved} role="status">Saved</span>}
          </div>
        </form>

        <form className={styles.card} onSubmit={saveAnswers} aria-label="Final answers">
          <div className={styles.cardTitle}>Final answers</div>
          <label className="label" htmlFor="s-seat">Whose AI writes the final answer</label>
          <Select id="s-seat" value={seat} onChange={setSeat}
            options={[{ value: "", label: "The owner's (default)" }, ...team.map((p) => ({ value: p.id, label: `${p.display_name}'s` }))]} />
          <div className={styles.radios} role="radiogroup" aria-label="When their computer is off">
            <label><input type="radio" name="offline" checked={offline === "wait"} onChange={() => setOffline("wait")} /> Wait for it</label>
            <label><input type="radio" name="offline" checked={offline === "next"} onChange={() => setOffline("next")} /> Let another connected AI write it</label>
          </div>
          <div className={styles.actions}>
            <button className="btn">Save</button>
            {saved === "answers" && <span className={styles.saved} role="status">Saved</span>}
          </div>
        </form>

        </div>
        <div className={styles.col}>
        <section className={styles.card} aria-label="GitHub">
          <div className={styles.cardTitle}>GitHub</div>
          <div className="note">Pushes to main, merged pull requests and failed CI runs show up in General. Longtable never keeps any code.</div>
          {github?.connected && !hook && (
            <div className={styles.actions}>
              <span data-testid="github-status">Connected{github.repo ? ` to ${github.repo}` : ", waiting for GitHub's first delivery"}</span>
              <button className="btn btn-quiet" onClick={connectGithub}>New secret</button>
              <button className="btn btn-quiet" onClick={disconnectGithub}>Disconnect</button>
            </div>
          )}
          {!github?.connected && !hook && <div className={styles.actions}><button className="btn" onClick={connectGithub}>Connect a repo</button></div>}
          {hook && (
            <>
              <div className="note">In the repo on GitHub: Settings, Webhooks, Add webhook. Paste these two, choose application/json, and pick Pushes, Pull requests and Workflow runs.</div>
              <label className="label">Payload URL</label>
              <input className="field" readOnly value={hook.url} data-testid="github-url" onFocus={(e) => e.target.select()} />
              <label className="label">Secret (shown once)</label>
              <input className="field" readOnly value={hook.secret} data-testid="github-secret" onFocus={(e) => e.target.select()} />
            </>
          )}
        </section>

        <section className={styles.card} aria-label="Your data">
          <div className={styles.cardTitle}>Your data</div>
          <div className="note">Everything this table holds, as one file: people, chats, messages, decisions, requests, what clients were told and the log. Never anyone&apos;s sign-in, and never a client&apos;s private chat with their own AI.</div>
          <div className={styles.actions}><button className="btn btn-quiet" onClick={download}>Download everything</button></div>
          {!deleting ? (
            <div className={styles.actions}><button className="btn btn-quiet" onClick={() => setDeleting(true)}>Delete this table</button></div>
          ) : (
            <form onSubmit={deleteTable} className={styles.card} style={{ borderColor: "oklch(0.75 0.1 30)" }} aria-label="Delete this table">
              <div className="note">This deletes the table and everything in it for everyone, the activity log included. It cannot be undone. Type <strong>{table.name}</strong> to confirm.</div>
              <input className="field" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} aria-label="Type the table's name" />
              <div className={styles.actions}>
                <button className="btn" disabled={confirmName.trim() !== table.name}>Delete it for good</button>
                <button type="button" className="btn btn-quiet" onClick={() => { setDeleting(false); setConfirmName(""); }}>Keep it</button>
              </div>
            </form>
          )}
        </section>

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
        </div>
    </div>
  );
}
