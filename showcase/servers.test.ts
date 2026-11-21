import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultPorts, loggedSpawnPlan, portOffset } from './servers';

describe('capture server ports', () => {
  it('default to 2767 / 5373', () => {
    expect(defaultPorts({})).toEqual({ server: 2767, vite: 5373 });
  });

  it('shift by EQX_SHOWCASE_PORT_OFFSET', () => {
    expect(defaultPorts({ EQX_SHOWCASE_PORT_OFFSET: '300' })).toEqual({ server: 3067, vite: 5673 });
    expect(portOffset({ EQX_SHOWCASE_PORT_OFFSET: '' })).toBe(0);
  });

  it('reject a bad offset rather than guess', () => {
    expect(() => portOffset({ EQX_SHOWCASE_PORT_OFFSET: 'abc' })).toThrow(/whole number/);
    expect(() => portOffset({ EQX_SHOWCASE_PORT_OFFSET: '-5' })).toThrow();
  });
});

describe('logged spawn (server.log / vite.log capture)', () => {
  it('an outliving Windows child runs under a node relay, never a detached shell', () => {
    // A detached cmd.exe has no console, so the node it starts gets a console
    // of its own and writes there: the log file stays 0 bytes (the phone
    // lane's empty run/server.log). A detached node relay keeps the handles.
    const p = loggedSpawnPlan('pnpm dev:server:nowatch', true, 'win32', 'C:/node/node.exe');
    expect(p.file).toBe('C:/node/node.exe');
    expect(p.shell).toBe(false);
    expect(p.detached).toBe(true);
    expect(p.args[0]).toBe('-e');
    expect(p.args[p.args.length - 1]).toBe('pnpm dev:server:nowatch');
  });

  it('everything else runs the command in a shell as before', () => {
    expect(loggedSpawnPlan('pnpm x', false, 'win32', 'node')).toEqual({ file: 'pnpm x', args: [], shell: true, detached: false });
    expect(loggedSpawnPlan('pnpm x', true, 'linux', 'node')).toEqual({ file: 'pnpm x', args: [], shell: true, detached: true });
    expect(loggedSpawnPlan('pnpm x', false, 'linux', 'node')).toEqual({ file: 'pnpm x', args: [], shell: true, detached: true });
  });

  it('an outliving child\'s grandchild stdout and stderr reach the log file', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'eqx-logged-spawn-'));
    const log = path.join(dir, 'out.log');
    const fd = openSync(log, 'a');
    const p = loggedSpawnPlan(`node -e "console.log('to-out');console.error('to-err')"`, true, process.platform, process.execPath);
    const child = spawn(p.file, p.args, { shell: p.shell, detached: p.detached, windowsHide: true, stdio: ['ignore', fd, fd] });
    closeSync(fd);
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));
    const text = readFileSync(log, 'utf8');
    rmSync(dir, { recursive: true, force: true });
    expect(text).toContain('to-out');
    expect(text).toContain('to-err');
  }, 20_000);
});
