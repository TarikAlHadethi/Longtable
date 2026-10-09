export type Role = "owner" | "developer" | "client";

export type Member = { id: string; display_name: string; role: Role; color: string };

export type Chat = { id: string; name: string; about: string; is_general: boolean; created_at: string };

export type Message = {
  id: string;
  chat_id: string;
  member_id: string;
  body: string;
  created_at: string;
  state?: "sending" | "failed";
};

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
  options: Option[];
};

export const MESSAGE_COLUMNS = "id, chat_id, member_id, body, created_at";
export const DECISION_COLUMNS =
  "id, chat_id, title, context, origin, affects_client, status, chosen, decided_by, decided_at, deliver_after, delivered_at, created_by, created_at, options:decision_options(position, label, recommended, client_words)";
