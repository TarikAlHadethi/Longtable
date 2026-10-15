// Types for report.mjs, which stays plain JavaScript so its check runs with no build.
import type { Breadcrumb, ErrorEvent, EventHint } from "@sentry/nextjs";

export function scrubText(text: unknown): string;
export function routeShape(address: unknown): string | undefined;
export function scrubEvent(event: ErrorEvent, hint?: EventHint): ErrorEvent | null;
export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb | null;
export function scrubSpan<T>(span: T): T;
export function reportOptions(o: { dsn?: string; environment?: string; release?: string }): {
  dsn?: string;
  environment?: string;
  release?: string;
  sendDefaultPii: false;
  includeLocalVariables: false;
  attachStacktrace: true;
  maxBreadcrumbs: number;
  tracesSampleRate: number;
  beforeSend: (event: ErrorEvent, hint: EventHint) => ErrorEvent | null;
  beforeBreadcrumb: (crumb: Breadcrumb) => Breadcrumb | null;
  beforeSendSpan: <T>(span: T) => T;
};
export function serverReporting(env?: Record<string, string | undefined>): boolean;
export function browserReporting(env: Record<string, string | undefined>, host: string): boolean;
