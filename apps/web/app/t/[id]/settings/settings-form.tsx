"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Select } from "@/components/select";
import { downloadExport } from "@/lib/download";
import { browserClient } from "@/lib/supabase/browser";
import styles from "./settings.module.css";
import { firstName } from "@/lib/names";

type Person = { id: string; display_name: string; role: "owner" | "developer" | "client"; color: string };
type Extra = { undo_seconds: number; client_chat: string | null; final_seat: string | null; when_final_offline: string };
type Github = { connected: boolean; repo: string; last_event_at: string | null } | null;

const ROLE = { owner: "Owner", developer: "Developer", client: "Client" } as const;

export type SettingsData = { extra: Extra | null; github: Github };
type Db = ReturnType<typeof browserClient>;
// The table's own settings and its GitHub link. The room reads these once when it opens, so Settings is complete the
// moment it is shown.
export async function loadSettings(supabase: Db, tableId: string): Promise<SettingsData> {
  const [row, hub] = await Promise.all([
    supabase.from("tables").select("undo_seconds, client_chat, final_seat, when_final_offline").eq("id", tableId).maybeSingle(),
    supabase.rpc("github_status", { t: tableId }),
  ]);
  // A read that failed is not settings: nothing is shown as loaded, so nothing made up can be saved over the real ones.
  if (row.error || !row.data) throw new Error("The table's settings could not be read.");
  return { extra: row.data as Extra, github: (hub.data as Github) ?? null };
}

// Settings in plain words: the table, who writes the final answer, GitHub, your data, and the people at the table.
// It opens inside the room at once and fills in the table's own settings a moment later.
export function SettingsForm({ table, me, people, chats, data, onData, onRenamed, onRemoved }: {
  table: { id: string; name: string };
  me: string;
  people: Person[];
  chats: { id: string; name: string; is_general: boolean }[];
  data: SettingsData | null;
  onData: (d: SettingsData) => void;
  onRenamed: (name: string) => void;
  onRemoved: (id: string) => void;
}) {
  const supabase = browserClient();
  // Saving is only possible once the table's own settings are on screen: before, a failed read showed made-up
  // values (an undo window of 30) as if loaded, and Save wrote them over the real ones.
  const [loaded, setLoaded] = useState(!!data?.extra);
  const [name, setName] = useState(table.name);
  const [undo, setUndo] = useState(data?.extra ? String(data.extra.undo_seconds) : "");
  const [requests, setRequests] = useState(data?.extra?.client_chat ?? "");
  const [seat, setSeat] = useState(data?.extra?.final_seat ?? "");
  const [offline, setOffline] = useState(data?.extra?.when_final_offline ?? "wait");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const team = people.filter((p) => p.role !== "client");
  const [github, setGithubState] = useState<Github>(data?.github ?? null);
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  // What is saved here is kept by the room too, so coming back shows it as it was left: only what was really saved.
  // Each card keeps its own fields; a change typed into the other card and never saved is not kept as if it were.
  const kept = useRef<Extra | null>(data?.extra ?? null);
  const keep = (patch: Partial<Extra>, hub: Github = github) => {
    if (!kept.current) return;
    kept.current = { ...kept.current, ...patch };
    onData({ extra: kept.current, github: hub });
  };
  const setGithub = (g: Github) => { setGithubState(g); keep({}, g); };

  // Only if the room has not read them yet: read them here.
  useEffect(() => {
    if (data) return;
    let cancelled = false;
    loadSettings(supabase, table.id).then((d) => {
      if (cancelled || !d.extra) return;
      setUndo(String(d.extra.undo_seconds)); setRequests(d.extra.client_chat ?? ""); setSeat(d.extra.final_seat ?? ""); setOffline(d.extra.when_final_offline);
      kept.current = d.extra;
      setLoaded(true);
      setGithubState(d.github);
      onData(d);
    }).catch((e: Error) => { if (!cancelled) setError(`${e.message} Open Settings again in a moment.`); });
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
    keep({ undo_seconds: Number(undo), client_chat: requests || null });
    onRenamed(name.trim());
  }

  async function saveAnswers(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaved("");
    const { error } = await supabase.rpc("set_final_seat", { t: table.id, seat: seat || null, offline });
    if (error) return setError(error.message);
    setSaved("answers");
    keep({ final_seat: seat || null, when_final_offline: offline });
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
            <button className="btn" disabled={!loaded}>Save</button>
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
            <button className="btn" disabled={!loaded}>Save</button>
            {saved === "answers" && <span className={styles.saved} role="status">Saved</span>}
          </div>
        </form>

        </div>
        <div className={styles.col}>
        <section className={styles.card} aria-label="GitHub">
          <div className={styles.cardTitle}>GitHub</div>
          <div className="note">Pushes to main, merged pull requests and failed CI runs show up in General. Longtable never keeps any code.</div>
          {github?.connected && !hook && (
            <>
              <div className={styles.connected} data-testid="github-status"><i />Connected{github.repo ? ` to ${github.repo}` : ", waiting for GitHub's first delivery"}</div>
              <div className={styles.actions}>
                <button className="btn btn-quiet" onClick={connectGithub}>New secret</button>
                <button className="btn btn-quiet" onClick={disconnectGithub}>Disconnect</button>
              </div>
            </>
          )}
          {!github?.connected && !hook && <div className={styles.actions}><button className="btn" onClick={connectGithub}>Connect a repo</button></div>}
          {hook && (
            <>
              <div className="note">In the repo on GitHub: Settings, Webhooks, Add webhook. Paste these two, choose application/json, and pick Pushes, Pull requests, Workflow runs and Deployment statuses.</div>
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
                  <button className="btn" onClick={() => remove(p.id)}>Take {firstName(p.display_name)} off</button>
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
