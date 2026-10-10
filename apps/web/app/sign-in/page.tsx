import { AuthShell } from "@/components/auth-shell";
import { safeNext } from "@/lib/safe-next";
import { SignInForm } from "./sign-in-form";

export default async function SignIn({ searchParams }: { searchParams: Promise<Record<string, string | string[]>> }) {
  const next = safeNext((await searchParams).next);
  return (
    <AuthShell title="Sign in to Longtable" lead="New here or coming back, it is the same step.">
      <SignInForm next={next} />
    </AuthShell>
  );
}
