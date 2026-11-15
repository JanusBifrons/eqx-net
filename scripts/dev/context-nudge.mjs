#!/usr/bin/env node
/**
 * Session-length nudge (PostToolUse hook, wired in .claude/settings.json).
 *
 * Root CLAUDE.md "Keep context small" says to hand off once context passes
 * ~250k tokens. Nothing prompted that rule, so main sessions drifted to
 * 500-960k. This hook reads the tail of the session transcript, takes the
 * context size from the last assistant `message.usage`, and injects a short
 * reminder the first time each threshold is crossed in a session.
 *
 * A nudge, never a block: every failure path exits 0 with no output.
 * Subagents (stdin has `agent_id`) are skipped. Dependency-free Node ESM.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const THRESHOLDS = [250_000, 400_000];
const TAIL_BYTES = 256 * 1024;
const WIDE_TAIL_BYTES = 2 * 1024 * 1024;

/** Read the last `bytes` of a file as utf8 (never the whole file). */
export function readTail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return { text: buf.toString('utf8'), whole: len === size };
  } finally {
    fs.closeSync(fd);
  }
}

/** Context tokens from the last main-thread assistant record with usage, or null. */
export function contextFromTail(text, whole) {
  const lines = text.split('\n');
  if (!whole) lines.shift(); // first line is likely cut mid-record
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"usage"')) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec?.type !== 'assistant' || rec.isSidechain) continue;
    const u = rec.message?.usage;
    if (!u) continue;
    const n =
      (u.input_tokens || 0) +
      (u.cache_read_input_tokens || 0) +
      (u.cache_creation_input_tokens || 0);
    if (n > 0) return n;
  }
  return null;
}

export function contextTokens(transcriptPath) {
  let { text, whole } = readTail(transcriptPath, TAIL_BYTES);
  let n = contextFromTail(text, whole);
  if (n === null && !whole) {
    ({ text, whole } = readTail(transcriptPath, WIDE_TAIL_BYTES));
    n = contextFromTail(text, whole);
  }
  return n;
}

export function message(tokens, threshold) {
  const k = Math.round(tokens / 1000);
  const line = `${Math.round(threshold / 1000)}k`;
  const base = `Context is ~${k}k tokens (over the ${line} line; CLAUDE.md 'Keep context small' says hand off at ~250k).`;
  return threshold >= 400_000
    ? `${base} Write the handoff (.resume/<slug>.md) now and start a fresh session; do not open new work here.`
    : `${base} At the next milestone (PR merged, stage closed), write the handoff (.resume/<slug>.md) and start a fresh session.`;
}

function stateFile(sessionId, stateDir) {
  const safe = String(sessionId)
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 100);
  return path.join(stateDir, `${safe}.json`);
}

/**
 * Pure-ish core: returns the hook stdout string ('' for silence) and
 * records fired thresholds in the state dir.
 */
export function run(input, stateDir = path.join(os.tmpdir(), 'eqx-context-nudge')) {
  if (!input || typeof input !== 'object') return '';
  if (input.agent_id) return '';
  const { session_id: sid, transcript_path: tp } = input;
  if (typeof sid !== 'string' || !sid || typeof tp !== 'string' || !tp) return '';
  const tokens = contextTokens(tp);
  if (tokens === null) return '';
  const crossed = THRESHOLDS.filter((t) => tokens >= t);
  if (crossed.length === 0) return '';

  const file = stateFile(sid, stateDir);
  let fired = [];
  try {
    fired = JSON.parse(fs.readFileSync(file, 'utf8')).fired ?? [];
  } catch {
    /* no state yet */
  }
  const fresh = crossed.filter((t) => !fired.includes(t));
  if (fresh.length === 0) return '';
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ fired: [...new Set([...fired, ...fresh])] }));

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: message(tokens, Math.max(...fresh)),
    },
  });
}

function main() {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    try {
      const out = run(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
        process.env.CONTEXT_NUDGE_STATE_DIR || undefined,
      );
      if (out) process.stdout.write(out);
    } catch {
      /* nudge only: stay silent */
    }
    process.exit(0);
  });
  process.stdin.on('error', () => process.exit(0));
}

const isMain = (() => {
  try {
    return path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) main();
