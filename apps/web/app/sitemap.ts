import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://longtable.chat";
  return ["", "/ai-group-chat", "/privacy", "/terms", "/security"].map((p) => ({ url: base + p, changeFrequency: p ? "monthly" : "weekly", priority: p === "" ? 1 : p === "/ai-group-chat" ? 0.8 : 0.3 }));
}
