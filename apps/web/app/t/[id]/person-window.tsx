"use client";

import { useEscape } from "@/components/use-escape";
import { useRef, useState } from "react";
import { AI_NAME, AiLogo } from "@/components/ai-logo";
import { Face } from "@/components/face";
import { Check, Crown, Pencil } from "@/components/icons";
import { Time } from "@/components/time";
import { downloadExport } from "@/lib/download";
import { browserClient } from "@/lib/supabase/browser";
import { prettyModel } from "./model-pick";
import { UsagePanel } from "./usage-panel";
import type { Connection, Member } from "./types";
import room from "./room.module.css";
import s from "./panels.module.css";

const ROLE = { owner: "Owner", developer: "Developer", client: "Client" } as const;
const day = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "");

// The colours a picture and a name can take: the table's own seat colours and a few neighbours.
const COLORS = ["oklch(0.62 0.12 30)", "oklch(0.66 0.13 60)", "oklch(0.62 0.1 150)", "oklch(0.58 0.08 170)", "oklch(0.6 0.1 210)",
  "oklch(0.6 0.1 250)", "oklch(0.58 0.12 285)", "oklch(0.6 0.1 310)", "oklch(0.62 0.13 350)", "oklch(0.45 0.02 70)"];

const BUBBLES = ["rose", "peach", "sand", "lime", "mint", "teal", "sky", "blue", "iris", "lilac", "pink", "stone"];

// A photo is shrunk in the browser to a small square before it is kept, so it travels with the person's name.
function shrink(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const size = 160;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const side = Math.min(img.width, img.height);
      canvas.getContext("2d")!.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = () => reject(new Error("That file is not a picture."));
    img.src = URL.createObjectURL(file);
  });
}

// A person, in a window in the middle of the screen. Your own is where you change how you look at this table;
// anyone else's shows who they are, and gives the owner the two things an owner can do.
export function PersonWindow({ table, me, person, connections, here, edit = false, members, onClose, onSaved, onGone }: {
  table: { id: string; name: string };
  me: Member;
  person: Member;
  connections: Connection[];
  here: boolean;
  // Changing how you look is opened from your own picture menu; from the list of people, you see yourself as others do.
  edit?: boolean;
  members: Member[];
  onClose: () => void;
  onSaved: (m: Member) => void;
  onGone: (id: string) => void;
}) {
  useEscape(onClose);
  const supabase = browserClient();
  const isMe = person.id === me.id;
  const mine = isMe && edit;
  const [bubble, setBubble] = useState(person.bubble ?? "stone");
  const taken = new Set(members.filter((m) => m.id !== person.id && m.bubble).map((m) => m.bubble as string));
  const [name, setName] = useState(person.display_name);
  const [color, setColor] = useState(person.color);
  const [nameColor, setNameColor] = useState(person.name_color ?? "");
  const [avatar, setAvatar] = useState(person.avatar ?? "");
  const [status, setStatus] = useState(person.status ?? "");
  const [asking, setAsking] = useState<"owner" | "remove" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const conn = connections.find((c) => c.member_id === person.id && !c.revoked_at);
  const model = conn ? prettyModel(conn.model_choice) ?? (conn.kind === "claude" ? "Opus 5.5" : prettyModel(conn.limits?.model)) : null;
  const first = person.display_name.split(" ")[0];
  const shown = mine ? { display_name: name || person.display_name, color, avatar: avatar || null } : person;
  const changed = mine && (name.trim() !== person.display_name || color !== person.color || nameColor !== (person.name_color ?? "")
    || avatar !== (person.avatar ?? "") || status.trim() !== (person.status ?? "") || bubble !== (person.bubble ?? "stone"));

  async function pickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setError("");
    try { setAvatar(await shrink(f)); } catch (err) { setError((err as Error).message); }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const next = { ...person, display_name: name.trim(), color, name_color: nameColor || null, avatar: avatar || null, status: status.trim(), bubble };
    const { error } = await supabase.rpc("update_profile", {
      t: table.id, new_name: next.display_name, new_color: color, new_name_color: nameColor, new_avatar: avatar, new_status: next.status, new_bubble: bubble,
    });
    setBusy(false);
    if (error) return setError(error.message);
    onSaved(next);
    onClose();
  }

  async function run(fn: "transfer_ownership" | "remove_member") {
    setBusy(true);
    setError("");
    const { error } = await supabase.rpc(fn, { m: person.id });
    setBusy(false);
    setAsking(null);
    if (error) return setError(error.message);
    if (fn === "remove_member") onGone(person.id);
    onClose();
  }

  return (
    <div className={room.modalBack} onClick={onClose}>
      <div className={`${room.modal} ${s.window}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={mine ? "You" : person.display_name} data-testid="person-window">
        <div className={s.hero}>
          <span className={s.faceWrap}>
            {person.role === "owner" && <span className={s.crown}><Crown /></span>}
            {mine ? (
              <button type="button" className={`${s.face} ${s.faceMine}`} style={{ background: shown.color }} onClick={() => file.current?.click()} aria-label="Change your picture">
                <Face who={shown} />
                <span className={s.facePencil}><Pencil size={22} /></span>
              </button>
            ) : (
              <span className={s.face} style={{ background: shown.color }}><Face who={shown} /></span>
            )}
            <i className={here ? s.here : s.away} />
          </span>
          <div className={s.name} style={{ color: (mine ? nameColor : person.name_color) || undefined }}>{mine ? name || person.display_name : person.display_name}</div>
          <div className={s.sub}>{ROLE[person.role]}{(mine ? status : person.status) ? ` · ${mine ? status : person.status}` : ""}</div>
        </div>

        {mine && (
          <form className={s.edit} onSubmit={save} aria-label="How you look at this table">
            <input ref={file} type="file" accept="image/*" hidden onChange={pickPhoto} />
            {avatar && <button type="button" className={`${room.toolLink} ${s.unphoto}`} onClick={() => setAvatar("")}>Use my letter instead</button>}
            <div className={s.field2}>
              <div>
                <label className="label" htmlFor="pf-name">Name</label>
                <input id="pf-name" className="field" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div>
                <label className="label" htmlFor="pf-status">What you are on</label>
                <input id="pf-status" className="field" maxLength={80} value={status} onChange={(e) => setStatus(e.target.value)} placeholder="Booking flow, back Monday…" />
              </div>
            </div>
            <div>
              <div className="label">Picture colour</div>
              <div className={s.swatches} role="radiogroup" aria-label="Picture colour">
                {COLORS.map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} className={s.swatch} style={{ background: c }} onClick={() => setColor(c)}>
                    {color === c && <Check size={14} stroke={3} />}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="label">Bubble colour</div>
              <div className={s.swatches} role="radiogroup" aria-label="Bubble colour">
                {BUBBLES.map((b) => (
                  <button key={b} type="button" role="radio" aria-checked={bubble === b} aria-label={b} disabled={taken.has(b)} title={taken.has(b) ? "Someone else has this one" : undefined}
                    className={`${s.swatch} ${s.swatchBubble}`} data-bubble={b} onClick={() => setBubble(b)}>
                    {bubble === b && <Check size={14} stroke={3} />}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="label">Name colour</div>
              <div className={s.swatches} role="radiogroup" aria-label="Name colour">
                <button type="button" role="radio" aria-checked={!nameColor} aria-label="The usual colour" className={`${s.swatch} ${s.swatchPlain}`} onClick={() => setNameColor("")}>
                  {!nameColor && <Check size={14} stroke={3} />}
                </button>
                {COLORS.slice(0, 9).map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={nameColor === c} aria-label={c} className={s.swatch} style={{ background: c }} onClick={() => setNameColor(c)}>
                    {nameColor === c && <Check size={14} stroke={3} />}
                  </button>
                ))}
              </div>
            </div>
            {error && <div className="error" role="alert">{error}</div>}
            <div className={room.modalActions}>
              <button type="button" className="btn btn-quiet" onClick={onClose}>Close</button>
              <button className="btn" disabled={busy || !changed || !name.trim()}>{busy ? "Saving…" : "Save"}</button>
            </div>
          </form>
        )}

        {!mine && (
          <>
            <div className={s.facts}>
              <div className={s.fact}><span>Joined</span><b>{day(person.created_at) || "Not known"}</b></div>
              <div className={s.fact}>
                <span>AI</span>
                <b className={s.ai}>{conn ? <><AiLogo kind={conn.kind} size={18} />{AI_NAME[conn.kind]}{model ? ` ${model}` : ""}</> : "None connected"}</b>
              </div>
              {conn?.last_seen && <div className={s.fact}><span>Last on</span><b><Time iso={conn.last_seen} style="stamp" /></b></div>}
            </div>
            {person.role !== "client" && conn && <UsagePanel members={[person]} connections={connections} bare />}
            {error && <div className="error" role="alert">{error}</div>}
            {me.role === "owner" && !isMe && asking === "owner" && (
              <div className={s.ask}>
                <p>{first} becomes the owner and you become a developer. Only {first} can hand it back.</p>
                <div className={s.row}>
                  <button className="btn" disabled={busy} onClick={() => run("transfer_ownership")}>Make {first} the owner</button>
                  <button className="btn btn-quiet" onClick={() => setAsking(null)}>Keep it</button>
                </div>
              </div>
            )}
            {me.role === "owner" && !isMe && asking === "remove" && (
              <div className={s.ask}>
                <p>{first} loses access at once and their AI is disconnected. Their messages stay.</p>
                <div className={s.row}>
                  <button className="btn" disabled={busy} onClick={() => run("remove_member")}>Take {first} off</button>
                  <button className="btn btn-quiet" onClick={() => setAsking(null)}>Keep</button>
                </div>
              </div>
            )}
            <div className={room.modalActions}>
              {isMe && (
                <button type="button" className={room.toolLink} style={{ marginRight: "auto" }}
                  onClick={async () => { const p = await downloadExport("export_mine", table.id, table.name); if (p) setError(p); }}>Download what&apos;s mine</button>
              )}
              {me.role === "owner" && !isMe && !asking && (
                <div className={s.row} style={{ marginRight: "auto" }}>
                  {person.role === "developer" && <button className="btn btn-quiet" onClick={() => setAsking("owner")}><Crown size={15} />Make owner</button>}
                  <button className="btn btn-quiet" onClick={() => setAsking("remove")}>Take off the table</button>
                </div>
              )}
              <button className="btn btn-quiet" onClick={onClose}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
