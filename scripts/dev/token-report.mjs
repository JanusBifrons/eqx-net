// Measures Claude Code token usage from session transcripts: per-call usage before vs after a cutover,
// CLAUDE.md (nested_memory) loads, and "carried characters" by source (chars x later calls re-reading them).
// Read-only: it only reads local transcript .jsonl files under ~/.claude/projects; nothing is sent anywhere.
// Usage: node scripts/dev/token-report.mjs [--dir <transcripts dir>] [--cutover <ISO>] [--since <ISO>] [--skip <sessionId>]
//   --cutover: start of the "after" bucket (default 2026-11-14T18:30:00Z; "before" ends 2.5 h earlier)
//   --since:   ignore transcript lines older than this in the carry report (default 2026-11-08T00:00:00Z)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const projects = path.join(os.homedir(), '.claude', 'projects');
const derived = path.join(projects, process.cwd().replace(/[:\/.]/g, '-'));
const ROOT = opt('dir', fs.existsSync(derived) ? derived : path.join(projects, 'C--Users-alecv-Documents-Projects-eqx-net'));
const SKIP_SESSION = opt('skip', '');
const AFTER_START = Date.parse(opt('cutover', '2026-11-14T18:30:00Z'));
const BEFORE_END = AFTER_START - 2.5 * 3.6e6;
const SINCE = Date.parse(opt('since', '2026-11-08T00:00:00Z'));
if (!fs.existsSync(ROOT) || Number.isNaN(AFTER_START) || Number.isNaN(SINCE)) {
  console.error(`Bad arguments or missing transcripts dir: ${ROOT}`); process.exit(1);
}
console.log(`Transcripts: ${ROOT}\nCutover: ${new Date(AFTER_START).toISOString()}  Since (carry): ${new Date(SINCE).toISOString()}\n`);
const bucketOf = (t) => (t < BEFORE_END ? 'before' : t >= AFTER_START ? 'after' : 'transition');

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'memory' && e.name !== 'tool-results') walk(p, out); }
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const transcripts = [];
async function usageReport() {
for (const file of walk(ROOT)) {
  if (SKIP_SESSION && file.includes(SKIP_SESSION)) continue;
  const isSub = file.includes(`${path.sep}subagents${path.sep}`);
  const calls = []; const mem = []; const seen = new Set();
  let toolChars = 0, toolResults = 0, compacts = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const t = Date.parse(o.timestamp || '');
    if (o.type === 'assistant' && o.message?.usage) {
      const id = o.message.id || o.uuid; if (seen.has(id)) continue; seen.add(id);
      const u = o.message.usage;
      const inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      calls.push({ t, ctx: inTok, read: u.cache_read_input_tokens || 0, write: u.cache_creation_input_tokens || 0, fresh: u.input_tokens || 0, out: u.output_tokens || 0, model: o.message.model });
    } else if (o.type === 'attachment' && o.attachment?.type === 'nested_memory') {
      const c = o.attachment.content?.content || '';
      mem.push({ t, chars: c.length, p: o.attachment.path });
    } else if (o.type === 'user' && Array.isArray(o.message?.content)) {
      for (const b of o.message.content) if (b.type === 'tool_result') {
        toolResults++;
        const c = b.content; toolChars += typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((a, x) => a + (x.text?.length || 0), 0) : 0;
      }
    }
    if (o.type === 'system' && o.subtype === 'compact_boundary') compacts++;
  }
  if (!calls.length) continue;
  calls.sort((a, b) => a.t - b.t);
  transcripts.push({ file, isSub, calls, mem, toolChars, toolResults, compacts, start: calls[0].t, bucket: bucketOf(calls[0].t) });
}

const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const sum = (a) => a.reduce((x, y) => x + y, 0);
const k = (n) => `${Math.round(n / 1000)}k`;
const M = (n) => `${(n / 1e6).toFixed(1)}M`;

const report = {};
for (const bucket of ['before', 'after']) {
  for (const kind of ['main', 'sub']) {
    const ts = transcripts.filter((x) => x.bucket === bucket && x.isSub === (kind === 'sub'));
    const calls = ts.flatMap((x) => x.calls);
    const memLoads = ts.flatMap((x) => x.mem);
    const spanH = ts.length ? (Math.max(...ts.map((x) => x.calls.at(-1).t)) - Math.min(...ts.map((x) => x.start))) / 3.6e6 : 0;
    report[`${bucket}/${kind}`] = {
      transcripts: ts.length,
      hoursSpanned: +spanH.toFixed(1),
      calls: calls.length,
      callsPerTranscriptMedian: median(ts.map((x) => x.calls.length)),
      inputTokens: M(sum(calls.map((c) => c.ctx))),
      cacheWrite: M(sum(calls.map((c) => c.write))),
      output: M(sum(calls.map((c) => c.out))),
      avgCtxPerCall: k(sum(calls.map((c) => c.ctx)) / (calls.length || 1)),
      medianFirstCallCtx: k(median(ts.map((x) => x.calls[0].ctx))),
      medianPeakCtx: k(median(ts.map((x) => Math.max(...x.calls.map((c) => c.ctx))))),
      claudeMdLoads: memLoads.length,
      claudeMdChars: M(sum(memLoads.map((m) => m.chars))),
      claudeMdMedianCharsPerLoad: k(median(memLoads.map((m) => m.chars))),
      claudeMdCharsPerTranscriptMedian: k(median(ts.map((x) => sum(x.mem.map((m) => m.chars))))),
      toolResultChars: M(sum(ts.map((x) => x.toolChars))),
      compactions: sum(ts.map((x) => x.compacts)),
      over250kCalls: `${Math.round((100 * calls.filter((c) => c.ctx > 250000).length) / (calls.length || 1))}%`,
    };
  }
}
console.log(JSON.stringify(report, null, 1));

// Biggest after-cutover main sessions, and the CLAUDE.md file sizes actually injected after the cutover
const after = transcripts.filter((x) => x.bucket === 'after');
console.log('\nLargest after-cutover transcripts:');
for (const x of [...after].sort((a, b) => sum(b.calls.map((c) => c.ctx)) - sum(a.calls.map((c) => c.ctx))).slice(0, 8))
  console.log(`${x.isSub ? 'sub ' : 'MAIN'} calls=${x.calls.length} total=${M(sum(x.calls.map((c) => c.ctx)))} avg=${k(sum(x.calls.map((c) => c.ctx)) / x.calls.length)} peak=${k(Math.max(...x.calls.map((c) => c.ctx)))} compacts=${x.compacts} ${path.relative(ROOT, x.file)}`);
const byPath = {};
for (const m of after.flatMap((x) => x.mem)) {
  const key = m.p.replace(/.*eqx-net[\\/]eqx-net[\\/]/, '').replace(/\.claude[\\/]worktrees[\\/][^\\/]+[\\/]/, '<wt>/');
  (byPath[key] ||= []).push(m.chars);
}
console.log('\nCLAUDE.md loads after cutover (path: loads, median chars, max chars):');
for (const [p, a] of Object.entries(byPath).sort((a, b) => sum(b[1]) - sum(a[1])).slice(0, 15)) console.log(`${p}: ${a.length}, ${k(median(a))}, ${k(Math.max(...a))}`);

// Per-call bucketing (by call timestamp), so sessions that straddle the cutover count on both sides
console.log('\nPer-call view (bucketed by call time):');
for (const kind of [false, true]) for (const b of ['before', 'after']) {
  const cs = transcripts.filter((x) => x.isSub === kind).flatMap((x) => x.calls).filter((c) => bucketOf(c.t) === b);
  const tot = sum(cs.map((c) => c.ctx));
  const hrs = cs.length ? (Math.max(...cs.map((c) => c.t)) - Math.min(...cs.map((c) => c.t))) / 3.6e6 : 0;
  console.log(`${kind ? 'sub ' : 'main'} ${b.padEnd(6)} calls=${cs.length} input=${M(tot)} avg/call=${k(tot / (cs.length || 1))} median/call=${k(median(cs.map((c) => c.ctx)))} >400k=${Math.round(100 * cs.filter((c) => c.ctx > 400000).length / (cs.length || 1))}% cacheWrite/call=${k(sum(cs.map((c) => c.write)) / (cs.length || 1))} out/call=${Math.round(sum(cs.map((c) => c.out)) / (cs.length || 1))} span=${hrs.toFixed(0)}h`);
}
// Stale (pre-diet) CLAUDE.md copies loaded after the cutover
const stale = transcripts.flatMap((x) => x.mem.map((m) => ({ ...m, f: x.file }))).filter((m) => m.t >= AFTER_START && m.chars > 45000);
console.log(`\nStale CLAUDE.md loads after cutover (>45k chars): ${stale.length}, ${M(sum(stale.map((m) => m.chars)))} chars`);
for (const m of stale.slice(0, 12)) console.log(`  ${new Date(m.t).toISOString().slice(5, 16)} ${k(m.chars)} ${m.p.replace(/.*worktrees[\/]/, 'wt:')}`);
// Sessions per main transcript: calls and peak, after cutover
console.log('\nMain transcripts with calls after cutover:');
for (const x of transcripts.filter((x) => !x.isSub && x.calls.some((c) => c.t >= AFTER_START))) {
  const cs = x.calls.filter((c) => c.t >= AFTER_START);
  console.log(`  ${path.basename(x.file).slice(0, 8)} startedBucket=${x.bucket} callsAfter=${cs.length} avgAfter=${k(sum(cs.map((c) => c.ctx)) / cs.length)} peakAfter=${k(Math.max(...cs.map((c) => c.ctx)))} totalCallsLifetime=${x.calls.length}`);
}
}
async function carryReport() {
const len = (c) => (typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((a, x) => a + (x.text?.length || (x.type === 'image' ? 0 : 0)), 0) : 0);

const agg = { main: {}, sub: {} };
const models = {};
const big = [];
let totalCarry = { main: 0, sub: 0 };
for (const file of walk(ROOT)) {
  if (SKIP_SESSION && file.includes(SKIP_SESSION)) continue;
  const kind = file.includes(`${path.sep}subagents${path.sep}`) ? 'sub' : 'main';
  const events = []; // {t, kind:'call'|'content', src, chars}
  const toolUse = new Map(); const seen = new Set();
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let idx = 0;
  for await (const line of rl) {
    if (!line) continue; let o; try { o = JSON.parse(line); } catch { continue; }
    idx++;
    const t = Date.parse(o.timestamp || '') || 0;
    if (t && t < SINCE) continue;
    if (o.type === 'assistant' && o.message) {
      for (const b of o.message.content || []) {
        if (b.type === 'tool_use') toolUse.set(b.id, b);
        if (b.type === 'text' || b.type === 'thinking') events.push({ i: idx, src: 'assistant text/thinking', chars: (b.text || b.thinking || '').length });
        if (b.type === 'tool_use') events.push({ i: idx, src: 'tool_use inputs (incl. Write/Edit bodies, agent briefs)', chars: JSON.stringify(b.input || {}).length });
      }
      const id = o.message.id || o.uuid;
      if (o.message.usage && !seen.has(id)) {
        seen.add(id); events.push({ i: idx, call: true });
        const u = o.message.usage; const m = (models[`${kind} ${o.message.model}`] ||= { calls: 0, read: 0, write: 0, fresh: 0, out: 0 });
        m.calls++; m.read += u.cache_read_input_tokens || 0; m.write += u.cache_creation_input_tokens || 0; m.fresh += u.input_tokens || 0; m.out += u.output_tokens || 0;
      }
    } else if (o.type === 'attachment' && o.attachment) {
      const a = o.attachment; const c = a.content?.content ?? a.content;
      events.push({ i: idx, src: `attachment:${a.type}`, chars: typeof c === 'string' ? c.length : JSON.stringify(a).length });
    } else if (o.type === 'user' && o.message) {
      const content = o.message.content;
      if (typeof content === 'string') { events.push({ i: idx, src: o.isMeta ? 'user meta/reminders' : 'user prompt', chars: content.length }); continue; }
      for (const b of content || []) {
        if (b.type === 'tool_result') {
          const tu = toolUse.get(b.tool_use_id); let src = `tool:${tu?.name || '?'}`;
          if (tu && (tu.name === 'Bash' || tu.name === 'PowerShell')) src = classifyBash(tu.input?.command);
          if (tu?.name?.startsWith('mcp__')) src = 'tool:mcp';
          const ch = len(b.content);
          events.push({ i: idx, src, chars: ch, cmd: tu?.input?.command || tu?.input?.file_path || tu?.input?.pattern });
        } else if (b.type === 'text') events.push({ i: idx, src: 'user text/reminders', chars: b.text.length });
      }
    } else if (o.type === 'system' && o.subtype === 'compact_boundary') events.push({ i: idx, compact: true });
  }
  // carry: calls after each content event, until the next compaction
  let callsAfter = 0; const carry = [];
  for (let j = events.length - 1; j >= 0; j--) {
    const e = events[j];
    if (e.compact) { callsAfter = 0; continue; }
    if (e.call) { callsAfter++; continue; }
    carry.push([e, callsAfter]);
  }
  for (const [e, n] of carry) {
    const a = (agg[kind][e.src] ||= { chars: 0, carry: 0, count: 0 });
    a.chars += e.chars; a.carry += e.chars * n; a.count++; totalCarry[kind] += e.chars * n;
    if (e.chars * n > 2e8) big.push({ kind, src: e.src, chars: e.chars, n, cmd: String(e.cmd || '').slice(0, 110) });
  }
}
for (const kind of ['main', 'sub']) {
  console.log(`\n== ${kind}: carried characters by source (share of all carried content) ==`);
  for (const [s, a] of Object.entries(agg[kind]).sort((x, y) => y[1].carry - x[1].carry).slice(0, 18))
    console.log(`${s.padEnd(58)} carry=${(a.carry / 1e9).toFixed(1)}G (${((100 * a.carry) / totalCarry[kind]).toFixed(1)}%) chars=${(a.chars / 1e6).toFixed(1)}M n=${a.count} avgChars=${Math.round(a.chars / a.count)}`);
}
console.log('\n== models (tokens) ==');
for (const [m, v] of Object.entries(models).sort((a, b) => b[1].read - a[1].read)) console.log(`${m.padEnd(40)} calls=${v.calls} cacheRead=${(v.read / 1e6).toFixed(0)}M cacheWrite=${(v.write / 1e6).toFixed(1)}M fresh=${(v.fresh / 1e6).toFixed(1)}M out=${(v.out / 1e6).toFixed(1)}M`);
console.log('\n== single biggest carried items ==');
for (const b of big.sort((a, b) => b.chars * b.n - a.chars * a.n).slice(0, 15)) console.log(`${b.kind} ${b.src} ${Math.round(b.chars / 1000)}k x ${b.n} calls :: ${b.cmd}`);
}
function classifyBash(cmd = '') {
  const c = cmd.replace(/^\s*(cd [^;&|]+(&&|;)\s*)+/, '').trim();
  if (/\b(pnpm|npm|npx)\s+(run\s+)?(test|vitest|e2e|test:\S+|playwright)|\bvitest\b|\bplaywright\b/.test(c)) return 'bash:tests';
  if (/\b(pnpm|npm)\s+(run\s+)?(typecheck|lint|build|tsc)|\btsc\b|\beslint\b/.test(c)) return 'bash:typecheck/lint/build';
  if (/^(git\s+(-C\s+\S+\s+)?grep|grep|rg)\b/.test(c)) return 'bash:grep';
  if (/^(cat|sed|head|tail|awk|nl|less|type|Get-Content)\b/.test(c)) return 'bash:cat/sed/head';
  if (/^git\s+(-C\s+\S+\s+)?(diff|show|log)\b/.test(c)) return 'bash:git diff/show/log';
  if (/^git\b/.test(c)) return 'bash:git other';
  if (/^gh\b/.test(c)) return 'bash:gh';
  if (/ffmpeg|ffprobe/.test(c)) return 'bash:video';
  if (/^(timeout\s+\d+\s+)?pnpm\s+dev/.test(c)) return 'bash:dev server';
  if (/^node\b/.test(c)) return 'bash:node script';
  if (/^(ls|find|wc|du|stat|Get-ChildItem)\b/.test(c)) return 'bash:ls/find/wc';
  return 'bash:other';
}

console.log('######## Usage before vs after cutover ########');
await usageReport();
console.log('\n######## Carried characters by source ########');
await carryReport();
