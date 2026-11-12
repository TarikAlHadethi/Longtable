import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://longtable.chat";
  return ["", "/privacy", "/terms", "/security"].map((p) => ({ url: base + p, changeFrequency: p ? "monthly" : "weekly", priority: p ? 0.3 : 1 }));
}
