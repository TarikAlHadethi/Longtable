import type { MetadataRoute } from "next";

// Only the public pages are for search engines; tables, sign-in and the API are private to the people in them.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/t/", "/start", "/join", "/sign-in", "/admin", "/api/"] },
    sitemap: "https://longtable.chat/sitemap.xml",
  };
}
