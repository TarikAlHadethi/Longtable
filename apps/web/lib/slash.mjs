// What every "/" command Claude Code has does at a table. The ones that run are Longtable's own versions, done by
// the person's own Claude (the connection holds their words). The rest steer Claude Code's own window there, so here
// they open the Longtable screen that does the same, change a setting of the person's AI, or say in one line what
// they mean at a table. A command Claude Code adds later still shows: the connection sends every name it has.

const FRESH = "Nothing to clear or compact here: every answer at the table starts fresh, with the conversation and what your Claude knows.";
const NO_SHELL = "This one needs a shell, the web or several agents running on their own, which the AIs at the table do not have. Ask in plain words and your Claude does what it can by reading and changing the code.";
const ON_YOUR_COMPUTER = "This changes Claude Code on your own computer, not the table: run it there.";

export const SLASH = {
  model: { act: "open", where: "ai", about: "Pick the model your Claude uses at this table" },
  config: { act: "open", where: "ai", about: "Your AI's settings at this table" },
  "output-style": { act: "open", where: "ai", about: "Your AI's settings at this table" },
  permissions: { act: "open", where: "ai", about: "What your AI may open and share at this table" },
  status: { act: "open", where: "ai", about: "Your AI: model, plan, when it was last on" },
  doctor: { act: "open", where: "ai", about: "Whether your connection is on and working" },
  usage: { act: "open", where: "usage", about: "How much of each AI's plan is used, and when it resets" },
  cost: { act: "open", where: "usage", about: "How much of each AI's plan is used" },
  "usage-credits": { act: "open", where: "usage", about: "How much of each AI's plan is used" },
  "extra-usage": { act: "open", where: "usage", about: "How much of each AI's plan is used" },
  insights: { act: "open", where: "usage", about: "Each AI's answers and tokens at this table" },
  clear: { act: "open", where: "new-chat", about: "Start a new chat" },
  rename: { act: "open", where: "rename-chat", about: "Rename this chat" },
  color: { act: "open", where: "profile", about: "Your colour, picture and name" },
  effort: { act: "effort", about: "How hard your Claude thinks: /effort low, medium, high, xhigh or max" },
  fast: { act: "fast", about: "Fast mode for your Claude: /fast on or /fast off" },
  compact: { act: "say", words: FRESH, about: "Not needed here: every answer starts fresh" },
  autocompact: { act: "say", words: FRESH, about: "Not needed here: every answer starts fresh" },
  context: { act: "say", words: FRESH, about: "Not needed here: every answer starts fresh" },
  mcp: { act: "say", words: "Your Claude at the table runs with no MCP servers, so nothing on your computer is reached that you did not point at in a message.", about: "Not used at the table" },
  agents: { act: "say", words: "Subagents are not used at the table: each person's own Claude does its part, and the others give views and review.", about: "Not used at the table" },
  "list-agents": { act: "say", words: "Subagents are not used at the table: each person's own Claude does its part, and the others give views and review.", about: "Not used at the table" },
  loop: { act: "say", words: "Nothing runs on a timer at the table yet. Ask in plain words and your Claude does it now.", about: "Not at the table yet" },
  schedule: { act: "say", words: "Nothing runs on a timer at the table yet. Ask in plain words and your Claude does it now.", about: "Not at the table yet" },
  batch: { act: "say", words: NO_SHELL, about: "Needs a shell" },
  run: { act: "say", words: NO_SHELL, about: "Needs a shell" },
  "deep-research": { act: "say", words: NO_SHELL, about: "Needs the web" },
  ultrareview: { act: "say", words: "The multi-agent cloud review runs from Claude Code on your own computer and is billed there. Here, /security-review or /code-review reads the code at the table.", about: "Runs from Claude Code itself" },
  "workflow-authoring": { act: "say", words: NO_SHELL, about: "Needs several agents" },
  "workflow-launch-exec": { act: "say", words: NO_SHELL, about: "Needs several agents" },
  "update-config": { act: "say", words: ON_YOUR_COMPUTER, about: "On your own computer" },
  "fewer-permission-prompts": { act: "say", words: ON_YOUR_COMPUTER, about: "On your own computer" },
  "auto-mode-setup": { act: "say", words: ON_YOUR_COMPUTER, about: "On your own computer" },
  "reload-plugins": { act: "say", words: "Your plugins' commands reach the table by themselves within a minute of changing.", about: "Happens by itself here" },
  "reload-skills": { act: "say", words: "Your skills reach the table by themselves within a minute of changing.", about: "Happens by itself here" },
  "plugin-authoring": { act: "say", words: ON_YOUR_COMPUTER, about: "On your own computer" },
  "run-skill-generator": { act: "say", words: ON_YOUR_COMPUTER, about: "On your own computer" },
  "skill-doctor": { act: "say", words: ON_YOUR_COMPUTER, about: "On your own computer" },
  heapdump: { act: "say", words: ON_YOUR_COMPUTER, about: "On your own computer" },
  focus: { act: "say", words: ON_YOUR_COMPUTER, about: "On your own computer" },
  import: { act: "say", words: ON_YOUR_COMPUTER, about: "On your own computer" },
  advisor: { act: "say", words: ON_YOUR_COMPUTER, about: "On your own computer" },
  "design-sync": { act: "say", words: "Design systems live in Claude on the web. Here, /design makes a design as a page in the project's own look.", about: "In Claude on the web" },
  "design-consent": { act: "say", words: ON_YOUR_COMPUTER, about: "On your own computer" },
  "design-revoke": { act: "say", words: ON_YOUR_COMPUTER, about: "On your own computer" },
  // Codex's own (for a person whose AI here is ChatGPT).
  new: { act: "open", where: "new-chat", about: "Start a new chat" },
  approvals: { act: "say", words: "Your AI at the table asks nobody's approval and runs nothing: it reads, and when it does work, it changes files on a branch the team looks over.", about: "Not needed here" },
  diff: { act: "say", words: "What an AI changed is on its task's branch, named in the Work panel. Ask your AI what changed, or open the branch on GitHub.", about: "On the task's branch" },
  mention: { act: "say", words: "Paste the path in your message and your AI opens it on your computer.", about: "Paste the path instead" },
  undo: { act: "say", words: "A change at the table is on its own branch and never reaches the main one by itself: leave the branch out, or ask your AI to undo it.", about: "Changes stay on their branch" },
  logout: { act: "say", words: "Disconnect your AI from its window here.", about: "Disconnect in your AI's window" },
  quit: { act: "say", words: "Nothing to quit here.", about: "Nothing to quit here" },
  exit: { act: "say", words: "Nothing to quit here.", about: "Nothing to quit here" },
};

// What Codex itself has, for a person whose AI here is ChatGPT: the names its own "/" list shows.
export const CODEX_NAMES = ["model", "status", "effort", "usage", "new", "rename", "color", "compact", "mcp", "approvals", "diff", "mention", "undo", "logout", "quit", "exit"];

// What a command does here. Anything the person's connection holds words for runs; a name nobody here knows says so.
export function slashEntry(name, runnable) {
  if (runnable) return { act: "run", about: "" };
  return SLASH[name.toLowerCase()] ?? { act: "say", words: "Claude Code has this one, but it does nothing at the table yet.", about: "Not at the table yet" };
}

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

// Why fast mode cannot serve, in plain words, from the reason Claude Code gives.
export function fastWhy(why) {
  switch (why) {
    case "preference": return "Your account does not allow fast mode right now (it needs usage credits, or your organization turned it off).";
    case "free": return "Fast mode needs a paid plan.";
    case "extra_usage_disabled": return "Fast mode needs extra usage switched on for your account.";
    case "model_not_allowed": return "Fast mode does not work with the model picked for your Claude.";
    case "network_error": return "Fast mode could not be checked just now.";
    case "pending": return "Your account is still being checked for fast mode.";
    default: return why ? "Fast mode is not available right now." : "";
  }
}
