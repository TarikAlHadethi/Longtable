"use client";

import { useEffect, useState } from "react";
import { Select } from "@/components/select";
import { browserClient } from "@/lib/supabase/browser";
import { firstName } from "@/lib/names";
import { Switch } from "../seat-windows";
import panels from "../panels.module.css";
import styles from "./settings.module.css";

export type Person = { id: string; display_name: string; role: "owner" | "developer" | "client"; color: string; test?: boolean;
  can_settings?: boolean; can_invite?: boolean; can_clients?: boolean };

// One person, a row that opens to what can be done about them: their access, making them a co-owner, taking them
// off. Nothing is a big button until it is wanted.
function Row({ p, me, mainOwner, open, label, children }: { p: Person; me: string; mainOwner: string | null; open: boolean; label: string; children?: React.ReactNode }) {
  return (
    <details className={styles.row} open={open || undefined} data-person={p.display_name}>
      <summary className={styles.rowHead}>
        <span className={styles.dot} style={{ background: p.color }} />
        <span className={styles.personName}>{p.display_name}{p.id === me ? " (you)" : ""}</span>
        <span className={styles.role}>{label}</span>
        {children ? <span className={styles.chevron} aria-hidden="true" /> : null}
      </summary>
      {children && <div className={styles.rowBody}>{children}</div>}
    </details>
  );
}

// The team: who owns the table, who may change what, and taking someone off.
export function PeopleSettings({ tableId, me, mainOwner, myRole, people, focus, onChanged, onRemoved }: {
  tableId: string; me: string; mainOwner: string | null; myRole: Person["role"]; people: Person[]; focus?: string | null;
  onChanged: (id: string, patch: Partial<Person>) => void; onRemoved: (id: string) => void;
}) {
  const supabase = browserClient();
  const [error, setError] = useState("");
  const [sure, setSure] = useState<string | null>(null);
  const iAmMain = me === mainOwner;
  const iOwn = myRole === "owner";
  const team = people.filter((p) => p.role !== "client").sort((a, b) => Number(b.id === mainOwner) - Number(a.id === mainOwner) || Number(b.role === "owner") - Number(a.role === "owner"));

  async function access(p: Person, patch: { settings?: boolean; invite?: boolean; clients?: boolean }) {
    setError("");
    const before = { can_settings: p.can_settings, can_invite: p.can_invite, can_clients: p.can_clients };
    onChanged(p.id, { ...(patch.settings !== undefined ? { can_settings: patch.settings } : {}), ...(patch.invite !== undefined ? { can_invite: patch.invite } : {}), ...(patch.clients !== undefined ? { can_clients: patch.clients } : {}) });
    const { error } = await supabase.rpc("set_member_access", { m: p.id, settings: patch.settings ?? null, invite: patch.invite ?? null, clients: patch.clients ?? null });
    if (error) { onChanged(p.id, before); setError("That did not save. Try again."); }
  }
  async function coOwner(p: Person, co: boolean) {
    setError("");
    const { error } = await supabase.rpc("set_co_owner", { m: p.id, co });
    if (error) return setError(error.message);
    onChanged(p.id, { role: co ? "owner" : "developer" });
  }
  async function remove(p: Person) {
    setError("");
    const { error } = await supabase.rpc("remove_member", { m: p.id });
    setSure(null);
    if (error) return setError(error.message);
    onRemoved(p.id);
  }
  const takeOff = (p: Person) => sure === p.id ? (
    <span className={styles.rowActions}>
      <button className="btn" onClick={() => remove(p)}>Take {firstName(p.display_name)} off</button>
      <button className="btn btn-quiet" onClick={() => setSure(null)}>Keep</button>
    </span>
  ) : <button className={styles.quietLink} onClick={() => setSure(p.id)}>Take off the table</button>;

  return (
    <section className={styles.card} aria-label="People">
      <div className={styles.cardTitle}>The team</div>
      {error && <div className="error" role="alert">{error}</div>}
      {team.map((p) => {
        const main = p.id === mainOwner;
        const label = main ? "Main owner" : p.role === "owner" ? "Co-owner" : "Developer";
        let body: React.ReactNode = null;
        if (!main && p.role === "developer" && iOwn) {
          body = (
            <>
              <div className={panels.switches}>
                <Switch on={!!p.can_settings} onChange={(v) => access(p, { settings: v })} testid="may-settings" title="The table's settings" about="Name, where the code is, final answers, GitHub." />
                <Switch on={!!p.can_invite} onChange={(v) => access(p, { invite: v })} testid="may-invite" title="Invite people" about="Teammates and clients." />
                <Switch on={!!p.can_clients} onChange={(v) => access(p, { clients: v })} testid="may-clients" title="The clients" about="Who answers them, their copy." />
              </div>
              <span className={styles.rowActions}>
                {iAmMain && <button className="btn btn-quiet" onClick={() => coOwner(p, true)} data-testid="make-co-owner">Make co-owner</button>}
                {takeOff(p)}
              </span>
            </>
          );
        } else if (!main && p.role === "owner" && iAmMain) {
          body = (
            <>
              <div className="note">A co-owner can change everything except deleting the table and taking you off.</div>
              <span className={styles.rowActions}>
                <button className="btn btn-quiet" onClick={() => coOwner(p, false)} data-testid="make-developer">Make developer again</button>
                {takeOff(p)}
              </span>
            </>
          );
        }
        return <Row key={p.id} p={p} me={me} mainOwner={mainOwner} open={focus === p.id} label={label}>{body}</Row>;
      })}
      <div className="note">Owners can change everything. A developer changes only what you turn on here.</div>
    </section>
  );
}

// The clients: who answers each one, and taking a client off.
export function ClientSettings({ tableId, me, people, answerers, setAnswerer, savedFor, focus, onRemoved, copies, onCopies }: {
  tableId: string; me: string; people: Person[]; answerers: Record<string, "own" | "table">; setAnswerer: (m: string, who: "own" | "table") => void;
  savedFor: string; focus?: string | null; onRemoved: (id: string) => void;
  copies: { preview_url: string | null; cap: number | null; paths: string | null } | null | undefined; onCopies: (c: { preview_url: string | null; cap: number | null; paths: string | null }) => void;
}) {
  const supabase = browserClient();
  const [error, setError] = useState("");
  const [sure, setSure] = useState<string | null>(null);
  const clients = people.filter((p) => p.role === "client");
  // A client's own copy, for every client at the table: how many changes a day, which folders it may change, and
  // where the team's own site opens to compare against.
  const [cap, setCap] = useState(copies ? (copies.cap === null ? "0" : String(copies.cap)) : "20");
  const [paths, setPaths] = useState(copies?.paths ?? "");
  const [ours, setOurs] = useState(copies?.preview_url ?? "");
  const [copySaved, setCopySaved] = useState(false);
  // Shown and saved only once really read: before, a save would write the defaults over what was there.
  const read = copies !== undefined;
  useEffect(() => {
    if (copies === undefined) return;
    setCap(copies ? (copies.cap === null ? "0" : String(copies.cap)) : "20");
    setPaths(copies?.paths ?? "");
    setOurs(copies?.preview_url ?? "");
  }, [copies]);
  async function saveCopies(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setCopySaved(false);
    const { error } = await supabase.rpc("set_sandbox_links", { t: tableId, ours, cap: Number(cap), folders: paths });
    if (error) return setError(error.message);
    setCopySaved(true);
    onCopies({ preview_url: ours.trim() || null, cap: Number(cap) <= 0 ? null : Number(cap), paths: paths.trim() || null });
  }
  async function remove(p: Person) {
    setError("");
    const { error } = await supabase.rpc("remove_member", { m: p.id });
    setSure(null);
    if (error) return setError(error.message);
    onRemoved(p.id);
  }
  return (
    <section className={styles.card} aria-label="Clients" data-testid="clients-settings">
      <div className={styles.cardTitle}>Clients</div>
      {error && <div className="error" role="alert">{error}</div>}
      {clients.length === 0 && <div className="note">No clients at this table yet. Invite one from your picture&apos;s menu.</div>}
      {clients.map((c) => (
        <Row key={c.id} p={c} me={me} mainOwner={null} open={focus === c.id} label={c.test ? "Test client" : "Client"}>
          <label className="label" htmlFor={`who-${c.id}`}>Who answers {firstName(c.display_name)}</label>
          <Select id={`who-${c.id}`} value={answerers[c.id] ?? "own"} onChange={(v) => setAnswerer(c.id, v as "own" | "table")}
            options={[{ value: "own", label: "Their own AI when it is on, else the table" }, { value: "table", label: "Always the table" }]} />
          {savedFor === `client-${c.id}` && <span className={styles.saved} role="status">Saved</span>}
          {!c.test && (
            <span className={styles.rowActions}>
              {sure === c.id ? (
                <>
                  <button className="btn" onClick={() => remove(c)}>Take {firstName(c.display_name)} off</button>
                  <button className="btn btn-quiet" onClick={() => setSure(null)}>Keep</button>
                </>
              ) : <button className={styles.quietLink} onClick={() => setSure(c.id)}>Take off the table</button>}
            </span>
          )}
        </Row>
      ))}
      <form className={styles.copies} onSubmit={saveCopies} aria-label="Their own copies">
        <div className={styles.cardTitle}>Their own copies</div>
        <div className="note">A client given a copy changes it freely; you decide what to take. Give one from their row&apos;s person window.</div>
        <label className="label" htmlFor="copy-cap">Changes a day, for each client</label>
        <Select id="copy-cap" value={cap} onChange={setCap}
          options={[{ value: "5", label: "5" }, { value: "10", label: "10" }, { value: "20", label: "20" }, { value: "50", label: "50" }, { value: "0", label: "As many as they like" }]} />
        <label className="label" htmlFor="copy-paths">Folders a copy may change</label>
        <input id="copy-paths" className="field" value={paths} onChange={(e) => setPaths(e.target.value)} placeholder="Any the guard allows, or for example apps/web/app" />
        <label className="label" htmlFor="copy-ours">Where your own site opens</label>
        <input id="copy-ours" className="field" value={ours} onChange={(e) => setOurs(e.target.value)} placeholder="https://" />
        <span className={styles.rowActions}>
          <button className="btn" disabled={!read}>Save</button>
          {copySaved && <span className={styles.saved} role="status">Saved</span>}
        </span>
      </form>
    </section>
  );
}
