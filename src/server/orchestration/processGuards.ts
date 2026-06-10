/**
 * Process-level crash guards (plan squishy-canyon, finding R1).
 *
 * An authoritative game server has no `process.on('uncaughtException')` /
 * `('unhandledRejection')` handler — an unexpected throw on a timer callback or
 * an unawaited rejection would either crash with no drain or (worse) leave the
 * process limping in an unknown state. These guards log `fatal`, route into the
 * existing graceful drain via `onFatal`, and ensure a non-zero exit so the
 * supervisor restarts a clean instance. We do NOT log-and-continue — an
 * authority in an unknown state must not keep serving.
 */
import type { Logger } from 'pino';

/** Minimal process surface — injected so tests don't touch the real process. */
export interface ProcessLike {
  on(event: string, listener: (arg: unknown) => void): void;
  exit(code?: number): never;
}

export interface ProcessGuardsOpts {
  logger: Pick<Logger, 'fatal'>;
  /** Begin the graceful drain + non-zero exit. Called at most once. */
  onFatal: (err: unknown, source: 'uncaughtException' | 'unhandledRejection') => void;
  /** Injectable process emitter; defaults to the real `process`. */
  proc?: ProcessLike;
}

export function installProcessGuards(opts: ProcessGuardsOpts): void {
  const proc = opts.proc ?? (process as unknown as ProcessLike);
  let firing = false;

  const handle = (err: unknown, source: 'uncaughtException' | 'unhandledRejection'): void => {
    if (firing) {
      // A second fatal during the drain — don't loop the drain; exit now.
      opts.logger.fatal({ err, source }, 'double fault during fatal drain — exiting immediately');
      proc.exit(1);
      return;
    }
    firing = true;
    opts.logger.fatal({ err, source }, 'fatal: unrecoverable error — draining and restarting');
    opts.onFatal(err, source);
  };

  proc.on('uncaughtException', (err) => handle(err, 'uncaughtException'));
  proc.on('unhandledRejection', (reason) => handle(reason, 'unhandledRejection'));
}
