// The one fence guard, shared by everything that builds a prompt. Text from the table, a file or another AI is fenced
// so it reads as information. Nothing inside may close a fence, and a marker glued to a letter ("xTABLE>>>") is still a
// marker to whoever reads it, so no word edge is asked for. A new fence name is added here, once.

const NAMES = "TABLE|CODE|YOURS|PART|SHARED|COMMAND|CLIENT|PAGES";
export const MARKER = new RegExp(`<<<(${NAMES})|(${NAMES})>>>`);
const ALL = new RegExp(MARKER.source, "g");
export const inert = (t) => String(t ?? "").replace(ALL, "[marker]");
