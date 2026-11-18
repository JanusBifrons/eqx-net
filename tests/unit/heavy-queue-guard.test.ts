/**
 * Unit test for the heavy-job queue guard (`scripts/dev/heavy-queue-guard.mjs`):
 * heavy entry points refuse unless queued (EQX_HEAVY_QUEUE), on CI, or with the
 * EQX_HEAVY_QUEUE_SKIP=1 escape; a filtered (single file / -t / --grep) run is
 * light and never blocked. Also locks that `pnpm heavy run` sets the env var.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  guardDecision, isFullPlaywrightRun, isFullVitestRun, refusalMessage,
} from '../../scripts/dev/heavy-queue-guard.mjs';

const SCRIPT = path.resolve(__dirname, '../../scripts/dev/heavy-queue.mjs');

describe('guardDecision', () => {
  it('blocks a full run with no queue, CI or escape', () => {
    expect(guardDecision({ env: {}, full: true })).toEqual({ block: true, reason: 'unqueued' });
  });
  it('lets queued, CI and escaped runs through, even when full', () => {
    expect(guardDecision({ env: { EQX_HEAVY_QUEUE: 'abc' } })).toEqual({ block: false, reason: 'queued' });
    expect(guardDecision({ env: { CI: 'true' } })).toEqual({ block: false, reason: 'ci' });
    expect(guardDecision({ env: { EQX_HEAVY_QUEUE_SKIP: '1' } })).toEqual({ block: false, reason: 'skip' });
  });
  it('a light run is never blocked', () => {
    expect(guardDecision({ env: {}, full: false })).toEqual({ block: false, reason: 'light' });
  });
  it('the escape needs exactly 1; empty vars do not count', () => {
    expect(guardDecision({ env: { EQX_HEAVY_QUEUE_SKIP: 'yes' } }).block).toBe(true);
    expect(guardDecision({ env: { EQX_HEAVY_QUEUE: '', CI: '' } }).block).toBe(true);
  });
  it('the refusal names the exact queued command', () => {
    expect(refusalMessage('film', 'pnpm showcase --shot "fc-*"'))
      .toContain('pnpm heavy run --kind film --who <label> -- pnpm showcase --shot "fc-*"');
    expect(refusalMessage('film', 'x')).toContain('EQX_HEAVY_QUEUE_SKIP=1');
  });
});

describe('isFullVitestRun (pnpm test / integration)', () => {
  it.each([
    [[]],
    [['run']],
    [['--coverage']],
    [['run', '--config', 'vitest.integration.config.ts']],
    [['run', '--config=vitest.integration.config.ts', '--shard=1/4']],
    [['--reporter', 'verbose']],
  ])('%j is full', (args) => {
    expect(isFullVitestRun(args)).toBe(true);
  });
  it.each([
    [['tests/unit/foo.test.ts']],
    [['foo']],
    [['-t', 'a name']],
    [['--testNamePattern=x']],
    [['run', '--config', 'vitest.integration.config.ts', 'tests/integration/x.test.ts']],
    [['related', 'src/a.ts']],
    [['--changed']],
    [['--unknownFlag', 'value']], // unknown token leans light, never blocks
  ])('%j is light', (args) => {
    expect(isFullVitestRun(args)).toBe(false);
  });
});

describe('isFullPlaywrightRun', () => {
  it.each([
    [['test']],
    [['test', '--project=smoke', '--project=feature']],
    [['test', '--project', 'smoke', '--workers', '1']],
  ])('%j is full', (args) => {
    expect(isFullPlaywrightRun(args)).toBe(true);
  });
  it.each([
    [[]], // a worker re-loading the config
    [['show-report']],
    [['test', 'tests/e2e/boot.spec.ts']],
    [['test', '--project=gate', 'tests/e2e/netcode-health.spec.ts']],
    [['test', '-g', 'boots']],
    [['test', '--grep=boots']],
    [['test', '--list']],
  ])('%j is light', (args) => {
    expect(isFullPlaywrightRun(args)).toBe(false);
  });
});

describe('pnpm heavy run', () => {
  it('sets EQX_HEAVY_QUEUE on the child it runs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-guard-'));
    try {
      const out = path.join(dir, 'env.txt');
      const job = `require('fs').writeFileSync(${JSON.stringify(out)}, process.env.EQX_HEAVY_QUEUE || '')`;
      const env = { ...process.env, HEAVY_QUEUE_DIR: path.join(dir, 'q'), HEAVY_QUEUE_MIN_GB: '0', HEAVY_QUEUE_POLL_MS: '100' };
      delete env['EQX_HEAVY_QUEUE'];
      const code = await new Promise<number>((resolve) => {
        const p = spawn(process.execPath, [SCRIPT, 'run', '--kind', 'other', '--', process.execPath, '-e', job], { env, stdio: 'ignore' });
        p.on('exit', (c) => resolve(c ?? 1));
      });
      expect(code).toBe(0);
      expect(fs.readFileSync(out, 'utf8')).toMatch(/\S/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
