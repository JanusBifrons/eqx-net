/**
 * Phone lane, pure parts (plan machine-independent-perf WS5.1): argument
 * parsing, the adb device check, the device label, the phone's thermal gate,
 * and the rep plan. `perf/run-phone.ts` is the CLI that drives the real phone;
 * everything that can be decided without one lives here so it is unit-tested
 * (perf/phoneLane.test.ts, with adb mocked through the `AdbExec` seam).
 *
 * The A/B itself is the same as `pnpm perf:scenes`: the same arms (base,
 * head, optional `aa` noise arm), the same order (perf/order.ts), the same
 * verdict (perf/verdict.ts) and the same ledger shape. Only the browser is
 * different: Chrome on an Android phone over adb, instead of a laptop browser.
 */
import { DEFAULT_LIMITS, type LoadLimits } from '../showcase/hostLoad.js';
import { armOrder, evenReps } from './order.js';

export interface PhoneArgs {
  scenes: string[];
  reps: number;
  base: string;
  headOnly: boolean;
  out: string | undefined;
  baseParams: string;
  headParams: string;
  /** undefined = decide from the arms (on for an A/A run), like perf:scenes. */
  noiseCheck: boolean | undefined;
  /** adb serial when more than one device is attached. */
  serial: string | undefined;
  /** Reach the laptop over the LAN instead of `adb reverse` (USB). */
  lan: boolean;
  append: string | undefined;
  ignorePorts: number[];
  loadGate: boolean;
  limits: LoadLimits;
  /** Android thermal status at or above which a rep doesn't start (2 = MODERATE). */
  maxThermal: number;
}

/** Flags that belong to `pnpm perf:scenes` only: they mean nothing on a real phone. */
const PROXY_ONLY = ['--device', '--cpu-rate', '--headed', '--inject-server-burn', '--inject-client-burn'];

export class PhoneLaneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhoneLaneError';
  }
}

/** Parse `pnpm perf:phone` flags. Throws PhoneLaneError on a bad flag or scene. */
export function parsePhoneArgs(argv: readonly string[], knownScenes: readonly string[]): PhoneArgs {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(k);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new PhoneLaneError(`${k} needs a value`);
    return v;
  };
  for (const f of PROXY_ONLY) {
    if (argv.includes(f)) {
      throw new PhoneLaneError(`${f} is a perf:scenes flag; the phone lane runs on the real phone. For the laptop proxy use: pnpm perf:scenes --device phone-proxy --cpu-rate 2 ...`);
    }
  }
  const scenes = (get('--scenes') ?? 'fleet-fight,wide-view').split(',').filter(Boolean);
  for (const s of scenes) {
    if (!knownScenes.includes(s)) throw new PhoneLaneError(`unknown scene ${s} (have ${knownScenes.join(', ')})`);
  }
  const reps = Number(get('--reps') ?? 8);
  if (!Number.isFinite(reps) || reps < 1) throw new PhoneLaneError(`--reps must be a positive number, got ${get('--reps')}`);
  const maxThermal = Number(get('--max-thermal') ?? 2);
  if (!Number.isInteger(maxThermal) || maxThermal < 1 || maxThermal > 6) throw new PhoneLaneError('--max-thermal must be an Android thermal status 1-6 (2 = MODERATE)');
  const maxCpu = get('--max-cpu-pct');
  return {
    scenes,
    reps,
    base: get('--base') ?? 'origin/main',
    headOnly: argv.includes('--head-only'),
    out: get('--out'),
    baseParams: get('--base-params') ?? '',
    headParams: get('--head-params') ?? '',
    noiseCheck: argv.includes('--noise-check') ? true : argv.includes('--no-noise-check') ? false : undefined,
    serial: get('--serial') ?? process.env['ANDROID_SERIAL'],
    lan: argv.includes('--lan'),
    append: get('--append'),
    ignorePorts: (get('--ignore-ports') ?? '').split(',').filter(Boolean).map(Number),
    loadGate: !argv.includes('--no-load-gate'),
    limits: { ...DEFAULT_LIMITS, ...(maxCpu ? { maxCpuPct: Number(maxCpu) } : {}) },
    maxThermal,
  };
}

/** Runs adb with these args and returns stdout; throws like execFileSync. */
export type AdbExec = (args: readonly string[]) => string;

export interface AdbDevice { serial: string; state: string; model?: string }

/** Parse `adb devices -l`. */
export function parseAdbDevices(out: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('List of devices') || t.startsWith('*')) continue;
    const [serial, state, ...rest] = t.split(/\s+/);
    if (!serial || !state) continue;
    const model = rest.find((r) => r.startsWith('model:'))?.slice('model:'.length);
    devices.push({ serial, state, ...(model ? { model } : {}) });
  }
  return devices;
}

const FALLBACK = 'No phone today? The laptop proxy needs none: pnpm perf:scenes --device phone-proxy --cpu-rate 2 ... (docs/architecture/gpu-lit-ships.md).';

/**
 * The one phone this run drives. Fails fast, before any server or worktree is
 * touched, with a message that says what to do: adb missing, no device, the
 * USB-debugging prompt not accepted, or several devices and no `--serial`.
 */
export function requirePhone(adb: AdbExec, serial?: string): AdbDevice {
  let out: string;
  try {
    out = adb(['devices', '-l']);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new PhoneLaneError(`adb is not on PATH. Install Android platform-tools and put adb on PATH, connect the phone with USB debugging on, then re-run.\n${FALLBACK}`);
    }
    throw new PhoneLaneError(`\`adb devices\` failed: ${err.message}\n${FALLBACK}`);
  }
  const all = parseAdbDevices(out);
  const pick = serial ? all.filter((d) => d.serial === serial) : all;
  if (serial && pick.length === 0) {
    throw new PhoneLaneError(`no adb device with serial ${serial} (attached: ${all.map((d) => `${d.serial} ${d.state}`).join(', ') || 'none'}).`);
  }
  const ready = pick.filter((d) => d.state === 'device');
  if (ready.length === 0) {
    if (pick.some((d) => d.state === 'unauthorized')) {
      throw new PhoneLaneError('the phone is attached but unauthorized: unlock it and accept the "Allow USB debugging?" prompt, then re-run.');
    }
    if (pick.length > 0) {
      throw new PhoneLaneError(`the phone is attached but ${pick.map((d) => d.state).join('/')} (not ready). Reconnect it (or \`adb kill-server\`) and re-run.`);
    }
    throw new PhoneLaneError(`no Android device attached (\`adb devices\` lists none). Connect the phone by USB with USB debugging on, or pair it with wireless debugging, unlock it, then re-run.\n${FALLBACK}`);
  }
  if (ready.length > 1) {
    throw new PhoneLaneError(`${ready.length} devices attached (${ready.map((d) => d.serial).join(', ')}): pass --serial <serial> (or set ANDROID_SERIAL).`);
  }
  return ready[0]!;
}

export interface PhoneProps { manufacturer: string; model: string; android: string; sdk: string; soc: string }

/** The phone's identity from `getprop` (what the ledger records). */
export function phoneProps(adb: AdbExec, serial: string): PhoneProps {
  const prop = (k: string): string => {
    try { return adb(['-s', serial, 'shell', 'getprop', k]).trim(); } catch { return ''; }
  };
  return {
    manufacturer: prop('ro.product.manufacturer') || 'unknown',
    model: prop('ro.product.model') || 'unknown',
    android: prop('ro.build.version.release') || 'unknown',
    sdk: prop('ro.build.version.sdk') || 'unknown',
    soc: prop('ro.soc.model') || prop('ro.board.platform') || 'unknown',
  };
}

/** "Google Pixel 7 · Android 14 · Mali-G710": the ledger's `device`. */
export function deviceLabel(p: PhoneProps, gpuRenderer: string): string {
  const name = p.model.toLowerCase().startsWith(p.manufacturer.toLowerCase()) ? p.model : `${p.manufacturer} ${p.model}`;
  return `${name} · Android ${p.android} · ${gpuRenderer}`;
}

/** Android thermal status from `dumpsys thermalservice` (0 NONE … 6 SHUTDOWN; -1 unknown). */
export function parseThermalStatus(out: string): number {
  const m = out.match(/Thermal Status:\s*(\d+)/);
  return m ? Number(m[1]) : -1;
}

export const THERMAL_NAMES = ['NONE', 'LIGHT', 'MODERATE', 'SEVERE', 'CRITICAL', 'EMERGENCY', 'SHUTDOWN'];

/**
 * Why the phone isn't fit to measure, or [] when it is. A hot phone throttles
 * its own clocks: that is the phone's version of a busy host.
 */
export function judgePhone(state: { thermal: number; awake: boolean; locked: boolean }, maxThermal: number): string[] {
  const why: string[] = [];
  if (!state.awake) why.push('phone screen off (Doze cuts Chrome\'s network): wake it');
  if (state.locked) why.push('phone on the lockscreen: unlock it');
  if (state.thermal >= maxThermal) why.push(`phone thermal status ${state.thermal} (${THERMAL_NAMES[state.thermal] ?? '?'}) >= ${maxThermal}: let it cool`);
  return why;
}

/** Awake / lockscreen from `dumpsys power` + `dumpsys window` (adbPreflight.ts's signals). */
export function parseAwake(power: string, window: string): { awake: boolean; locked: boolean } {
  const wake = power.match(/mWakefulness=(\w+)/)?.[1];
  const screenOn = window.match(/mScreenOnFully=(true|false)/)?.[1];
  const locked = window.match(/mDreamingLockscreen=(true|false)/)?.[1] === 'true';
  // An unknown field doesn't block: OEM builds differ, and the page load
  // fails loudly anyway if the network really is cut.
  return { awake: wake === undefined || (wake === 'Awake' && screenOn !== 'false'), locked };
}

export type ArmName = 'base' | 'head' | 'aa';

export interface ArmSpec { name: ArmName; clientParams: Record<string, string> }

/** The arms, as perf:scenes builds them: base (unless --head-only), head, and `aa` with the noise check. */
export function planArms(args: Pick<PhoneArgs, 'headOnly' | 'baseParams' | 'headParams' | 'noiseCheck'>, baseSha: string | null, headSha: string): { arms: ArmSpec[]; noiseCheck: boolean } {
  const params = (s: string): Record<string, string> => Object.fromEntries(new URLSearchParams(s));
  const head: ArmSpec = { name: 'head', clientParams: params(args.headParams) };
  if (args.headOnly) return { arms: [head], noiseCheck: false };
  const base: ArmSpec = { name: 'base', clientParams: params(args.baseParams) };
  const same = baseSha === headSha && JSON.stringify(base.clientParams) === JSON.stringify(head.clientParams);
  const noiseCheck = args.noiseCheck ?? same;
  const arms = [base, head];
  if (noiseCheck) arms.push({ name: 'aa', clientParams: { ...base.clientParams } });
  return { arms, noiseCheck };
}

/** Reps actually run: even (each arm second equally often), or as asked with --head-only. */
export function phoneReps(args: Pick<PhoneArgs, 'reps' | 'headOnly'>): number {
  return args.headOnly ? Math.max(1, Math.floor(args.reps)) : evenReps(args.reps);
}

/** Arm order of every round, from perf/order.ts (rep numbers continue across --append chunks). */
export function planRounds<T>(arms: readonly T[], reps: number, priorReps = 0): T[][] {
  const rounds: T[][] = [];
  for (let rep = 0; rep < reps; rep++) rounds.push(armOrder(arms, priorReps + rep));
  return rounds;
}

/** A shiplight A/B whose arm has no `shiplight` falls back to the phone's saved level: say so. */
export function paramWarnings(arms: readonly ArmSpec[]): string[] {
  const lit = arms.filter((a) => a.clientParams['shiplight'] !== undefined);
  if (lit.length === 0 || lit.length === arms.length) return [];
  return arms.filter((a) => a.clientParams['shiplight'] === undefined)
    .map((a) => `warning: the ${a.name} arm sets no shiplight, so it runs the phone's saved level (Settings) or its device default, not baked. Pass --${a.name === 'head' ? 'head' : 'base'}-params shiplight=baked to pin it.`);
}
