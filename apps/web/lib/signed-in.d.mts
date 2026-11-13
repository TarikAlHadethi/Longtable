// Types for signed-in.mjs, which stays plain JavaScript so its check runs with no build.
import type { User } from "@supabase/supabase-js";

type Auth = { auth: { getUser(): Promise<{ data: { user: User | null } | null; error: unknown }> } };

export function signedInUser(supabase: Auth, options?: { pause?: number }): Promise<User | null>;
export function signedInOrNull(supabase: Auth): Promise<User | null>;
