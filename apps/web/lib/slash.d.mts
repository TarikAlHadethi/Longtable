// Types for slash.mjs, which stays plain JavaScript so its check runs with no build.
export type SlashAct =
  | { act: "run" }
  | { act: "open"; where: "ai" | "usage" | "new-chat" | "rename-chat" | "profile" }
  | { act: "effort" }
  | { act: "fast" }
  | { act: "say"; words: string };
export type SlashEntry = SlashAct & { about: string };
export const SLASH: Record<string, SlashEntry>;
export function slashEntry(name: string, runnable: boolean): SlashEntry;
export const EFFORT_LEVELS: readonly ["low", "medium", "high", "xhigh", "max"];
export function fastWhy(why?: string | null): string;
