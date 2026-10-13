import Link from "next/link";
import { AuthShell } from "@/components/auth-shell";
import s from "@/components/auth.module.css";
import { serverClient } from "@/lib/supabase/server";
import { JoinForm } from "./join-form";

type Preview = { table_name: string; role: "owner" | "developer" | "client"; expired: boolean; used: boolean; name: string };

// An invite link lands here: who invited you to what, then your name and Join.
export default async function Join({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const supabase = await serverClient();
  const { data } = await supabase.rpc("invite_preview", { token });
  const preview = (data as Preview[] | null)?.[0];
  const { data: { user } } = await supabase.auth.getUser();

  let body: React.ReactNode;
  if (!preview) {
    body = <p className="note" style={{ margin: 0 }}>This invite link isn't valid. Ask for a new one.</p>;
  } else if (preview.expired) {
    body = <p className="note" style={{ margin: 0 }}>This invite link has expired. Ask for a new one.</p>;
  } else if (preview.used && !user) {
    // Said before anyone signs in for nothing. Someone signed in is let through: the person who used the link may
    // open it again, and joining says so to anyone else.
    body = <p className="note" style={{ margin: 0 }}>This invite link was already used. Ask for a new one.</p>;
  } else if (!user) {
    body = (
      <>
        <div className={s.invited}>You are invited to<b>{preview.table_name}</b>as {preview.role === "client" ? "the client" : "a developer"}.</div>
        <Link className="btn" href={`/sign-in?next=/join/${token}`}>Sign in to join</Link>
      </>
    );
  } else {
    body = (
      <>
        <div className={s.invited}>You are invited to<b>{preview.table_name}</b>as {preview.role === "client" ? "the client" : "a developer"}.</div>
        <JoinForm token={token} name={preview.name} />
      </>
    );
  }

  return (
    <AuthShell title="Join a table">
      {body}
    </AuthShell>
  );
}
