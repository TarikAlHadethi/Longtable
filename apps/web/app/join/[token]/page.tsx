import Link from "next/link";
import { Mark } from "@/components/mark";
import { serverClient } from "@/lib/supabase/server";
import { JoinForm } from "./join-form";

type Preview = { table_name: string; role: "owner" | "developer" | "client"; expired: boolean; used: boolean };

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
  } else if (!user) {
    body = (
      <>
        <p className="note" style={{ margin: 0 }}>
          You're invited to <strong>{preview.table_name}</strong> as {preview.role === "client" ? "the client" : "a developer"}.
        </p>
        <Link className="btn" href={`/sign-in?next=/join/${token}`}>Sign in to join</Link>
      </>
    );
  } else {
    body = (
      <>
        <p className="note" style={{ margin: 0 }}>
          You're invited to <strong>{preview.table_name}</strong> as {preview.role === "client" ? "the client" : "a developer"}.
        </p>
        <JoinForm token={token} />
      </>
    );
  }

  return (
    <main className="page-center">
      <div className="panel">
        <Mark size={40} />
        <h1>Join a table</h1>
        {body}
      </div>
    </main>
  );
}
