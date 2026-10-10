"use client";

import { Gauge, Gear, Moon, Plus, SignOut, Sun } from "@/components/icons";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { browserClient } from "@/lib/supabase/browser";
import type { Member } from "./types";
import styles from "./room.module.css";

const ROLE_WORD = { owner: "Owner", developer: "Developer", client: "Client" } as const;

// The person's own menu, behind their picture: invite, settings, the light or dark look, and signing out.
export function ProfileMenu({ me, tableId, onInvite }: { me: Member; tableId: string; onInvite?: () => void }) {
  const [open, setOpen] = useState(false);
  const [dark, setDark] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const letter = me.display_name.trim().charAt(0).toUpperCase() || "?";

  useEffect(() => { setDark(document.documentElement.dataset.theme === "dark"); }, []);
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

  async function signOut() {
    await browserClient().auth.signOut();
    window.location.href = "/";
  }

  return (
    <div className={styles.me} ref={ref}>
      <button className={styles.meButton} style={{ background: me.color }} aria-label="Your menu" aria-haspopup="menu" aria-expanded={open}
        data-testid="me-menu" onClick={() => setOpen(!open)}>
        {letter}
      </button>
      {open && (
        <div className={styles.meMenu} role="menu">
          <div className={styles.meHead}>
            <span className={styles.meFace} style={{ background: me.color }}>{letter}</span>
            <div><div className={styles.meName}>{me.display_name}</div><div className={styles.meRole}>{ROLE_WORD[me.role]}</div></div>
          </div>
          {onInvite && <button role="menuitem" className={styles.meItem} onClick={() => { setOpen(false); onInvite(); }}><Plus size={16} />Invite people</button>}
          {me.role === "owner" && <Link role="menuitem" className={styles.meItem} href={`/t/${tableId}/settings`}><Gear size={16} />Table settings</Link>}
          {me.role !== "client" && <Link role="menuitem" className={styles.meItem} href={`/t/${tableId}/usage`}><Gauge size={16} />Usage</Link>}
          <div className={styles.meLook}>
            <span>Appearance</span>
            <div className={styles.lookSwitch} role="group" aria-label="Appearance">
              <button className={!dark ? styles.lookOn : ""} aria-pressed={!dark} onClick={() => look(false)}><Sun size={13} />Light</button>
              <button className={dark ? styles.lookOn : ""} aria-pressed={dark} onClick={() => look(true)} data-testid="look-dark"><Moon size={13} />Dark</button>
            </div>
          </div>
          <button role="menuitem" className={`${styles.meItem} ${styles.meOut}`} onClick={signOut}><SignOut size={16} />Sign out</button>
        </div>
      )}
    </div>
  );
}
