/**
 * Unit test for the session-length nudge hook
 * (`scripts/dev/context-nudge.mjs`, wired as a PostToolUse hook in
 * `.claude/settings.json`). Locks: silence under 250k, one nudge per
 * threshold per session, subagent skip, and silent exit 0 on any bad input.
 *
 * Lives under `tests/unit/` because that's where `vitest.config.ts` looks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error — plain .mjs, no .d.ts; runtime import is what we test.
import { run, contextTokens } from '../../scripts/dev/context-nudge.mjs';

const SCRIPT = path.resolve(__dirname, '../../scripts/dev/context-nudge.mjs');

let dir: string;
let stateDir: string;

function assistant(input: number, cacheRead: number, cacheCreate: number, extra = {}) {
  return JSON.stringify({
    type: 'assistant',
    ...extra,
    message: {
      role: 'assistant',
      usage: {
        input_tokens: input,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreate,
        output_tokens: 99,
      },
    },
  });
}

function transcript(name: string, lines: string[]): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

function input(tp: string, extra = {}) {
  return {
    session_id: 'sess-1',
    transcript_path: tp,
    cwd: dir,
    hook_event_name: 'PostToolUse',
    ...extra,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-nudge-test-'));
  stateDir = path.join(dir, 'state');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('context-nudge hook', () => {
  it('sums input + cache read + cache creation from the LAST assistant record', () => {
    const tp = transcript('t.jsonl', [
      assistant(1, 500_000, 0),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      assistant(10, 200_000, 5_000),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'tool result' } }),
    ]);
    expect(contextTokens(tp)).toBe(205_010);
  });

  it('is silent under 250k', () => {
    const tp = transcript('t.jsonl', [assistant(10, 240_000, 1_000)]);
    expect(run(input(tp), stateDir)).toBe('');
  });

  it('nudges once at 250k, then once at 400k, then never again', () => {
    const tp = transcript('t.jsonl', [assistant(10, 260_000, 2_000)]);
    const first = JSON.parse(run(input(tp), stateDir));
    expect(first.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(first.hookSpecificOutput.additionalContext).toMatch(/~262k tokens/);
    expect(first.hookSpecificOutput.additionalContext).toMatch(/Keep context small/);
    expect(run(input(tp), stateDir)).toBe('');

    fs.appendFileSync(tp, assistant(10, 410_000, 0) + '\n');
    const second = JSON.parse(run(input(tp), stateDir));
    expect(second.hookSpecificOutput.additionalContext).toMatch(/~410k tokens.*400k line/);
    expect(run(input(tp), stateDir)).toBe('');

    // another session starts fresh
    expect(run(input(tp, { session_id: 'sess-2' }), stateDir)).not.toBe('');
  });

  it('jumping straight past 400k fires one message and marks both lines', () => {
    const tp = transcript('t.jsonl', [assistant(0, 500_000, 0)]);
    expect(JSON.parse(run(input(tp), stateDir)).hookSpecificOutput.additionalContext).toMatch(
      /400k line/,
    );
    expect(run(input(tp), stateDir)).toBe('');
  });

  it('ignores sidechain records and finds usage beyond the 256 KB tail', () => {
    const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(100_000) } });
    const tp = transcript('t.jsonl', [
      assistant(0, 300_000, 0),
      filler,
      filler,
      filler,
      assistant(0, 10, 0, { isSidechain: true }),
    ]);
    expect(contextTokens(tp)).toBe(300_000);
  });

  it('skips subagents (agent_id present)', () => {
    const tp = transcript('t.jsonl', [assistant(0, 900_000, 0)]);
    expect(run(input(tp, { agent_id: 'a1', agent_type: 'Explore' }), stateDir)).toBe('');
  });

  it('end-to-end: prints the hook JSON and exits 0', () => {
    const tp = transcript('t.jsonl', [assistant(10, 260_000, 2_000)]);
    const r = spawnSync(process.execPath, [SCRIPT], {
      input: JSON.stringify(input(tp)),
      env: { ...process.env, CONTEXT_NUDGE_STATE_DIR: stateDir },
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toMatch(/~262k/);
  });

  it.each([
    ['not json', 'garbage{'],
    ['empty', ''],
    [
      'missing transcript',
      JSON.stringify({ session_id: 's', transcript_path: '/no/such/file.jsonl' }),
    ],
    ['no fields', JSON.stringify({})],
  ])('malformed input (%s) → silent exit 0', (_name, stdin) => {
    const r = spawnSync(process.execPath, [SCRIPT], {
      input: stdin,
      env: { ...process.env, CONTEXT_NUDGE_STATE_DIR: stateDir },
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  it('malformed transcript lines → silent', () => {
    const tp = transcript('t.jsonl', ['{not json', '"usage" broken']);
    expect(run(input(tp), stateDir)).toBe('');
  });
});
