import type { Client } from 'colyseus';
import type { Logger } from 'pino';

type BackpressureResult = 'ok' | 'drop' | 'close';

const DROP_THRESHOLD = 50_000;
const CLOSE_THRESHOLD = 250_000;

export function checkBackpressure(client: Client, logger: Logger): BackpressureResult {
  // WebSocket bufferedAmount: bytes queued but not yet sent to the network layer.
  // Cast through unknown since Colyseus types do not expose the raw socket directly.
  const ws = (client as unknown as { socket: { bufferedAmount?: number } }).socket;
  const amt = ws?.bufferedAmount ?? 0;
  if (amt > CLOSE_THRESHOLD) {
    logger.warn({ sessionId: client.sessionId, bufferedAmount: amt }, 'backpressure: force-closing slow client');
    return 'close';
  }
  if (amt > DROP_THRESHOLD) {
    return 'drop';
  }
  return 'ok';
}
