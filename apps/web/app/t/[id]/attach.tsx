"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FileRef } from "./types";
import { PersonalError } from "@/lib/report.mjs";
import s from "./attach.module.css";

// Things attached to a message before it is sent: pictures, files, video, a voice note. They are uploaded when the
// message is sent, into the sender's own folder at this table, and the message carries what each one is.

export type Pending = { id: string; file: File; kind: FileRef["kind"]; preview: string | null };
export type Uploaded = { path: string; name: string; mime: string; size: number; url: string };

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 10;
const kindOf = (mime: string): FileRef["kind"] => (mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "file");
// A name that is safe as part of a storage path and still reads as itself.
const safe = (name: string) => name.normalize("NFKD").replace(/[^A-Za-z0-9._ -]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "file";
export const bytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(n >= 10485760 ? 0 : 1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

export function useAttach(supabase: SupabaseClient, tableId: string, folder: string) {
  const [pending, setPending] = useState<Pending[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const rec = useRef<{ r: MediaRecorder; chunks: Blob[]; stream: MediaStream; tick: ReturnType<typeof setInterval> } | null>(null);

  const add = useCallback((list: FileList | File[] | null) => {
    if (!list) return;
    // Taken now: the browser empties the list it handed over as soon as the box is cleared or the drop ends.
    const files = Array.from(list);
    if (!files.length) return;
    setError("");
    setPending((prev) => {
      const next = [...prev];
      for (const file of files) {
        if (next.length >= MAX_FILES) { setError(`Up to ${MAX_FILES} things in one message.`); break; }
        if (file.size > MAX_BYTES) { setError(`"${file.name}" is over 25 MB, which is the most one attachment can be.`); continue; }
        if (file.size === 0) continue;
        const kind = kindOf(file.type || "");
        next.push({ id: crypto.randomUUID(), file, kind, preview: kind === "image" ? URL.createObjectURL(file) : null });
      }
      return next;
    });
  }, []);
  const remove = useCallback((id: string) => setPending((prev) => {
    const gone = prev.find((p) => p.id === id);
    if (gone?.preview) URL.revokeObjectURL(gone.preview);
    return prev.filter((p) => p.id !== id);
  }), []);
  const clear = useCallback(() => setPending((prev) => { for (const p of prev) if (p.preview) URL.revokeObjectURL(p.preview); return []; }), []);

  // Sends every pending thing to storage and says where each went. Nothing is kept if one of them fails.
  const upload = useCallback(async (): Promise<Uploaded[] | null> => {
    if (!pending.length) return [];
    setBusy(true);
    setError("");
    const done: Uploaded[] = [];
    try {
      for (const p of pending) {
        const path = `${tableId}/${folder}/${crypto.randomUUID()}-${safe(p.file.name)}`;
        const mime = p.file.type || "application/octet-stream";
        const up = await supabase.storage.from("attachments").upload(path, p.file, { contentType: mime, upsert: false });
        if (up.error) throw new PersonalError(`"${p.file.name}" could not be uploaded.`);
        // The address an AI at this table fetches it from. People are shown a fresh one each time they look.
        const signed = await supabase.storage.from("attachments").createSignedUrl(path, 60 * 60 * 24 * 30);
        if (signed.error || !signed.data?.signedUrl) throw new PersonalError(`"${p.file.name}" could not be uploaded.`);
        done.push({ path, name: p.file.name.slice(0, 200), mime, size: p.file.size, url: signed.data.signedUrl });
      }
      return done;
    } catch (e) {
      if (done.length) await supabase.storage.from("attachments").remove(done.map((d) => d.path)).catch(() => {});
      setError(e instanceof Error ? e.message : "That could not be uploaded.");
      return null;
    } finally {
      setBusy(false);
    }
  }, [pending, supabase, tableId, folder]);

  // A voice note: the microphone, recorded here, attached like any file.
  const stopRecording = useCallback((keep = true) => {
    const cur = rec.current;
    if (!cur) return;
    rec.current = null;
    clearInterval(cur.tick);
    cur.r.onstop = () => {
      cur.stream.getTracks().forEach((t) => t.stop());
      if (keep && cur.chunks.length) {
        const type = cur.r.mimeType || "audio/webm";
        const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
        const at = new Date();
        const name = `Voice note ${at.getHours() % 12 || 12}.${String(at.getMinutes()).padStart(2, "0")} ${at.getHours() < 12 ? "am" : "pm"}.${ext}`;
        add([new File(cur.chunks, name, { type: type.split(";")[0] })]);
      }
    };
    try { cur.r.stop(); } catch { cur.stream.getTracks().forEach((t) => t.stop()); }
    setRecording(false);
    setSeconds(0);
  }, [add]);
  const asking = useRef(false);
  const startRecording = useCallback(async () => {
    if (rec.current || asking.current) return;
    setError("");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return setError("This browser cannot record sound.");
    asking.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      asking.current = false;
      const r = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      r.start();
      const tick = setInterval(() => setSeconds((n) => { if (n >= 599) { stopRecording(true); return 0; } return n + 1; }), 1000);
      rec.current = { r, chunks, stream, tick };
      setRecording(true);
    } catch {
      asking.current = false;
      setError("The microphone is not allowed here. Allow it for this site in your browser, then try again.");
    }
  }, [stopRecording]);
  useEffect(() => () => { if (rec.current) { clearInterval(rec.current.tick); rec.current.stream.getTracks().forEach((t) => t.stop()); } }, []);

  return { pending, add, remove, clear, upload, busy, error, setError, recording, seconds, startRecording, stopRecording };
}
export type Attach = ReturnType<typeof useAttach>;

const Clip = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 11.500l-8.300 8.300a5 5 0 0 1-7.100-7.100l8.500-8.500a3.300 3.300 0 0 1 4.700 4.700l-8.500 8.500a1.700 1.700 0 0 1-2.400-2.400l7.800-7.800" />
  </svg>
);
const Mic = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.500 11a6.500 6.500 0 0 0 13 0M12 17.500V21" />
  </svg>
);

const Cross = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
);
const Stop = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2.500" /></svg>
);

// The two buttons beside the message box: attach, and record.
export function AttachButtons({ a, disabled }: { a: Attach; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const clock = `${Math.floor(a.seconds / 60)}:${String(a.seconds % 60).padStart(2, "0")}`;
  return (
    <div className={s.buttons}>
      <input ref={input} type="file" multiple hidden data-testid="attach-input" onChange={(e) => { a.add(e.target.files); e.target.value = ""; }} />
      {a.recording ? (
        <>
          <span className={s.recording} role="status"><i className={s.recDot} />{clock}</span>
          <button type="button" className={s.icon} onClick={() => a.stopRecording(false)} aria-label="Throw the recording away" title="Throw away"><Cross /></button>
          <button type="button" className={`${s.icon} ${s.iconOn}`} onClick={() => a.stopRecording(true)} aria-label="Stop and attach the recording" title="Stop and attach" data-testid="attach-stop"><Stop /></button>
        </>
      ) : (
        <>
          <button type="button" className={s.icon} disabled={disabled} onClick={() => input.current?.click()} aria-label="Attach a picture, a file or a video" title="Attach" data-testid="attach-button"><Clip /></button>
          <button type="button" className={s.icon} disabled={disabled} onClick={a.startRecording} aria-label="Record a voice note" title="Record a voice note" data-testid="attach-record"><Mic /></button>
        </>
      )}
    </div>
  );
}

// What is waiting to go with the message.
export function AttachTray({ a }: { a: Attach }) {
  // One taken off is shown leaving first, and only then dropped from what is waiting.
  const [leaving, setLeaving] = useState<string[]>([]);
  if (!a.pending.length && !a.error) return null;
  return (
    <div className={`${s.tray} ${a.busy ? s.trayBusy : ""}`} data-testid="attach-tray">
      {a.pending.map((p) => (
        <div key={p.id} className={`${s.chip} ${leaving.includes(p.id) ? s.chipOut : ""}`}
          onAnimationEnd={(e) => { if (e.target === e.currentTarget && leaving.includes(p.id)) { setLeaving((l) => l.filter((id) => id !== p.id)); a.remove(p.id); } }}>
          {p.preview ? <img className={s.thumb} src={p.preview} alt="" /> : <span className={s.kind}>{p.kind === "audio" ? "Voice" : p.kind === "video" ? "Video" : "File"}</span>}
          <span className={s.chipName}>{p.file.name}</span>
          <span className={s.chipSize}>{bytes(p.file.size)}</span>
          <button type="button" className={s.chipRemove} onClick={() => setLeaving((l) => [...l, p.id])} aria-label={`Remove ${p.file.name}`}><Cross /></button>
        </div>
      ))}
      {a.busy && <span className={s.note} role="status"><i />Uploading…</span>}
      {a.error && <span className={s.error} role="alert">{a.error}</span>}
    </div>
  );
}

// Drop and paste, for whatever box wraps the composer. While files are held over it the box is marked, so the
// stylesheet can show where they will land; the mark is the element's own, not state, so nothing redraws.
export function dropHandlers(a: Attach) {
  return {
    onDragOver: (e: React.DragEvent<HTMLElement>) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); e.currentTarget.dataset.drop = "1"; } },
    onDragLeave: (e: React.DragEvent<HTMLElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) delete e.currentTarget.dataset.drop; },
    onDrop: (e: React.DragEvent<HTMLElement>) => { delete e.currentTarget.dataset.drop; if (e.dataTransfer.files.length) { e.preventDefault(); a.add(e.dataTransfer.files); } },
    onPaste: (e: React.ClipboardEvent) => {
      if (!e.clipboardData.files.length) return;
      a.add(e.clipboardData.files);
      if (!e.clipboardData.getData("text/plain")) e.preventDefault();
    },
  };
}

// Addresses to show attachments by, asked for once per file and kept for the life of the page.
const shown = new Map<string, { url: string; until: number }>();
function useShown(supabase: SupabaseClient, files: FileRef[]) {
  const [, bump] = useState(0);
  // Each address lasts an hour and is kept for fifty minutes; looking again every ten keeps every picture showing on
  // a page left open all day, where before they all broke after the first hour.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 10 * 60 * 1000);
    return () => clearInterval(t);
  }, []);
  const key = files.map((f) => f.path).join("|");
  useEffect(() => {
    const need = files.filter((f) => { const have = shown.get(f.path); return !have || have.until < Date.now(); }).map((f) => f.path);
    if (!need.length) return;
    let off = false;
    supabase.storage.from("attachments").createSignedUrls(need, 3600).then(({ data }) => {
      if (off || !data) return;
      for (const d of data) if (d.path && d.signedUrl) shown.set(d.path, { url: d.signedUrl, until: Date.now() + 50 * 60 * 1000 });
      bump((n) => n + 1);
    });
    return () => { off = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, supabase, tick]);
  return (path: string) => shown.get(path)?.url ?? null;
}

// What a message carries, shown under its words: pictures as pictures, sound and video to play, files to open.
export function Files({ supabase, files }: { supabase: SupabaseClient; files?: FileRef[] | null }) {
  const list = files ?? [];
  const at = useShown(supabase, list);
  if (!list.length) return null;
  return (
    <div className={s.files} data-testid="files">
      {list.map((f) => {
        const url = at(f.path);
        if (f.kind === "image") return url
          ? <a key={f.id} href={url} target="_blank" rel="noreferrer" className={s.picture}><img src={url} alt={f.name} loading="lazy" /></a>
          : <span key={f.id} className={s.loading}>{f.name}</span>;
        if (f.kind === "video") return url ? <video key={f.id} className={s.video} src={url} controls preload="metadata" /> : <span key={f.id} className={s.loading}>{f.name}</span>;
        if (f.kind === "audio") return (
          <div key={f.id} className={s.audio}>
            <span className={s.audioName}>{f.name}</span>
            {url ? <audio src={url} controls preload="metadata" /> : <span className={s.loading}>…</span>}
          </div>
        );
        return (
          <a key={f.id} className={s.file} href={url ?? undefined} target="_blank" rel="noreferrer" download={f.name}>
            <span className={s.fileName}>{f.name}</span>
            <span className={s.fileSize}>{bytes(f.size)}</span>
          </a>
        );
      })}
    </div>
  );
}
