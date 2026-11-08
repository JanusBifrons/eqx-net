import { describe, it, expect } from 'vitest';
import { armOrder } from './order';
import {
  deviceLabel, judgePhone, paramWarnings, parseAdbDevices, parseAwake, parsePhoneArgs, parseThermalStatus,
  PhoneLaneError, phoneProps, phoneReps, planArms, planRounds, requirePhone, type AdbExec,
} from './phoneLane';

const SCENES = ['idle', 'fleet-fight', 'teleport-raid', 'wide-view'];

/** A fake adb: answers by the joined args, or throws what `err` says. */
function fakeAdb(answers: Record<string, string>, err?: NodeJS.ErrnoException): AdbExec & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = ((args: readonly string[]) => {
    calls.push([...args]);
    if (err) throw err;
    const key = args.join(' ');
    if (!(key in answers)) throw new Error(`unexpected adb ${key}`);
    return answers[key]!;
  }) as AdbExec & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

describe('perf:phone arg parsing', () => {
  it('defaults: fleet-fight + wide-view, 8 reps, origin/main, adb reverse, thermal gate at MODERATE', () => {
    const a = parsePhoneArgs([], SCENES);
    expect(a.scenes).toEqual(['fleet-fight', 'wide-view']);
    expect(a.reps).toBe(8);
    expect(a.base).toBe('origin/main');
    expect(a.lan).toBe(false);
    expect(a.maxThermal).toBe(2);
    expect(a.noiseCheck).toBeUndefined();
    expect(a.loadGate).toBe(true);
  });

  it('reads the GPU-lighting A/B one-liner', () => {
    const a = parsePhoneArgs(['--scenes', 'fleet-fight,wide-view', '--reps', '8', '--base', 'HEAD', '--base-params', 'shiplight=baked', '--head-params', 'shiplight=medium', '--serial', 'R5CT', '--noise-check'], SCENES);
    expect(a).toMatchObject({ base: 'HEAD', baseParams: 'shiplight=baked', headParams: 'shiplight=medium', serial: 'R5CT', noiseCheck: true, reps: 8 });
  });

  it('rejects an unknown scene, a flag without a value, and perf:scenes-only flags', () => {
    expect(() => parsePhoneArgs(['--scenes', 'nope'], SCENES)).toThrow(/unknown scene nope/);
    expect(() => parsePhoneArgs(['--base', '--reps', '8'], SCENES)).toThrow(/--base needs a value/);
    expect(() => parsePhoneArgs(['--device', 'phone-proxy'], SCENES)).toThrow(PhoneLaneError);
    expect(() => parsePhoneArgs(['--cpu-rate', '2'], SCENES)).toThrow(/perf:scenes --device phone-proxy/);
    expect(() => parsePhoneArgs(['--max-thermal', '9'], SCENES)).toThrow(/thermal/);
  });

  it('rounds reps up to even unless --head-only', () => {
    expect(phoneReps({ reps: 3, headOnly: false })).toBe(4);
    expect(phoneReps({ reps: 8, headOnly: false })).toBe(8);
    expect(phoneReps({ reps: 1, headOnly: true })).toBe(1);
  });
});

describe('perf:phone arms and order (shared with perf:scenes)', () => {
  it('base + head, noise arm only when asked or when it is an A/A run', () => {
    const ab = planArms({ headOnly: false, baseParams: 'shiplight=baked', headParams: 'shiplight=medium', noiseCheck: undefined }, 'abc', 'abc');
    expect(ab.arms.map((a) => a.name)).toEqual(['base', 'head']);
    expect(ab.noiseCheck).toBe(false);
    expect(ab.arms[1]!.clientParams).toEqual({ shiplight: 'medium' });
    const aa = planArms({ headOnly: false, baseParams: '', headParams: '', noiseCheck: undefined }, 'abc', 'abc');
    expect(aa.arms.map((a) => a.name)).toEqual(['base', 'head', 'aa']);
    const forced = planArms({ headOnly: false, baseParams: 'shiplight=baked', headParams: 'shiplight=low', noiseCheck: true }, 'abc', 'abc');
    expect(forced.arms.map((a) => a.name)).toEqual(['base', 'head', 'aa']);
    expect(forced.arms[2]!.clientParams).toEqual({ shiplight: 'baked' });
    expect(planArms({ headOnly: true, baseParams: '', headParams: '', noiseCheck: true }, null, 'abc').arms.map((a) => a.name)).toEqual(['head']);
  });

  it('every round is perf/order.ts armOrder, continuing across --append chunks', () => {
    const arms = ['base', 'head', 'aa'];
    const rounds = planRounds(arms, 8, 2);
    expect(rounds).toHaveLength(8);
    rounds.forEach((r, i) => expect(r).toEqual(armOrder(arms, i + 2)));
    const two = planRounds(['base', 'head'], 4);
    expect(two).toEqual([['base', 'head'], ['head', 'base'], ['base', 'head'], ['head', 'base']]);
  });

  it('warns when only one arm pins shiplight (the other would run the phone\'s saved level)', () => {
    expect(paramWarnings([{ name: 'base', clientParams: {} }, { name: 'head', clientParams: { shiplight: 'medium' } }])).toHaveLength(1);
    expect(paramWarnings([{ name: 'base', clientParams: { shiplight: 'baked' } }, { name: 'head', clientParams: { shiplight: 'medium' } }])).toEqual([]);
    expect(paramWarnings([{ name: 'base', clientParams: {} }, { name: 'head', clientParams: {} }])).toEqual([]);
  });
});

describe('perf:phone device check (adb mocked)', () => {
  const LIST = 'List of devices attached\n';

  it('fails fast with install advice when adb is not on PATH', () => {
    const enoent = Object.assign(new Error('spawnSync adb ENOENT'), { code: 'ENOENT' });
    expect(() => requirePhone(fakeAdb({}, enoent))).toThrow(/adb is not on PATH[\s\S]*phone-proxy/);
  });

  it('fails fast when no device is attached', () => {
    const adb = fakeAdb({ 'devices -l': `${LIST}\n` });
    expect(() => requirePhone(adb)).toThrow(/no Android device attached/);
    expect(adb.calls).toEqual([['devices', '-l']]);
  });

  it('says to accept the USB-debugging prompt when unauthorized', () => {
    expect(() => requirePhone(fakeAdb({ 'devices -l': `${LIST}R5CT unauthorized usb:1-1 transport_id:3\n` }))).toThrow(/Allow USB debugging/);
  });

  it('needs --serial with two phones, and honours it', () => {
    const out = `${LIST}AAA device usb:1 product:x model:Pixel_7 device:p transport_id:1\nBBB device usb:2 model:SM_A145R transport_id:2\n`;
    expect(() => requirePhone(fakeAdb({ 'devices -l': out }))).toThrow(/--serial/);
    expect(requirePhone(fakeAdb({ 'devices -l': out }), 'BBB')).toEqual({ serial: 'BBB', state: 'device', model: 'SM_A145R' });
    expect(() => requirePhone(fakeAdb({ 'devices -l': out }), 'CCC')).toThrow(/no adb device with serial CCC/);
  });

  it('parses adb devices -l, including the daemon banner and wireless serials', () => {
    const out = '* daemon not running; starting now at tcp:5037\n* daemon started successfully\nList of devices attached\n192.168.1.20:37000 device product:a model:Pixel_7 device:p transport_id:4\nemulator-5554 offline\n';
    expect(parseAdbDevices(out)).toEqual([
      { serial: '192.168.1.20:37000', state: 'device', model: 'Pixel_7' },
      { serial: 'emulator-5554', state: 'offline' },
    ]);
  });

  it('labels the device with model, Android version and GPU renderer', () => {
    const adb = fakeAdb({
      'devices -l': '',
      '-s S shell getprop ro.product.manufacturer': 'Google\n',
      '-s S shell getprop ro.product.model': 'Pixel 7\n',
      '-s S shell getprop ro.build.version.release': '14\n',
      '-s S shell getprop ro.build.version.sdk': '34\n',
      '-s S shell getprop ro.soc.model': 'GS201\n',
    });
    const p = phoneProps(adb, 'S');
    expect(p).toEqual({ manufacturer: 'Google', model: 'Pixel 7', android: '14', sdk: '34', soc: 'GS201' });
    expect(deviceLabel(p, 'Mali-G710')).toBe('Google Pixel 7 · Android 14 · Mali-G710');
    expect(deviceLabel({ ...p, manufacturer: 'samsung', model: 'SAMSUNG SM-A145R' }, 'Mali-G52')).toBe('SAMSUNG SM-A145R · Android 14 · Mali-G52');
  });

  it('gates a hot, dozing or locked phone', () => {
    expect(parseThermalStatus('IsStatusOverride: false\nThermal Status: 2\n')).toBe(2);
    expect(parseThermalStatus('garbage')).toBe(-1);
    expect(parseAwake('mWakefulness=Awake', 'mScreenOnFully=true mDreamingLockscreen=false')).toEqual({ awake: true, locked: false });
    expect(parseAwake('mWakefulness=Asleep', 'mDreamingLockscreen=true')).toEqual({ awake: false, locked: true });
    expect(judgePhone({ thermal: 1, awake: true, locked: false }, 2)).toEqual([]);
    expect(judgePhone({ thermal: -1, awake: true, locked: false }, 2)).toEqual([]);
    expect(judgePhone({ thermal: 2, awake: true, locked: false }, 2)[0]).toMatch(/MODERATE/);
    expect(judgePhone({ thermal: 0, awake: false, locked: true }, 2)).toHaveLength(2);
  });
});
