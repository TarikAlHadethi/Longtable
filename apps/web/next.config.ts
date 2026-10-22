import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // No generated AI instruction files in the repo.
  agentRules: false,
  // The dev badge sits over the sidebar's settings gear at the bottom left.
  devIndicators: false,
  turbopack: { root: path.resolve(process.cwd(), "../..") },
  // Which build a page came from, so an open page can tell when a newer one is live (components/update-notice.tsx).
  env: { NEXT_PUBLIC_BUILD: process.env.VERCEL_GIT_COMMIT_SHA || "dev" },
};

export default config;
