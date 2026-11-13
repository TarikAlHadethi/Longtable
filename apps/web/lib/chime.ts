"use client";

import { useEffect, useRef } from "react";

// A soft sound when someone is needed, and a desktop notice when Longtable is in the background. Both are this
// person's choice on this device: the sound is on unless they turned it off, the notice only once they turned it on
// and the browser allowed it. Nothing here leaves the browser.

const SOUND = "lt-sound";
const NOTICES = "lt-notices";
const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch (e) { console.warn("[chime] could not keep the choice:", (e as Error).name); } };

export const soundOn = () => read(SOUND) !== "off";
export const setSoundOn = (on: boolean) => { write(SOUND, on ? "on" : "off"); if (on) chime(true); };
export const noticesOn = () => read(NOTICES) === "on" && typeof Notification !== "undefined" && Notification.permission === "granted";
export async function setNoticesOn(on: boolean): Promise<boolean> {
  if (!on) { write(NOTICES, "off"); return false; }
  if (typeof Notification === "undefined") return false;
  const allowed = Notification.permission === "granted" || (await Notification.requestPermission()) === "granted";
  write(NOTICES, allowed ? "on" : "off");
  return allowed;
}

let audio: AudioContext | null = null;
let last = 0;
// Browsers only let a page make sound after the person has pressed something on it, so the sound is made ready on
// their first press.
if (typeof window !== "undefined") {
  const wake = () => {
    try { audio ??= new AudioContext(); audio.resume().catch(() => {}); } catch (e) { console.warn("[chime] no sound on this browser:", (e as Error).name); }
  };
  window.addEventListener("pointerdown", wake, { once: true, capture: true });
  window.addEventListener("keydown", wake, { once: true, capture: true });
}

// Two quiet notes, rising, like a small bell. At most one every three seconds, however much arrives at once.
export function chime(force = false) {
  if (!force && !soundOn()) return;
  const now = Date.now();
  if (!force && now - last < 3000) return;
  last = now;
  // Counted where tests can see it, since a headless browser plays nothing anyone hears.
  (window as { __ltChimes?: number }).__ltChimes = ((window as { __ltChimes?: number }).__ltChimes ?? 0) + 1;
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") audio.resume().catch(() => {});
    const t = audio.currentTime + 0.02;
    for (const [i, freq] of [659.25, 987.77].entries()) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const at = t + i * 0.13;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.16, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.9);
      osc.connect(gain).connect(audio.destination);
      osc.start(at);
      osc.stop(at + 0.95);
    }
  } catch (e) {
    console.warn("[chime] could not play:", (e as Error).name);
  }
}

// A desktop notice now, if they turned notices on and Longtable is in the background.
export const noticeNow = (title: string, body: string) => notice(title, body);

function notice(title: string, body: string) {
  if (!noticesOn() || !document.hidden) return;
  try {
    const n = new Notification(title, { body, tag: "longtable", icon: "/icon.svg" });
    n.onclick = () => { window.focus(); n.close(); };
  } catch (e) {
    console.warn("[chime] could not show a notice:", (e as Error).name);
  }
}

export type Need = { key: string; title: string; body: string };

// Chimes when something new needs this person. What was already there when the page opened is not new.
export function useNeeds(needs: Need[], ready = true) {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!ready) return;
    if (!seen.current) { seen.current = new Set(needs.map((n) => n.key)); return; }
    const fresh = needs.filter((n) => !seen.current!.has(n.key));
    for (const n of fresh) seen.current.add(n.key);
    if (!fresh.length) return;
    chime();
    notice(fresh[0].title, fresh.length > 1 ? `${fresh[0].body} (and ${fresh.length - 1} more)` : fresh[0].body);
  }, [needs, ready]);
}

// A person's message names this person: their first name as a word, or @ and it.
export function namesMe(body: string, first: string) {
  const name = first.trim();
  if (name.length < 2) return false;
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])@?${safe}(?![\\p{L}\\p{N}])`, "iu").test(body);
}

// A ping: @ and their first name. Unlike being named in passing, a ping sounds even in the chat they are looking at.
export function pingsMe(body: string, first: string) {
  const name = first.trim();
  if (name.length < 2) return false;
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])@${safe}(?![\\p{L}\\p{N}])`, "iu").test(body);
}
