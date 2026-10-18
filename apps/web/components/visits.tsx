"use client";

import { useEffect, useState } from "react";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { routeShape } from "@/lib/report.mjs";

// Visitor counts and page speed on Vercel: cookieless, the real site in production only, and every address sent as
// its shape (/t/:id, never a table's or a chat's own address, no query).
const shape = (url: string) => `https://longtable.chat${routeShape(url) ?? "/"}`;

export function Visits() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    setOn(process.env.NEXT_PUBLIC_VERCEL_ENV === "production" && window.location.host === "longtable.chat");
  }, []);
  if (!on) return null;
  return (
    <>
      <Analytics beforeSend={(event) => ({ ...event, url: shape(event.url) })} />
      <SpeedInsights beforeSend={(event) => ({ ...event, url: shape(event.url), route: event.route ? routeShape(event.route) : event.route })} />
    </>
  );
}
