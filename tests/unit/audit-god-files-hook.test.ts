/**
 * Unit test for the single-file mode of `scripts/audit-god-files.mjs`
 * (`--hook`, wired as a PostToolUse Edit|Write|MultiEdit hook in
 * `.claude/settings.json`). Locks: same rule as CI (`checkSize`), exit 2 +
 * stderr over the ceiling or an allowlist cap, a non-blocking note near the
 * limit, silence under it, outside src/ and on malformed stdin.
 *
 * Lives under `tests/unit/` because that's where `vitest.config.ts` looks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ALLOWLIST,
  CAP_SLACK,
  CEILING_LOC,
  NEAR_MARGIN,
  checkSize,
  hookCheck,
  hookOutput,
  inScope,
  // @ts-expect-error — plain .mjs, no .d.ts; runtime import is what we test.
} from '../../scripts/audit-god-files.mjs';

const SCRIPT = path.resolve(__dirname, '../../scripts/audit-god-files.mjs');
const CAPPED = Object.keys(ALLOWLIST)[0] as string;
const CAP_LIMIT = (ALLOWLIST[CAPPED].cap as number) + CAP_SLACK;

let root: string;

/** Write `rel` under the fake repo root with exactly `lines` LOC as CI counts them. */
function file(rel: string, lines: number): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Array.from({ length: lines }, (_, i) => `// ${i}`).join('\n'));
  return abs;
}

function hook(stdin: string) {
  const r = spawnSync(process.execPath, [SCRIPT, '--hook'], { input: stdin, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'god-files-hook-'));
  // findRoot looks for the script marker + src/ (any worktree works).
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'audit-god-files.mjs'), '');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('audit-god-files single-file mode', () => {
  it('is silent under the limit', () => {
    file('src/core/small.ts', CEILING_LOC - NEAR_MARGIN);
    const r = checkSize('src/core/small.ts', CEILING_LOC - NEAR_MARGIN);
    expect(r.kind).toBe('ok');
    expect(
      hook(JSON.stringify({ cwd: root, tool_input: { file_path: 'src/core/small.ts' } })),
    ).toEqual({
      code: 0,
      stdout: '',
      stderr: '',
    });
  });

  it('adds a non-blocking note within NEAR_MARGIN of the ceiling', () => {
    const abs = file('src/core/near.ts', CEILING_LOC - 3);
    const out = hook(JSON.stringify({ tool_input: { file_path: abs } }));
    expect(out.code).toBe(0);
    expect(out.stderr).toBe('');
    const ctx = JSON.parse(out.stdout).hookSpecificOutput;
    expect(ctx.hookEventName).toBe('PostToolUse');
    expect(ctx.additionalContext).toContain(
      'src/core/near.ts is 597 LOC, 3 under the 600-LOC ceiling',
    );
  });

  it('blocks (exit 2) over the ceiling with the fix rule', () => {
    const abs = file('src/server/rooms/Big.ts', CEILING_LOC + 1);
    const out = hook(JSON.stringify({ tool_input: { file_path: abs } }));
    expect(out.code).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('src/server/rooms/Big.ts is 601 LOC, over the 600-LOC ceiling');
    expect(out.stderr).toContain('never raise the cap');
    expect(out.stderr).toContain('src/server/rooms/CLAUDE.md');
  });

  it('blocks over an allowlist cap + slack and notes near it, like CI', () => {
    file(CAPPED, CAP_LIMIT + 1);
    const over = hookOutput(hookCheck({ cwd: root, tool_input: { file_path: CAPPED } }));
    expect(over.code).toBe(2);
    expect(over.stderr).toContain(
      `${CAPPED} is ${CAP_LIMIT + 1} LOC, over its allowlist limit ${CAP_LIMIT}`,
    );
    expect(checkSize(CAPPED, CAP_LIMIT).kind).toBe('near');
    expect(checkSize(CAPPED, CAP_LIMIT - NEAR_MARGIN).kind).toBe('ok');
  });

  it('ignores paths outside src/ and non-source files', () => {
    const outside = file('scripts/huge.ts', 5000);
    expect(hookCheck({ tool_input: { file_path: outside } })).toBeNull();
    file('src/core/big.test.ts', 5000);
    expect(hookCheck({ cwd: root, tool_input: { file_path: 'src/core/big.test.ts' } })).toBeNull();
    expect(inScope('src/core/notes.md')).toBe(false);
    expect(inScope('src/core/types.d.ts')).toBe(false);
    expect(inScope('src/core/__fixtures__/x.ts')).toBe(false);
    expect(inScope('src/core/x.tsx')).toBe(true);
  });

  it('exits 0 silently on malformed stdin or a missing file', () => {
    for (const stdin of ['not json', '', '{}', JSON.stringify({ tool_input: { file_path: 42 } })]) {
      expect(hook(stdin)).toEqual({ code: 0, stdout: '', stderr: '' });
    }
    const missing = path.join(root, 'src', 'gone.ts');
    expect(hook(JSON.stringify({ tool_input: { file_path: missing } }))).toEqual({
      code: 0,
      stdout: '',
      stderr: '',
    });
  });
});
