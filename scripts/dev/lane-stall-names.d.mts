export function decodeMappings(mappings: string): number[][][];
export function offsetToLineCol(text: string, offset: number): { line: number; col: number };
export interface StallName { source: string; line: number; col: number; name: string | null; code: string | null }
export function resolvePosition(map: { sources: string[]; names?: string[]; sourcesContent?: (string | null)[]; mappings: string }, line: number, col: number, genText?: string): StallName | null;
export function makeResolver(distDir: string): (url: string | null | undefined, charPos: number | undefined) => Partial<StallName> & { unresolved?: string };
export function readEvents(text: string): Array<{ tag?: string; data?: Record<string, unknown> }>;
export function nameStalls(events: ReadonlyArray<{ tag?: string; data?: Record<string, unknown> }>, resolve: ReturnType<typeof makeResolver>): {
  functions: Array<{ where: string; name: string | null; code: string | null; totalMs: number; count: number; maxMs: number }>;
  unresolved: Record<string, number>;
  stalls: Array<{ tag: string; mode: string; count: number; totalMs: number }>;
  zoom: Array<{ viewHalf: string; count: number }>;
};
export function zoomBucket(viewHalf: number): string;
