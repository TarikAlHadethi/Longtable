"use client";

import { useEffect } from "react";

// A window that is open closes on Escape.
export function useEscape(onClose: () => void) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
}
