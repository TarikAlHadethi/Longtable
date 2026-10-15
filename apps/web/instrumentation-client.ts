// Error reports from the browser: started only on longtable.chat itself, on Vercel's production deploy, with a Sentry
// address set (lib/report.mjs). Never session replay, never a feedback widget. Every report is scrubbed before it leaves.
import * as Sentry from "@sentry/nextjs";
import { browserReporting, reportOptions } from "./lib/report.mjs";

// Next only puts NEXT_PUBLIC_ values into the browser when each is named in full.
const env = {
  NEXT_PUBLIC_VERCEL_ENV: process.env.NEXT_PUBLIC_VERCEL_ENV,
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
};
const on = typeof window !== "undefined" && browserReporting(env, window.location.hostname);

if (on) {
  Sentry.init(reportOptions({
    dsn: env.NEXT_PUBLIC_SENTRY_DSN,
    environment: env.NEXT_PUBLIC_VERCEL_ENV,
    release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,
  }));
}

// How long moving between pages takes, sampled with the rest of the timing.
export const onRouterTransitionStart: typeof Sentry.captureRouterTransitionStart = (...args) => {
  if (on) Sentry.captureRouterTransitionStart(...args);
};
