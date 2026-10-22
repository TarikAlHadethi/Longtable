// Error reports from the browser: started only on longtable.chat itself, on Vercel's production deploy, with a Sentry
// address set (lib/report.mjs). Never session replay, never a feedback widget. Every report is scrubbed before it leaves.
// Sentry is fetched only when it will run: imported up front it put about 138 KB into every page, here and in tests,
// where it never starts.
import type * as SentryType from "@sentry/nextjs";
import { browserReporting, reportOptions } from "./lib/report.mjs";

// Next only puts NEXT_PUBLIC_ values into the browser when each is named in full.
const env = {
  NEXT_PUBLIC_VERCEL_ENV: process.env.NEXT_PUBLIC_VERCEL_ENV,
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
};
const on = typeof window !== "undefined" && browserReporting(env, window.location.hostname);

const sentry: Promise<typeof SentryType> | null = on
  ? import("@sentry/nextjs").then((Sentry) => {
    Sentry.init(reportOptions({
      dsn: env.NEXT_PUBLIC_SENTRY_DSN,
      environment: env.NEXT_PUBLIC_VERCEL_ENV,
      release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,
    }));
    return Sentry;
  })
  : null;

// How long moving between pages takes, sampled with the rest of the timing. A move made before Sentry has loaded is
// still timed once it arrives.
export const onRouterTransitionStart: typeof SentryType.captureRouterTransitionStart = (...args) => {
  sentry?.then((Sentry) => Sentry.captureRouterTransitionStart(...args)).catch(() => console.warn("Error reporting did not load."));
};
