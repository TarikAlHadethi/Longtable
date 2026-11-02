export function copyWords(
  lines: readonly { id: string; who: string; by_table?: boolean | null; body: string; created_at: string }[],
  changes: readonly { id: string; created_at: string }[],
): { lineIds: Set<string>; saidFor: Map<string, string> };
