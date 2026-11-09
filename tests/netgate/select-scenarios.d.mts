/**
 * Types for the plain-JS netgate selector (`select-scenarios.mjs`). The
 * runtime stays JS so CI's cheap `changes` job runs it with bare node;
 * this declaration lets `scenarios.test.ts` import + lock it type-cleanly.
 */
export declare const GATED_SCENARIO_GLOBS: Record<string, string[]>;
export declare const LIVELOOP_PREFIXES: string[];
export declare function selectScenarios(changedFiles: unknown): string[];
