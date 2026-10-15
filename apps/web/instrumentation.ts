// Error reports from the server and the edge: started only on the real site's production deploy with a Sentry address
// set (lib/report.mjs), so development, previews and tests send nothing. Every report is scrubbed before it leaves.
import * as Sentry from "@sentry/nextjs";
import { reportOptions, serverReporting } from "./lib/report.mjs";

const on = serverReporting();

export function register() {
  if (!on) return;
  Sentry.init(reportOptions({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.VERCEL_ENV,
    release: process.env.VERCEL_GIT_COMMIT_SHA,
  }));
}

// Errors thrown while a page or route is being made on the server.
export const onRequestError: typeof Sentry.captureRequestError = (...args) => {
  if (on) Sentry.captureRequestError(...args);
};
