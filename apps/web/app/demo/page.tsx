import { redirect } from "next/navigation";

// The demo lives on the opening page now; an old link to /demo lands there.
export default function DemoPage() {
  redirect("/#demo");
}
