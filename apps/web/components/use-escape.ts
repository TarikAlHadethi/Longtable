"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// A window that is open closes on Escape.
export function useEscape(onClose: () => void) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
}

// A window fades out as it closes, as it faded in: `shut` marks it closing, and `close` lets the fade play first.
export function useClosing(onClose: () => void, ms = 170): [boolean, () => void] {
  const [shut, setShut] = useState(false);
  const done = useRef(false);
  const close = useCallback(() => {
    if (done.current) return;
    done.current = true;
    setShut(true);
    window.setTimeout(onClose, ms);
  }, [onClose, ms]);
  return [shut, close];
}
