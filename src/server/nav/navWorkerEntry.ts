/**
 * The nav worker's entry (navigation plan, slice 4b): one per process, every
 * sector's nav maps in one `NavHost`. Bundled and started by `NavWorker`.
 */
import { parentPort } from 'node:worker_threads';
import { NavHost, type NavCommand } from '../../core/nav/navHost.js';

// eslint-disable-next-line no-restricted-properties -- real time: print-only build timings, not game time
const host = new NavHost(() => performance.now());
parentPort!.on('message', (cmd: NavCommand) => {
  const reply = host.handle(cmd);
  if (reply?.type === 'ROUTE') parentPort!.postMessage(reply, [reply.points.buffer as ArrayBuffer]);
  else if (reply) parentPort!.postMessage(reply);
});
parentPort!.postMessage({ type: 'NAV_READY' });
