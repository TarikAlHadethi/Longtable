import Link from "next/link";
import { Mark } from "@/components/mark";

// The demo comes later: the invented Fernhill Dental team, recorded answers, nothing real behind it.
export default function Demo() {
  return (
    <main className="page-center">
      <div className="panel" style={{ alignItems: "center", textAlign: "center" }}>
        <Mark size={48} />
        <h1>The demo is on its way</h1>
        <p className="note" style={{ margin: 0 }}>
          It will show a made-up dental clinic's team and their client at work, with nothing real behind it.
        </p>
        <Link className="btn btn-quiet" href="/">Back</Link>
      </div>
    </main>
  );
}
