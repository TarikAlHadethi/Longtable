"use client";

import { useEffect, useRef, useState } from "react";
import { Arrow, Check } from "@/components/icons";
import { browserClient } from "@/lib/supabase/browser";
import type { Job, Member, SandboxChange, SandboxRow } from "./types";
import room from "./room.module.css";
import s from "./sandbox-review.module.css";

const WHY: Record<string, string> = {
  "sign-in": "It asks for a sign-in first. Turn off sign-in protection for previews at your hosting, then check again.",
  "not-up": "Nothing is there yet. The hosting may still be putting it up; give it a minute and check again.",
  broken: "It answers with an error. Open it yourself to see what the hosting says.",
  unreachable: "It could not be reached from here.",
};

// One step of the set-up. Kept outside the form on purpose: defined inside, it would be a new component on every
// render, and whatever was being typed or pressed in it would be thrown away each time.
function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children?: React.ReactNode }) {
  return (
    <div className={`${s.step} ${done ? s.stepDone : ""}`} data-step={n} data-done={done || undefined}>
      <span className={s.stepMark}>{done ? <Check size={14} stroke={3} /> : n}</span>
      <div className={s.stepBody}>
        <div className={s.stepTitle}>{title}</div>
        {children}
      </div>
    </div>
  );
}

// Setting a client's copy up, before it is theirs. Five things, in order, each one either done or saying what is
// missing. What Longtable can see for itself it checks; the two it cannot (what data and what keys the copy runs
// with) the owner answers for. It works the same whatever the project and wherever it is hosted.
export function SandboxSetup({ table, client, box, aiOn, jobs, changes, ours, onBox, onGive, giving }: {
  table: { id: string; name: string };
  client: Member;
  box: SandboxRow | null;
  // Whether one of the team's Claudes is on right now: it is what makes the copy and builds each change.
  aiOn: boolean;
  jobs: Job[];
  changes: SandboxChange[];
  ours: string | null;
  onBox: (b: Partial<SandboxRow> & { member_id: string }) => void;
  onGive: () => void;
  giving: boolean;
}) {
  const supabase = browserClient();
  const first = client.display_name.split(" ")[0];
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [typed, setTyped] = useState("");
  const [hub, setHub] = useState<{ connected?: boolean; repo?: string } | null>(null);
  const [check, setCheck] = useState<{ ok: boolean; why: string } | null>(box?.checked_at ? { ok: !!box.open_ok, why: box.open_ok ? "open" : "sign-in" } : null);
  const [words, setWords] = useState("");
  const [data, setData] = useState(false);
  const [keys, setKeys] = useState(false);
  const checked = useRef<string | null>(null);

  useEffect(() => {
    supabase.rpc("github_status", { t: table.id }).then(({ data }: { data: unknown }) => setHub((data as { connected?: boolean; repo?: string } | null) ?? {}));
  }, [supabase, table.id]);

  const making = jobs.some((j) => j.kind === "sandbox" && !j.change_id && j.subject === client.id && ["queued", "running"].includes(j.status));
  const made = !!box?.opened_at;
  const tests = changes.filter((c) => c.member_id === client.id && c.test).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const test = tests[0];

  async function make() {
    setBusy("make");
    setError("");
    const { data: branch, error } = await supabase.rpc("prepare_client_sandbox", { m: client.id });
    setBusy(null);
    if (error) return setError(error.message);
    onBox({ member_id: client.id, mode: box?.mode ?? "chat", branch: (branch as string) ?? box?.branch ?? "" });
  }

  async function saveAddress(e: React.FormEvent) {
    e.preventDefault();
    setBusy("address");
    setError("");
    const { error } = await supabase.rpc("set_sandbox_links", { t: table.id, ours: ours ?? "", cap: null, m: client.id, theirs: typed.trim() });
    setBusy(null);
    if (error) return setError(error.message);
    onBox({ member_id: client.id, url: typed.trim() || null });
  }

  async function look() {
    setBusy("check");
    setError("");
    const res = await fetch("/api/sandbox/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ member: client.id }) });
    const out = (await res.json().catch(() => ({ ok: false, why: "unreachable" }))) as { ok: boolean; why: string };
    setBusy(null);
    setCheck(out);
    onBox({ member_id: client.id, open_ok: out.ok, checked_at: new Date().toISOString() });
  }
  // The first time an address is there, look at once: nobody should have to ask.
  useEffect(() => {
    if (box?.url && checked.current !== box.url && !box.checked_at) { checked.current = box.url; look(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box?.url]);

  async function tryIt(e: React.FormEvent) {
    e.preventDefault();
    if (!words.trim()) return;
    setBusy("test");
    setError("");
    const { error } = await supabase.rpc("team_sandbox_change", { m: client.id, body: words.trim() });
    setBusy(null);
    if (error) return setError(error.message);
    setWords("");
  }

  const steps = [aiOn, made, !!box?.url, !!check?.ok];
  const ready = steps.every(Boolean) && data && keys;
  return (
    <div className={s.setup} data-testid="sandbox-setup">
      <div className={s.termsTitle}>Before {first} gets a copy</div>
      <div className={s.said}>A copy is {table.name} on a branch of its own, put up by your hosting at its own address. {first} says what to change, your team&apos;s AI builds it there, and nothing reaches the real thing until you take it.</div>
      {error && <div className="error" role="alert">{error}</div>}

      <Step n={1} done={aiOn} title="Your team's Claude is on">
        {!aiOn && <div className={s.hint}>It is what makes the copy and builds each change. Connect it from your picture menu, on a computer that stays on while {first} works.</div>}
      </Step>

      <Step n={2} done={made} title={`A place for ${first}'s copy`}>
        {made ? <div className={s.hint}>The branch <code>{box?.branch}</code>, pushed to your repository.</div>
          : making || busy === "make" ? <div className={s.hint}><i className={s.pulse} /> Making the branch and pushing it…</div>
          : <button type="button" className="btn" disabled={!aiOn} onClick={make} data-testid="sandbox-make">Make the copy</button>}
      </Step>

      <Step n={3} done={!!box?.url} title="Where it opens">
        {box?.url ? <a className={s.address} href={box.url} target="_blank" rel="noreferrer" data-testid="setup-address">{box.url} <Arrow size={14} /></a> : (
          <>
            <div className={s.hint}>
              {!made ? "Appears once the copy is made."
                : hub?.connected ? "Waiting for your hosting to say where it put the branch. That takes as long as one deploy. If it never comes, your hosting is not building from this repository, or does not report to GitHub: type the address below."
                : "GitHub is not connected to this table, so the address cannot arrive by itself. Connect it in Table settings, or type the address your hosting gave the branch."}
            </div>
            {made && (
              <form className={s.noteForm} onSubmit={saveAddress}>
                <input className="field" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="https://" inputMode="url" aria-label="Where the copy opens" />
                <button className="btn btn-quiet" disabled={busy === "address" || !typed.trim()}>Use this address</button>
              </form>
            )}
          </>
        )}
      </Step>

      <Step n={4} done={!!check?.ok} title={`${first} can open it without signing in`}>
        {box?.url && (
          <div className={s.hint}>
            {busy === "check" ? "Looking…" : check?.ok ? "It opens for anyone with the address." : check ? WHY[check.why] ?? WHY.unreachable : ""}
            {busy !== "check" && !check?.ok && <> <button type="button" className={room.toolLink} onClick={look} data-testid="setup-check">Check again</button></>}
          </div>
        )}
      </Step>

      <Step n={5} done={!!test && test.status === "ready"} title="Try a change yourself first">
        <div className={s.hint}>Not needed, but it is how you know the first thing {first} asks for will work. {first} never sees your tests.</div>
        {made && (
          <form className={s.noteForm} onSubmit={tryIt}>
            <input className="field" value={words} maxLength={4000} onChange={(e) => setWords(e.target.value)} placeholder="Make the page title blue" aria-label="A change to try" />
            <button className="btn btn-quiet" disabled={busy === "test" || !words.trim() || !aiOn}>Try it</button>
          </form>
        )}
        {test && (
          <div className={s.hint} data-testid="setup-test">
            <b>&ldquo;{test.words}&rdquo;</b> {test.status === "working" ? <><i className={s.pulse} /> being built</> : test.status === "ready" ? "is in the copy." : test.status === "nothing" ? "changed nothing." : "did not work."}
            {test.summary ? ` ${test.summary}` : ""}
            {test.detail ? ` ${test.detail}` : ""}
          </div>
        )}
      </Step>

      <div className={s.answers}>
        <div className={s.stepTitle}>Two things only you can know</div>
        <label className={s.agree}><input type="checkbox" checked={data} onChange={(e) => setData(e.target.checked)} data-testid="setup-data" /> The copy runs on made-up data, not our real data.</label>
        <label className={s.agree}><input type="checkbox" checked={keys} onChange={(e) => setKeys(e.target.checked)} data-testid="setup-keys" /> The copy holds no real keys or passwords.</label>
        <div className={s.hint}>Code {first} asks for runs wherever the copy is put up. Longtable refuses changes to how the product is built, run or kept safe, but that is a strong filter, not a wall.</div>
      </div>

      <div className={s.setupActions}>
        <span className={s.hint}>{ready ? "" : "Each step above has to be done first."}</span>
        <button type="button" className="btn" disabled={!ready || giving} onClick={onGive} data-testid="sandbox-on">Give {first} the copy</button>
      </div>
    </div>
  );
}
