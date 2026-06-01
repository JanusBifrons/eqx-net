/**
 * Kernel-level device diagnostics via ADB shell. The browser-side
 * `effectiveHz` (RafStallDetector) measures the consequence of
 * throttling; this measures the CAUSE.
 *
 * Sources:
 *   - `dumpsys thermalservice` → Thermal Status (0=NONE, 1=LIGHT,
 *     2=MODERATE, 3=SEVERE, 4=CRITICAL, 5=EMERGENCY, 6=SHUTDOWN)
 *     + cached temperatures per zone (BIG/MID/LITTLE clusters, GPU,
 *     TPU, skin, battery).
 *   - `dumpsys cpuinfo` → per-process CPU%, total load.
 *   - `dumpsys gfxinfo com.android.chrome framestats` → recent frame
 *     timing from the Android compositor (more accurate than RAF on
 *     the JS side).
 *
 * Returns a snapshot the spec can print at start and end of the drive
 * — a Δ across the window directly evidences whether the phone heated
 * up DURING the test (which would matter to the measurement).
 */
import { execFileSync } from 'node:child_process';

export interface DeviceTempSample {
  name: string;
  celsius: number;
  /** Android thermal HAL status flag: 0=NONE … 6=SHUTDOWN. */
  status: number;
}

export interface DeviceState {
  thermalStatusOverall: number;
  thermalStatusName: string;
  temps: DeviceTempSample[];
  topTemps: Record<string, number>;
  chromeCpuPct?: number;
  totalCpuPct?: number;
  capturedAtMs: number;
}

const STATUS_NAMES = ['NONE', 'LIGHT', 'MODERATE', 'SEVERE', 'CRITICAL', 'EMERGENCY', 'SHUTDOWN'];

function adb(args: string[]): string {
  try {
    return execFileSync('adb', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return '';
  }
}

function parseThermalservice(out: string): { status: number; temps: DeviceTempSample[] } {
  const statusMatch = out.match(/Thermal Status:\s*(\d+)/);
  const status = statusMatch ? Number(statusMatch[1]) : -1;
  const temps: DeviceTempSample[] = [];
  const re = /Temperature\{mValue=([\d.]+),\s*mType=(-?\d+),\s*mName=([^,]+),\s*mStatus=(\d+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out)) !== null) {
    temps.push({
      name: m[3].trim(),
      celsius: Number(m[1]),
      status: Number(m[4]),
    });
  }
  return { status, temps };
}

function parseChromeCpuPct(cpuInfoOut: string): number | undefined {
  // dumpsys cpuinfo line format: "  XX% NNNN/com.android.chrome:role:..."
  const match = cpuInfoOut.match(/^\s*([\d.]+)%[^\n]*com\.android\.chrome/m);
  return match ? Number(match[1]) : undefined;
}

function parseTotalCpuPct(cpuInfoOut: string): number | undefined {
  // dumpsys cpuinfo "Load: x.xx / y.yy / z.zz" + "CPU usage from X ms to Y ms"
  // Look for the percentage in the "user + kernel" summary line.
  const match = cpuInfoOut.match(/(\d+)% TOTAL/);
  return match ? Number(match[1]) : undefined;
}

export function captureDeviceState(): DeviceState {
  const thermalRaw = adb(['shell', 'dumpsys', 'thermalservice']);
  const cpuRaw = adb(['shell', 'dumpsys', 'cpuinfo']);
  const { status, temps } = parseThermalservice(thermalRaw);
  const interesting = ['BIG', 'MID', 'LITTLE', 'G3D', 'TPU', 'battery', 'VIRTUAL-SKIN', 'quiet_therm'];
  const topTemps: Record<string, number> = {};
  for (const t of temps) {
    if (interesting.includes(t.name)) topTemps[t.name] = Math.round(t.celsius * 10) / 10;
  }
  return {
    thermalStatusOverall: status,
    thermalStatusName: STATUS_NAMES[status] ?? `UNKNOWN_${status}`,
    temps,
    topTemps,
    chromeCpuPct: parseChromeCpuPct(cpuRaw),
    totalCpuPct: parseTotalCpuPct(cpuRaw),
    capturedAtMs: Date.now(),
  };
}

export function formatDeviceState(label: string, s: DeviceState): string {
  const tempStr = Object.entries(s.topTemps)
    .map(([k, v]) => `${k}=${v.toFixed(1)}°C`)
    .join(' ');
  const cpuStr = s.totalCpuPct !== undefined ? `cpuTotal=${s.totalCpuPct}%` : '';
  const chromeStr = s.chromeCpuPct !== undefined ? `cpuChrome=${s.chromeCpuPct.toFixed(1)}%` : '';
  return `[${label}] thermalStatus=${s.thermalStatusOverall} (${s.thermalStatusName}) ${tempStr} ${cpuStr} ${chromeStr}`.trim();
}

export function diffDeviceState(before: DeviceState, after: DeviceState): string {
  const dts: string[] = [];
  for (const k of Object.keys(before.topTemps)) {
    const b = before.topTemps[k];
    const a = after.topTemps[k];
    if (a !== undefined && b !== undefined) {
      const delta = a - b;
      const sign = delta >= 0 ? '+' : '';
      dts.push(`${k}=${sign}${delta.toFixed(1)}°C`);
    }
  }
  const statusDelta = after.thermalStatusOverall - before.thermalStatusOverall;
  const statusStr = statusDelta === 0 ? '' : ` thermalStatus ${before.thermalStatusOverall}→${after.thermalStatusOverall}`;
  return `[Δ ${((after.capturedAtMs - before.capturedAtMs) / 1000).toFixed(1)}s] ${dts.join(' ')}${statusStr}`;
}
