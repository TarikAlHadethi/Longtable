import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth-shell";
import { safeNext } from "@/lib/safe-next";
import { serverClient } from "@/lib/supabase/server";
import { signedInOrNull } from "@/lib/signed-in.mjs";
import { SignInForm } from "./sign-in-form";

export default async function SignIn({ searchParams }: { searchParams: Promise<Record<string, string | string[]>> }) {
  const next = safeNext((await searchParams).next);
  // Already signed in: go on to where they were headed instead of asking for a code again.
  if (await signedInOrNull(await serverClient())) redirect(next);
  return (
    <AuthShell title="Sign in to Longtable">
      <SignInForm next={next} />
    </AuthShell>
  );
}
