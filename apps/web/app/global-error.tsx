"use client";

// What a person sees when a page breaks so badly that even the app's frame cannot draw. The error goes to the
// scrubbed report (it is dropped there unless this is the real site), and the page offers a way back in.
import { useEffect } from "react";
import { browserReporting } from "@/lib/report.mjs";
import "./globals.css";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // Sentry is fetched only on the real site, where instrumentation-client.ts has started it; anywhere else it would
  // drop the report anyway, so it is never loaded.
  useEffect(() => {
    const env = { NEXT_PUBLIC_VERCEL_ENV: process.env.NEXT_PUBLIC_VERCEL_ENV, NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN };
    if (!browserReporting(env, window.location.hostname)) return;
    import("@sentry/nextjs").then((Sentry) => Sentry.captureException(error)).catch(() => console.warn("Error reporting did not load."));
  }, [error]);
  return (
    <html lang="en">
      <body>
        <main className="page-center" style={{ minHeight: "100vh" }}>
          <div className="panel">
            <h1>Something went wrong</h1>
            <p className="note" style={{ margin: 0 }}>This page broke. Nothing you wrote is lost: it is all kept at your table.</p>
            <button className="btn" onClick={reset}>Try again</button>
          </div>
        </main>
      </body>
    </html>
  );
}
