import Link from "next/link";
import { AuthShell } from "@/components/auth-shell";

// A page that is not there, or a table this person is not at, in the product's own frame rather than a bare 404.
export default function NotFound() {
  return (
    <AuthShell title="Nothing here" lead="This page isn't here, or you are not at this table. If someone sent you a link to it, ask them for a new invite.">
      <Link className="btn" href="/start">Your tables</Link>
    </AuthShell>
  );
}
