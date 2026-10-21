export type Role = "owner" | "developer" | "client";

export type Member = { id: string; display_name: string; role: Role; color: string; created_at?: string; avatar?: string | null; name_color?: string | null; status?: string; bubble?: string | null; test?: boolean; can_settings?: boolean; can_invite?: boolean; can_clients?: boolean; tasks_cleared_at?: string | null; client_mode?: "chat" | "sandbox"; sandbox_branch?: string | null; sandbox_url?: string | null };
export const MEMBER_COLUMNS = "id, display_name, role, color, created_at, avatar, name_color, status, bubble, tasks_cleared_at, test, can_settings, can_invite, can_clients";
// A client's own copy, as the team is told about it. It is kept apart from the people's rows, which clients can read.
export type SandboxRow = { member_id: string; mode: "chat" | "sandbox"; branch: string; url: string | null; opened_at?: string | null; checked_at?: string | null; open_ok?: boolean | null };
export const SANDBOX_COLUMNS = "member_id, mode, branch, url, opened_at, checked_at, open_ok";

export type Chat = { id: string; name: string; about: string; is_general: boolean; created_at: string; created_by?: string | null;
  // On this screen only: a chat just named, shown at once while the table makes it, and the key it keeps after.
  pending?: boolean; local_key?: string };

export type Message = {
  id: string;
  chat_id: string;
  member_id: string;
  body: string;
  created_at: string;
  by_ai?: boolean;
  kind?: "chat" | "answer" | "view" | "intro" | "client" | "github";
  meta?: {
    request?: string | null;
    files?: FileRef[];
    answers?: string;
    question?: string;
    read?: string;
    model?: string;
    hidden?: boolean;
    round?: string | null;
    sources?: string[];
    how?: string;
    parts?: string[];
    confidence?: string | null;
    part?: string | null;
    ok?: boolean | null;
    changed?: boolean | null;
    job?: string | null;
  };
  state?: "sending" | "failed";
};

export type Job = {
  id: string;
  chat_id: string | null;
  member_id: string;
  kind: "answer" | "view" | "combine" | "intro" | "client" | "work" | "review" | "listen" | "look" | "plan" | "sandbox";
  change_id?: string | null;
  subject?: string | null;
  stage?: number;
  progress?: string | null;
  task_id?: string | null;
  started_at?: string | null;
  round: string | null;
  status: "queued" | "running" | "done" | "failed" | "waiting" | "skipped";
  error: string | null;
  created_at: string;
};

export type Limits = { ai?: string | null; plan?: string | null; model?: string | null; status?: string | null; models?: string[]; fast?: string | null; fast_why?: string | null; version?: string | null; reads?: { repo: string | null; folder: string | null; known: boolean } | null; windows?: { name: string; used: number; resets: string | null }[] };
// A person's own command or skill on their computer: its name and a line on what it is for.
export type Command = { name: string; about: string; kind: "command" | "skill" | "prompt" | "builtin" };
export type Connection = { id: string; member_id: string; kind: "claude" | "codex"; last_seen: string | null; revoked_at: string | null; created_at: string; limits?: Limits | null; model_choice?: string | null;
  open_paths?: boolean; share_paths?: boolean; effort?: string | null; fast?: boolean; full_claude?: boolean; in_folder?: boolean; push_anywhere?: boolean; use_repo?: string | null; mode?: string | null };
// Something attached to a message.
export type FileRef = { id: string; name: string; mime: string; size: number; path: string; kind: "image" | "video" | "audio" | "file" };

export type Note = { id: string; member_id: string | null; kind: "intro" | "summary" | "shared"; title: string; body: string; updated_at: string };

// An option may ask the client a question instead of telling them an answer: client_words is then the question,
// and replies the answers they can tap.
export type Option = { position: number; label: string; recommended: boolean; client_words: string; asks_client: boolean; replies: string[] };

export type Decision = {
  id: string;
  chat_id: string;
  title: string;
  context: string;
  origin: string;
  affects_client: boolean;
  status: "open" | "decided" | "withdrawn";
  chosen: number | null;
  decided_by: string | null;
  decided_at: string | null;
  deliver_after: string | null;
  delivered_at: string | null;
  created_by: string | null;
  created_at: string;
  request_id: string | null;
  options: Option[];
};

export type RequestStatus = "asked" | "being decided" | "question" | "answered" | "decided" | "planned" | "ready to try" | "done";

// A client's request. The client reads only their own; the team reads them all.
export type Request = {
  id: string;
  member_id: string;
  title: string;
  body: string;
  status: RequestStatus;
  message_id: string | null;
  from_line: string | null;
  created_at: string;
  updated_at: string;
  files?: FileRef[];
};

// A line in a client's private chat with their own AI. The team never reads these.
// by_table: the team's own AI answered, not an assistant the client connected.
export type ClientLine = { id: string; who: "client" | "assistant"; body: string; request_id: string | null; created_at: string; by_table?: boolean; waiting?: boolean };

export type RequestEvent = { id: number; request_id: string; label: string; created_at: string };

export type ClientUpdate = {
  id: string;
  body: string;
  request_id: string | null;
  decision_id: string | null;
  created_at: string;
  replies: string[];
  answer: string | null;
  answered_at: string | null;
};

export const MESSAGE_COLUMNS = "id, chat_id, member_id, body, created_at, by_ai, kind, meta";
export const JOB_COLUMNS = "id, chat_id, member_id, kind, round, status, error, created_at, stage, progress, started_at, task_id, change_id, subject";
// One change a client made in their own sandbox, as the team sees it.
export type SandboxChange = {
  id: string; member_id: string; words: string; status: "working" | "ready" | "nothing" | "passed" | "failed" | "stopped";
  summary: string | null; detail: string | null; files: string[]; commit: string | null; stale: boolean;
  verdict: "take" | "differently" | "no" | null; note: string | null; task_id: string | null; created_at: string; finished_at: string | null; test?: boolean;
};
export const CHANGE_COLUMNS = "id, member_id, words, status, summary, detail, files, commit, stale, verdict, note, task_id, created_at, finished_at, test";
// One piece of work the AIs took on: its title, the branch it is on, and how it ended.
export type Task = { id: string; chat_id: string; member_id: string | null; title: string; branch: string; status: "working" | "done" | "stopped"; result: string | null; created_at: string; finished_at: string | null };
export const TASK_COLUMNS = "id, chat_id, member_id, title, branch, status, result, created_at, finished_at";
export const NOTE_COLUMNS = "id, member_id, kind, title, body, updated_at";
export const CONNECTION_COLUMNS = "id, member_id, kind, last_seen, revoked_at, created_at, limits, model_choice, open_paths, share_paths, effort, fast, full_claude, in_folder, push_anywhere, use_repo, mode";
export const DECISION_COLUMNS =
  "id, chat_id, title, context, origin, affects_client, status, chosen, decided_by, decided_at, deliver_after, delivered_at, created_by, created_at, request_id, options:decision_options(position, label, recommended, client_words, asks_client, replies)";
export const REQUEST_COLUMNS = "id, member_id, title, body, status, message_id, from_line, created_at, updated_at, files";
export const LINE_COLUMNS = "id, who, body, request_id, created_at, by_table, waiting";
export const EVENT_COLUMNS = "id, request_id, label, created_at";
export const UPDATE_COLUMNS = "id, body, request_id, decision_id, created_at, replies, answer, answered_at";

// A page one of the table's AIs made: a whole HTML document the team opens in a locked frame. Each change is a version.
export type Page = { id: string; table_id: string; chat_id: string; job_id: string | null; made_by: string | null; title: string; about: string;
  icon: string; version: number; created_at: string; touched_at: string };
export type PageVersion = { id: string; page_id: string; n: number; job_id?: string | null; made_by: string | null; by_ai: boolean; note: string; created_at: string };
export type PageComment = { id: string; page_id: string; member_id: string | null; parent_id: string | null; version: number; anchor: string; body: string;
  to_ai: boolean; resolved_at: string | null; resolved_by: string | null; deleted_at: string | null; created_at: string };
export type PageValue = { page_id: string; key: string; value: unknown; updated_by: string | null; updated_at: string };
export const PAGE_COLUMNS = "id, table_id, chat_id, job_id, made_by, title, about, icon, version, created_at, touched_at";
export const PAGE_VERSION_COLUMNS = "id, page_id, n, job_id, made_by, by_ai, note, created_at";
export const PAGE_COMMENT_COLUMNS = "id, page_id, member_id, parent_id, version, anchor, body, to_ai, resolved_at, resolved_by, deleted_at, created_at";

// A request from a person's own full Claude Code, waiting for them to allow or deny it. Only they can read it.
export type Approval = { id: string; job_id: string | null; tool: string; summary: string; status: "waiting" | "allowed" | "denied" | "expired"; created_at: string };
export const APPROVAL_COLUMNS = "id, job_id, tool, summary, status, created_at";
