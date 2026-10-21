export function githubBase(repo: string | null | undefined): string | null;
export function onlyLocal(read: string | null | undefined): boolean;
export function fileLink(repo: string | null | undefined, read: string | null | undefined, sources?: string[] | null): (code: string) => string | null;
export function landedBranch(result: string | null | undefined, branch: string): string;
