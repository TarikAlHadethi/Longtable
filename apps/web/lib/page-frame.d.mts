// Types for page-frame.mjs, which stays plain JavaScript so its check runs with no build.
export const FRAME_SANDBOX: string;
export const FRAME_POLICY: string;
export function frameDoc(html: string, opts: { key: string; me: string }): string;
