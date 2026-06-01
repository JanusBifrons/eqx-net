/**
 * LAN IPv4 picker for the phone-driven test harness.
 *
 * The phone (USB-tethered, on the same Wi-Fi as the host) reaches the
 * dev server via `http://<LAN-IP>:5173`. Vite already binds 0.0.0.0
 * (see vite.config.ts), so any non-internal IPv4 on the host's NICs
 * will route traffic to the dev server — but the host typically has
 * multiple candidate IPs (Wi-Fi, Ethernet, Docker bridges, VPN), so we
 * need to pick the right one.
 *
 * Heuristic:
 *   1. `HOST_LAN_IP` env var wins outright (escape hatch).
 *   2. Prefer `192.168.*` — typical home/router NAT range.
 *   3. Fall back to `10.*` — corporate / some routers.
 *   4. Reject `172.16-31.*` — Docker / WSL bridges share this range
 *      and the phone has no route to them.
 *   5. Otherwise fail loudly with all candidates listed so the user
 *      can pick + set the env var.
 *
 * The picked IP is intended to be logged at the top of each phone
 * spec — a silently-wrong IP is the single likeliest first-run
 * footgun, so loudness here saves a debug cycle.
 */
import { networkInterfaces } from 'node:os';

interface Candidate {
  iface: string;
  address: string;
}

function listCandidates(): Candidate[] {
  const out: Candidate[] = [];
  for (const [iface, infos] of Object.entries(networkInterfaces())) {
    if (!infos) continue;
    for (const info of infos) {
      if (info.internal) continue;
      if (info.family !== 'IPv4') continue;
      out.push({ iface, address: info.address });
    }
  }
  return out;
}

export function pickLanIp(): string {
  const override = process.env['HOST_LAN_IP'];
  if (override) return override;

  const candidates = listCandidates();
  const v192 = candidates.find((c) => c.address.startsWith('192.168.'));
  if (v192) return v192.address;
  const v10 = candidates.find((c) => c.address.startsWith('10.'));
  if (v10) return v10.address;
  const other = candidates.find(
    (c) => !c.address.startsWith('172.') && !c.address.startsWith('169.254.'),
  );
  if (other) return other.address;

  throw new Error(
    `[phone-poc] could not auto-detect a LAN IPv4 on this host. ` +
      `Candidates: ${JSON.stringify(candidates)}. ` +
      `Set HOST_LAN_IP=<ip> in the environment to override.`,
  );
}

/**
 * Diagnostic: returns all non-internal IPv4 candidates with iface names.
 * Spec uses this at startup to log every candidate so a wrong pick is
 * obvious. NOT used to make the routing decision.
 */
export function listLanCandidates(): readonly Candidate[] {
  return listCandidates();
}
