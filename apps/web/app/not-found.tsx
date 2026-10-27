import Link from "next/link";
import { AuthShell } from "@/components/auth-shell";

// A page that is not there, in the product's own frame rather than a bare 404. A table someone is not at has its own
// page (components/not-at-table.tsx), since that person needs a way in, not a dead end.
export default function NotFound() {
  return (
    <AuthShell title="Nothing here" lead="This page doesn't exist. It may have moved, or the link was mistyped.">
      <Link className="btn" href="/start">Your tables</Link>
    </AuthShell>
  );
}
