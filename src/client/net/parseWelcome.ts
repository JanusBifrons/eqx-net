/**
 * Campaign 6.1 (anti-patterns review C-core 3 / Part D #18) — defensive
 * ingest guard for the server→client `welcome` message.
 *
 * Invariant #3 (network validation) requires every inbound message to parse
 * through a zod schema before it reaches game logic. `welcome` was the last
 * load-bearing handler consuming a RAW CAST (`(msg: WelcomeMessage) =>`),
 * which meant a malformed payload (protocol skew, a compromised proxy, a
 * future server refactor slip) flowed straight into prediction anchoring
 * (`inputTick`, clock anchor) and the Zustand phase machine.
 *
 * The guard is a pure function (schema in, message-or-null out) so the drop
 * behaviour is unit-testable without a live room — the ColyseusClient
 * handler body stays untestable-by-design (it closure-captures the room),
 * but the trust boundary itself now has a lock.
 */
import { WelcomeSchema, type WelcomeMessage } from '@shared-types/messages';
import { logEvent } from '../debug/ClientLogger';

/** Parse an inbound `welcome` payload. Malformed ⇒ log + null (the caller
 *  drops the message — invariant #3's parse-and-drop contract). */
export function parseWelcome(raw: unknown): WelcomeMessage | null {
  const parsed = WelcomeSchema.safeParse(raw);
  if (!parsed.success) {
    logEvent('welcome_malformed_dropped', {
      issues: parsed.error.issues.length,
      firstIssue: parsed.error.issues[0]?.message ?? 'unknown',
    });
    return null;
  }
  return parsed.data;
}
