export const PHONE_COOKIE: string;
export const PHONE_PORTS: Readonly<{ server: number; vite: number }>;
export const TUNNEL_METRICS: string;
export function newKey(): string;
export function readCookie(header: string | undefined, name: string): string | undefined;
export function keyCookie(key: string): string;
export function gateDecision(req: { url?: string; cookie?: string | string[] }, key: string): 'pass' | 'pass+cookie' | 'deny';
export function parseTunnelUrl(log: string): string | undefined;
export interface NamedTunnel { hostname: string; tunnelId: string; credentialsFile: string }
export function parseNamedTunnel(text: string | undefined): NamedTunnel | undefined;
export function laneGoogleEnv(dotenv: Record<string, string>, hostname: string): Record<string, string>;
export function tunnelArgs(named: { tunnelId: string; credentialsFile: string } | undefined): string[];
export function resolvePhoneDir(cwd?: string, env?: NodeJS.ProcessEnv): string;
export function laneServerEnv(runDir: string): { EQX_ENABLE_TEST_ROOMS: string; EQX_ENABLE_SANDBOX_ROOM: string; EQX_TEST_SIGNIN: string; EQX_DIAG_DIR: string };
