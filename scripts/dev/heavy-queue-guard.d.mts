export type GuardReason = 'queued' | 'ci' | 'skip' | 'light' | 'unqueued';
export interface GuardDecision { block: boolean; reason: GuardReason }
export function guardDecision(opts?: { env?: NodeJS.ProcessEnv; full?: boolean }): GuardDecision;
export function isFullVitestRun(args: readonly string[]): boolean;
export function isFullPlaywrightRun(args: readonly string[]): boolean;
export function shellLine(args: readonly string[]): string;
export function refusalMessage(kind: string, command: string): string;
export function requireHeavyQueue(opts: { kind: string; command: string; full?: boolean; env?: NodeJS.ProcessEnv }): GuardDecision;
