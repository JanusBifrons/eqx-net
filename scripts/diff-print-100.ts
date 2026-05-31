/**
 * Adhoc top-100 diff print for combat-fx-hunt. Wraps `heap-snapshot-diff`
 * to dump entries deeper than the spec's top-20 default — needed because
 * the actual leak suspects (Pixi Graphics / Text / sprites) may not be
 * in the top-20 if they're outnumbered by JIT-compiled instruction streams.
 */
import { readFileSync } from 'node:fs';
import { diffSnapshots, type SnapshotJson } from './heap-snapshot-diff.js';

const snap1: SnapshotJson = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const snap2: SnapshotJson = JSON.parse(readFileSync(process.argv[3]!, 'utf8'));
const diff = diffSnapshots(snap1, snap2);
const growing = diff.filter((d) => d.sizeDeltaBytes > 0).sort((a, b) => b.sizeDeltaBytes - a.sizeDeltaBytes);
// eslint-disable-next-line no-console
console.log(`Total growing groups: ${growing.length}`);
for (const d of growing.slice(0, 100)) {
  const sizeKb = (d.sizeDeltaBytes / 1024).toFixed(2);
  // eslint-disable-next-line no-console
  console.log(`  +${sizeKb.padStart(10)} KB  +${String(d.countDelta).padStart(6)}  ${d.type.padEnd(10)}  ${d.name}`);
}
