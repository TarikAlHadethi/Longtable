"use client";

import { AI_NAME, type AiKind } from "@/components/ai-logo";
import { Face } from "@/components/face";
import { Gear, Moon, Pencil, Plug, Plus, SignOut, Sun } from "@/components/icons";
import { useEffect, useRef, useState } from "react";
import { browserClient } from "@/lib/supabase/browser";
import { noticesOn, setNoticesOn, setSoundOn, soundOn } from "@/lib/chime";
import type { Member } from "./types";
import styles from "./room.module.css";

const ROLE_WORD = { owner: "Owner", developer: "Developer", client: "Client" } as const;

// The person's own menu, behind their picture: invite, settings, the light or dark look, and signing out.
export function ProfileMenu({ me, tableId, onInvite, ai, aiWord, onConnect, onDisconnect, onMe, onSettings, onLogs, onDownload, privacy, onTable, tableWord }: {
  me: Member;
  tableId: string;
  onInvite?: () => void;
  ai?: AiKind | null;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onMe?: () => void;
  onSettings?: () => void;
  onLogs?: () => void;
  // What a client calls theirs: an assistant, not an AI.
  aiWord?: string;
  // For a client: a copy of what is theirs, and the privacy page.
  onDownload?: () => void;
  privacy?: boolean;
  // Everything about the table: its settings for whoever may change them, the logs for everyone else.
  onTable?: () => void;
  tableWord?: string;
}) {
  const [open, setOpen] = useState(false);
  const [dark, setDark] = useState(false);
  const [sound, setSound] = useState(true);
  const [notices, setNotices] = useState(false);
  const [noticeNote, setNoticeNote] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { setDark(document.documentElement.dataset.theme === "dark"); setSound(soundOn()); setNotices(noticesOn()); }, []);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  function look(next: boolean) {
    setDark(next);
    document.documentElement.dataset.theme = next ? "dark" : "light";
    try { localStorage.setItem("lt-theme", next ? "dark" : "light"); } catch {}
  }

  function pickSound(on: boolean) { setSound(on); setSoundOn(on); }
  async function pickNotices(on: boolean) {
    const now = await setNoticesOn(on);
    setNotices(now);
    setNoticeNote(on && !now ? "Your browser has notices turned off for this site." : "");
  }

  async function signOut() {
    await browserClient().auth.signOut();
    window.location.href = "/";
  }

  return (
    <div className={styles.me} ref={ref}>
      <button className={styles.meButton} style={{ background: me.color }} aria-label="Your menu" aria-haspopup="menu" aria-expanded={open}
        data-testid="me-menu" data-connected={ai ?? undefined} onClick={() => setOpen(!open)}>
        <Face who={me} />
      </button>
      {open && (
        <div className={styles.meMenu} role="menu">
          <button className={styles.meHead} disabled={!onMe} onClick={() => { setOpen(false); onMe?.(); }} data-testid="me-edit">
            <span className={styles.meFace} style={{ background: me.color }}><Face who={me} /></span>
            <span className={styles.meWho}><span className={styles.meName} style={{ color: me.name_color || undefined }}>{me.display_name}</span><span className={styles.meRole}>{ROLE_WORD[me.role]}</span></span>
            {onMe && <span className={styles.mePencil}><Pencil size={15} /></span>}
          </button>
          {onInvite && <button role="menuitem" className={styles.meItem} onClick={() => { setOpen(false); onInvite(); }}><Plus size={16} />Invite people</button>}
          {/* Their own settings: their AI and how it works. Then the table's. */}
          {onSettings && <button role="menuitem" className={styles.meItem} onClick={() => { setOpen(false); onSettings(); }} data-testid="my-settings"><Gear size={16} />Settings</button>}
          {onTable && <button role="menuitem" className={styles.meItem} onClick={() => { setOpen(false); onTable(); }} data-testid="gear" aria-label={tableWord}><Gear size={16} />{tableWord}</button>}
          {onConnect && !ai && <button role="menuitem" className={styles.meItem} onClick={() => { setOpen(false); onConnect(); }}><Plug size={16} />Connect my {aiWord ?? "AI"}</button>}
          {onDisconnect && ai && <button role="menuitem" className={styles.meItem} onClick={() => { setOpen(false); onDisconnect(); }}><Plug size={16} />Disconnect my {AI_NAME[ai]}</button>}
          {onDownload && <button role="menuitem" className={styles.meItem} onClick={() => { setOpen(false); onDownload(); }}><Gear size={16} />Download what&apos;s mine</button>}
          {privacy && <a role="menuitem" className={styles.meItem} href="/privacy"><Gear size={16} />Privacy</a>}
          <div className={styles.meLook}>
            <span>Appearance</span>
            <div className={styles.lookSwitch} role="group" aria-label="Appearance">
              <button className={!dark ? styles.lookOn : ""} aria-pressed={!dark} onClick={() => look(false)}><Sun size={13} />Light</button>
              <button className={dark ? styles.lookOn : ""} aria-pressed={dark} onClick={() => look(true)} data-testid="look-dark"><Moon size={13} />Dark</button>
            </div>
          </div>
          {/* When someone needs them: a sound while Longtable is open, and a notice on the desktop while it is away. */}
          <div className={styles.meLook}>
            <span>Sound</span>
            <div className={styles.lookSwitch} role="group" aria-label="Sound when you are needed">
              <button className={sound ? styles.lookOn : ""} aria-pressed={sound} onClick={() => pickSound(true)} data-testid="sound-on">On</button>
              <button className={!sound ? styles.lookOn : ""} aria-pressed={!sound} onClick={() => pickSound(false)} data-testid="sound-off">Off</button>
            </div>
          </div>
          <div className={styles.meLook}>
            <span>Desktop notices</span>
            <div className={styles.lookSwitch} role="group" aria-label="Desktop notices when you are needed">
              <button className={notices ? styles.lookOn : ""} aria-pressed={notices} onClick={() => pickNotices(true)} data-testid="notices-on">On</button>
              <button className={!notices ? styles.lookOn : ""} aria-pressed={!notices} onClick={() => pickNotices(false)}>Off</button>
            </div>
          </div>
          {noticeNote && <div className={styles.setupHint} style={{ padding: "0 10px 8px", margin: 0 }} role="status">{noticeNote}</div>}
          <button role="menuitem" className={`${styles.meItem} ${styles.meOut}`} onClick={signOut}><SignOut size={16} />Sign out</button>
        </div>
      )}
    </div>
  );
}
