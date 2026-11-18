export const PHONE_COOKIE: string;
export const PHONE_PORTS: Readonly<{ server: number; vite: number }>;
export const TUNNEL_METRICS: string;
export function newKey(): string;
export function readCookie(header: string | undefined, name: string): string | undefined;
export function keyCookie(key: string): string;
export function gateDecision(req: { url?: string; cookie?: string | string[] }, key: string): 'pass' | 'pass+cookie' | 'deny';
export function parseTunnelUrl(log: string): string | undefined;
export function resolvePhoneDir(cwd?: string, env?: NodeJS.ProcessEnv): string;
