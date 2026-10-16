"use client";

import { useEffect, useRef, useState } from "react";
import { Dots, Pencil, Plus, Trash } from "@/components/icons";
import type { Chat } from "./types";
import styles from "./room.module.css";

// The chats in the sidebar. A chat opens with a click. Its name is changed by double-clicking it while it is open,
// or from the menu behind the dots that show when the pointer is over it; the same menu deletes it.
// A new chat that is left without a name is gone the moment the pointer goes elsewhere.
export function ChatList({ chats, activeId, waiting, canDelete, onOpen, onCreate, onRename, onDelete }: {
  chats: Chat[];
  activeId: string | null;
  waiting: Set<string>;
  canDelete: (c: Chat) => boolean;
  onOpen: (id: string) => void;
  onCreate: (name: string) => Promise<string | null>;
  onRename: (id: string, name: string) => Promise<string | null>;
  onDelete: (id: string) => Promise<string | null>;
}) {
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [sure, setSure] = useState(false);
  const [error, setError] = useState("");
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest("[data-chat-menu]")) setMenu(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [menu]);
  useEffect(() => { if (!menu) setSure(false); }, [menu]);

  const startRename = (c: Chat) => { setMenu(null); setError(""); setDraft(c.name); setEditing(c.id); };
  async function finishRename(c: Chat) {
    const name = draft.trim();
    setEditing(null);
    if (!name || name === c.name) return;
    const problem = await onRename(c.id, name);
    if (problem) setError(problem);
  }
  async function create(e: React.FormEvent) {
    e.preventDefault();
    const name = draft.trim();
    if (!name) return;
    setNaming(false);
    setDraft("");
    const problem = await onCreate(name);
    if (problem) setError(problem);
  }
  async function remove(c: Chat) {
    setMenu(null);
    const problem = await onDelete(c.id);
    if (problem) setError(problem);
  }

  return (
    <div className={styles.section} ref={list}>
      <div className={styles.sectionHead}>
        <div className={styles.sectionTitle}>Chats</div>
        <button className={styles.plus} title="New chat" aria-label="New chat"
          onMouseDown={(e) => e.preventDefault()} onClick={() => { setError(""); setDraft(""); setEditing(null); setNaming(!naming); }}>
          <Plus size={14} />
        </button>
      </div>
      {[...chats].sort((a, b) => Number(b.is_general) - Number(a.is_general) || a.created_at.localeCompare(b.created_at)).map((c) => (
        <div key={c.id} className={`${styles.chatRow} ${c.id === activeId ? styles.chatRowOn : ""} ${menu === c.id ? styles.chatRowMenu : ""}`} data-chat={c.name}>
          {editing === c.id ? (
            <input className={`field ${styles.chatEdit}`} autoFocus maxLength={60} value={draft} aria-label="The chat's name"
              onChange={(e) => setDraft(e.target.value)} onFocus={(e) => e.target.select()} onBlur={() => finishRename(c)}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditing(null); }} />
          ) : (
            <>
              <button className={`${styles.chat} ${c.id === activeId ? styles.chatActive : ""}`} onClick={() => onOpen(c.id)}
                onDoubleClick={() => { if (c.id === activeId) startRename(c); }} title={c.id === activeId ? "Double-click to rename" : undefined}>
                <span className={styles.chatName}><span className={styles.chatHash} aria-hidden="true">#</span>{c.name}</span>
              </button>
              <button className={styles.chatMore} aria-label={`More for ${c.name}`} aria-haspopup="menu" aria-expanded={menu === c.id} data-chat-menu
                onClick={() => setMenu(menu === c.id ? null : c.id)}>
                <Dots size={16} />
              </button>
              {menu === c.id && (
                <div className={styles.chatMenu} role="menu" data-chat-menu>
                  <button role="menuitem" className={styles.meItem} onClick={() => startRename(c)}><Pencil size={15} />Rename</button>
                  {canDelete(c) && (sure
                    ? <button role="menuitem" className={`${styles.meItem} ${styles.danger}`} onClick={() => remove(c)}><Trash size={15} />Delete it and everything in it</button>
                    : <button role="menuitem" className={`${styles.meItem} ${styles.danger}`} onClick={() => setSure(true)}><Trash size={15} />Delete</button>)}
                </div>
              )}
            </>
          )}
        </div>
      ))}
      {naming && (
        <form onSubmit={create} className={styles.newChat}>
          <input className="field" autoFocus maxLength={60} value={draft} onChange={(e) => setDraft(e.target.value)}
            placeholder="Name the chat" aria-label="Name the new chat"
            onBlur={() => { setNaming(false); setDraft(""); }} onKeyDown={(e) => { if (e.key === "Escape") { setNaming(false); setDraft(""); } }} />
        </form>
      )}
      {error && <div className="error" style={{ padding: "4px 8px", fontSize: 13 }}>{error}</div>}
    </div>
  );
}
