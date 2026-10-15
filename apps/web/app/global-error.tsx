"use client";

// What a person sees when a page breaks so badly that even the app's frame cannot draw. The error goes to the
// scrubbed report (it is dropped there unless this is the real site), and the page offers a way back in.
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import "./globals.css";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { Sentry.captureException(error); }, [error]);
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
