"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AI_NAME, AiLogo } from "@/components/ai-logo";
import { useClosing, useEscape } from "@/components/use-escape";
import { chime, noticeNow } from "@/lib/chime";
import { browserClient } from "@/lib/supabase/browser";
import type { Connection } from "./types";
import styles from "./room.module.css";

// Coming back to Longtable with your own AI off: a window that says so, with Reconnect. Reconnect opens the
// longtable:// link the connection wrote on this computer, which starts it when it is not running (the browser asks
// first); a line runs across the window while it comes back, and confetti and the sound say it is back. A computer
// whose connection never wrote the link (an older version) is waited for, since it starts by itself within minutes of
// the computer waking. Close leaves it be.
const BACK_MS = 45000;
const WAIT_MS = 60000;
type Stage = "off" | "waking" | "back" | "slow";

export const isQuiet = (c: Pick<Connection, "last_seen">) => !c.last_seen || Date.now() - new Date(c.last_seen).getTime() > 90000;

export function ReconnectWindow({ conn, onConnectAgain, onClose }: { conn: Connection; onConnectAgain: () => void; onClose: () => void }) {
  const [shut, close] = useClosing(onClose);
  useEscape(close);
  const [stage, setStage] = useState<Stage>("off");
  const [wake, setWake] = useState(!!conn.limits?.wake);
  const since = useRef(0);
  const name = AI_NAME[conn.kind] === "Claude" ? "Claude Code" : AI_NAME[conn.kind];

  // Read the connection every two seconds while the window is open: back as soon as it is heard from again, whether
  // Reconnect brought it or the computer did.
  useEffect(() => {
    if (stage === "back") return;
    const supabase = browserClient();
    let stop = false;
    const look = async () => {
      const { data, error } = await supabase.from("connections").select("last_seen, limits, revoked_at").eq("id", conn.id).maybeSingle();
      if (stop) return;
      if (error) return console.warn("[reconnect] could not read the connection:", error.code);
      const row = data as Pick<Connection, "last_seen" | "limits" | "revoked_at"> | null;
      if (!row || row.revoked_at) return;
      setWake(!!row.limits?.wake);
      if (row.last_seen && Date.now() - new Date(row.last_seen).getTime() < BACK_MS && new Date(row.last_seen).getTime() > since.current) {
        setStage("back");
        chime(true);
        noticeNow(`${name} is back`, "Your AI is connected again.");
      } else if (stage === "waking" && Date.now() - since.current > WAIT_MS) {
        setStage("slow");
      }
    };
    look();
    const t = setInterval(look, 2000);
    return () => { stop = true; clearInterval(t); };
  }, [conn.id, stage, name]);

  // Back: a moment to see it, then the window goes by itself.
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (stage !== "back") return;
    const t = setTimeout(() => closeRef.current(), 3200);
    return () => clearTimeout(t);
  }, [stage]);

  function reconnect() {
    since.current = Date.now() - 20000;
    setStage("waking");
    if (!wake) return;
    // Through a link the page itself presses, so the browser treats it as the person's own.
    const a = document.createElement("a");
    a.href = "longtable://reconnect";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  const title = stage === "back" ? `${name} reconnected` : stage === "off" ? `${name} disconnected` : stage === "slow" ? "It has not come back yet" : "Reconnecting";
  const line = stage === "back" ? "Your AI is at the table again."
    : stage === "off" ? "Your AI at this table is not running on your computer right now."
    : stage === "slow" ? "Your computer may be asleep, or the connection may need setting up again."
    : wake ? "Starting the connection on your computer. If your browser asks to open Longtable, say yes."
    : "Waiting for your computer. The connection starts by itself within a few minutes of it waking.";

  return (
    <div className={`${styles.modalBack} ${shut ? styles.closing : ""}`} onClick={close}>
      <div className={`${styles.modal} ${styles.reconnect}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title} data-testid="reconnect" data-stage={stage}>
        {stage === "back" && <Confetti />}
        <div className={styles.reconnectHead}>
          <AiLogo kind={conn.kind} size={30} />
          <div className={styles.modalTitle}>{title}</div>
        </div>
        <div className={styles.reconnectLine} data-on={stage === "waking" || undefined} data-done={stage === "back" || undefined} aria-hidden="true"><i /></div>
        <div className="note" role="status">{line}</div>
        <div className={styles.modalActions}>
          {stage === "back" ? (
            <button className="btn" onClick={close}>Done</button>
          ) : (
            <>
              <button type="button" className="btn btn-quiet" onClick={close} data-testid="reconnect-close">Close</button>
              {stage === "slow" && <button type="button" className="btn btn-quiet" onClick={() => { close(); onConnectAgain(); }}>Connect again</button>}
              {stage !== "waking" && <button className="btn" onClick={reconnect} data-testid="reconnect-go">{stage === "slow" ? "Try again" : "Reconnect"}</button>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// A short burst of the table's colours from the middle of the window, gone in under two seconds.
function Confetti() {
  const bits = useMemo(() => Array.from({ length: 42 }, (_, i) => {
    const angle = (Math.PI * 2 * i) / 42 + Math.random() * 0.4;
    const reach = 120 + Math.random() * 160;
    return {
      x: Math.cos(angle) * reach,
      y: Math.sin(angle) * reach * 0.7 - 60,
      r: Math.round(Math.random() * 540 - 270),
      d: Math.round(Math.random() * 180),
      c: ["oklch(0.62 0.09 30)", "oklch(0.62 0.09 250)", "oklch(0.62 0.09 310)", "oklch(0.58 0.08 170)", "oklch(0.78 0.12 85)"][i % 5],
    };
  }), []);
  return (
    <div className={styles.confetti} aria-hidden="true">
      {bits.map((b, i) => (
        <i key={i} style={{ "--x": `${b.x}px`, "--y": `${b.y}px`, "--r": `${b.r}deg`, animationDelay: `${b.d}ms`, background: b.c } as React.CSSProperties} />
      ))}
    </div>
  );
}
