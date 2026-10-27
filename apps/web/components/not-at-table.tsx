import Link from "next/link";
import { AuthShell } from "@/components/auth-shell";

// A table link opened by someone signed in who is not at that table (or a table that is gone: the two look the same
// from outside, on purpose). Says what to do next instead of a bare "not found".
export function NotAtTable() {
  return (
    <AuthShell title="You're not at this table" lead="You're signed in, but this table hasn't let you in. Ask one of its owners for the table's code, or for an invite link.">
      <Link className="btn" href="/start?join=1" data-testid="join-with-code">Join with a code</Link>
      <Link className="btn btn-quiet" href="/start">Your tables</Link>
    </AuthShell>
  );
}
