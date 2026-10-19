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
};

export default config;
