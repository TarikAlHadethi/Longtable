export type Role = "owner" | "developer" | "client";

export type Member = { id: string; display_name: string; role: Role; color: string };

export type Chat = { id: string; name: string; about: string; is_general: boolean; created_at: string };

export type Message = {
  id: string;
  chat_id: string;
  member_id: string;
  body: string;
  created_at: string;
  by_ai?: boolean;
  kind?: "chat" | "answer" | "view" | "intro" | "client";
  meta?: {
    request?: string;
    read?: string;
    model?: string;
    hidden?: boolean;
    round?: string | null;
    sources?: string[];
    how?: string;
    parts?: string[];
    confidence?: string | null;
  };
  state?: "sending" | "failed";
};

export type Job = {
  id: string;
  chat_id: string;
  member_id: string;
  kind: "answer" | "view" | "combine" | "intro";
  round: string | null;
  status: "queued" | "running" | "done" | "failed" | "waiting" | "skipped";
  error: string | null;
  created_at: string;
};

export type Connection = { id: string; member_id: string; kind: "claude" | "codex"; last_seen: string | null; revoked_at: string | null; created_at: string };

export type Note = { id: string; member_id: string | null; kind: "intro" | "summary" | "shared"; title: string; body: string; updated_at: string };

export type Option = { position: number; label: string; recommended: boolean; client_words: string };

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

export type RequestStatus = "asked" | "being decided" | "decided" | "planned" | "ready to try" | "done";

// A client's request. The client reads only their own; the team reads them all.
export type Request = {
  id: string;
  member_id: string;
  title: string;
  body: string;
  status: RequestStatus;
  message_id: string | null;
  created_at: string;
  updated_at: string;
};

export type RequestEvent = { id: number; request_id: string; label: string; created_at: string };

export type ClientUpdate = { id: string; body: string; request_id: string | null; decision_id: string | null; created_at: string };

export const MESSAGE_COLUMNS = "id, chat_id, member_id, body, created_at, by_ai, kind, meta";
export const JOB_COLUMNS = "id, chat_id, member_id, kind, round, status, error, created_at";
export const NOTE_COLUMNS = "id, member_id, kind, title, body, updated_at";
export const CONNECTION_COLUMNS = "id, member_id, kind, last_seen, revoked_at, created_at";
export const DECISION_COLUMNS =
  "id, chat_id, title, context, origin, affects_client, status, chosen, decided_by, decided_at, deliver_after, delivered_at, created_by, created_at, request_id, options:decision_options(position, label, recommended, client_words)";
export const REQUEST_COLUMNS = "id, member_id, title, body, status, message_id, created_at, updated_at";
export const EVENT_COLUMNS = "id, request_id, label, created_at";
export const UPDATE_COLUMNS = "id, body, request_id, decision_id, created_at";
