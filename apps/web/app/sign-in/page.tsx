import { Mark } from "@/components/mark";
import { safeNext } from "@/lib/safe-next";
import { SignInForm } from "./sign-in-form";

export default async function SignIn({ searchParams }: { searchParams: Promise<Record<string, string | string[]>> }) {
  const next = safeNext((await searchParams).next);
  return (
    <main className="page-center">
      <div className="panel">
        <Mark size={40} />
        <h1>Sign in to Longtable</h1>
        <SignInForm next={next} />
      </div>
    </main>
  );
}
