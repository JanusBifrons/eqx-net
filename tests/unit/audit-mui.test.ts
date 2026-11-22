/**
 * Unit test for `scripts/audit-mui.mjs` (ui-language plan C6): the MUI lint
 * wall's shrink-only allowlist. Locks: a new MUI importer outside src/ui fails,
 * a stale or missing allowlist entry fails with "remove it from the allowlist",
 * src/ui is out of scope, and today's tree passes. Also checks the eslint wall
 * itself on one allowlisted and one non-allowlisted path.
 *
 * Lives under `tests/unit/` because that's where `vitest.config.ts` looks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ESLint } from 'eslint';
import {
  audit,
  describe as describeViolation,
  importsMui,
  inScope,
  // @ts-expect-error — plain .mjs, no .d.ts; runtime import is what we test.
} from '../../scripts/audit-mui.mjs';

const REPO = path.resolve(__dirname, '../..');

let root: string;

function write(rel: string, text: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

function allow(list: string[]): void {
  write('scripts/mui-allowlist.json', JSON.stringify(list));
}

type Violation = { kind: string; rel?: string };

describe('audit-mui', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-mui-'));
    write('src/ui/EqxButton.tsx', "import Button from '@mui/material/Button';\n");
    write('src/client/Old.tsx', "import { Box } from '@mui/material';\n");
    write('src/client/Plain.tsx', "import { useState } from 'react';\n");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('passes when the list matches the importers (src/ui is out of scope)', () => {
    allow(['src/client/Old.tsx']);
    expect(audit(root).violations).toEqual([]);
  });

  it('fails a new MUI importer that is not on the list', () => {
    allow(['src/client/Old.tsx']);
    write('src/client/New.tsx', "import styled from '@emotion/styled';\n");
    const { violations } = audit(root);
    expect(violations).toEqual([{ kind: 'new', rel: 'src/client/New.tsx' }]);
    expect(describeViolation(violations[0])).toContain('src/ui catalogue');
  });

  it('fails a listed file that no longer imports MUI: remove it from the allowlist', () => {
    allow(['src/client/Old.tsx', 'src/client/Plain.tsx']);
    const { violations } = audit(root);
    expect(violations).toEqual([{ kind: 'stale', rel: 'src/client/Plain.tsx' }]);
    expect(describeViolation(violations[0])).toContain('Remove it from the allowlist');
  });

  it('fails a listed file that no longer exists: remove it from the allowlist', () => {
    allow(['src/client/Gone.tsx', 'src/client/Old.tsx']);
    const { violations } = audit(root);
    expect(violations).toEqual([{ kind: 'missing', rel: 'src/client/Gone.tsx' }]);
    expect(describeViolation(violations[0])).toContain('Remove it from the allowlist');
  });

  it('fails an unsorted list', () => {
    write('src/client/Another.tsx', "import Box from '@mui/material/Box';\n");
    allow(['src/client/Old.tsx', 'src/client/Another.tsx']);
    expect(audit(root).violations.map((v: Violation) => v.kind)).toEqual(['unsorted']);
  });

  it('detects every import form and ignores mentions in comments', () => {
    expect(importsMui("import { Box } from '@mui/material';")).toBe(true);
    expect(importsMui("export { Box } from '@mui/material';")).toBe(true);
    expect(importsMui("import '@emotion/react';")).toBe(true);
    expect(importsMui("const m = await import('@mui/icons-material/Close');")).toBe(true);
    expect(importsMui(' * verified against the installed @mui/material/Fab')).toBe(false);
    expect(inScope('src/ui/EqxButton.tsx')).toBe(false);
    expect(inScope('src/client/Old.tsx')).toBe(true);
  });

  it("today's tree passes", () => {
    const { count, violations } = audit(REPO);
    expect(violations).toEqual([]);
    expect(count).toBeGreaterThan(0);
  });
});

describe('eslint MUI wall', () => {
  const eslint = new ESLint({ cwd: REPO });
  const code = "import { Box } from '@mui/material';\nimport Close from '@mui/icons-material/Close';\nexport const x = [Box, Close];\n";
  const muiErrors = async (rel: string): Promise<string[]> => {
    const [res] = await eslint.lintText(code, { filePath: path.join(REPO, rel) });
    return res.messages
      .filter((m) => m.ruleId === 'no-restricted-imports')
      .map((m) => m.message);
  };

  it('bans raw MUI in a src/client file that is not on the allowlist', async () => {
    const msgs = await muiErrors('src/client/components/NotOnTheAllowlist.tsx');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toContain('src/ui');
  }, 30_000);

  it('lets an allowlisted file keep its MUI imports', async () => {
    const listed = JSON.parse(
      fs.readFileSync(path.join(REPO, 'scripts/mui-allowlist.json'), 'utf8'),
    ) as string[];
    expect(await muiErrors(listed[0] as string)).toEqual([]);
  }, 30_000);

  it('allows MUI inside src/ui', async () => {
    expect(await muiErrors('src/ui/SomeEntry.tsx')).toEqual([]);
  }, 30_000);
});
