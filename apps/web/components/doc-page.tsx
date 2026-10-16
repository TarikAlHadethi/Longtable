import Link from "next/link";
import type { ReactNode } from "react";
import { Mark } from "@/components/mark";

// The plain pages (privacy, terms, security): one column, the mark home, a title, and sections in plain words.
export function DocPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <main style={{ maxWidth: 680, margin: "0 auto", padding: "32px 20px 56px", display: "flex", flexDirection: "column", gap: 14, lineHeight: 1.6 }}>
      <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 600, color: "var(--ink)", textDecoration: "none" }}>
        <Mark size={24} /> Longtable
      </Link>
      <h1 style={{ margin: "8px 0 0", fontSize: 30 }}>{title}</h1>
      <p style={{ margin: 0, fontSize: 14, color: "var(--muted)" }}>Last updated {updated}</p>
      {children}
      <nav style={{ display: "flex", gap: 18, marginTop: 20, fontSize: 14 }}>
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
        <Link href="/security">Security</Link>
      </nav>
    </main>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h2 style={{ fontSize: 18, margin: "8px 0 0" }}>{title}</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>
    </>
  );
}
