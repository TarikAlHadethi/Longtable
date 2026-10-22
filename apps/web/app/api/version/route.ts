// Which build is live now. An open page compares it with the build it came from and offers to refresh.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ build: process.env.VERCEL_GIT_COMMIT_SHA || "dev" }, { headers: { "cache-control": "no-store" } });
}
