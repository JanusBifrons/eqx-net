/**
 * v4 T4 — teleporter prompts (top centre, EqxPrompt):
 *  - a TOLL the local rider was offered as a pad armed (gold): Pay / Don't pay /
 *    Always / Never. Always and Never are remembered for that owner's faction.
 *    A rider who doesn't pay still rides; the owner sees to the consequence.
 *  - REQUESTS from other owners to pair with one of your teleporters (cyan):
 *    Accept / Decline.
 * Both come from discrete server messages (they are offers, not state) and
 * go away once answered. Names only, never ids.
 */
import { memo, useMemo } from 'react';
import { EqxPrompt, EqxPromptStack } from '../../ui/index.js';
import { useUIStore } from '../state/store';
import { sendTeleportPairAnswer, sendTollAnswer } from '../structures/structureActionsClient';
import type { TollAnswer } from '../../shared-types/teleport';

/** A toll prompt stays up this long without an answer (the cycle's arming). */
const TOLL_PROMPT_MS = 15_000;

/** Bumped per new toll offer: the prompt's React key, so its timer restarts. */
let tollSeq = 0;

export const TeleportPrompts = memo(function TeleportPrompts(): JSX.Element | null {
  const toll = useUIStore((s) => s.tollPrompt);
  const requests = useUIStore((s) => s.pairRequests);
  const tollKey = useMemo(() => (toll ? ++tollSeq : 0), [toll]);

  if (!toll && requests.length === 0) return null;
  const answer = (a: TollAnswer): void => {
    if (!toll) return;
    sendTollAnswer(toll.padId, a);
    useUIStore.getState().setTollPrompt(null);
  };
  const expire = (): void => {
    if (useUIStore.getState().tollPrompt === toll) useUIStore.getState().setTollPrompt(null);
  };
  const answerPair = (requestId: string, accept: boolean): void => {
    sendTeleportPairAnswer(requestId, accept);
    useUIStore.getState().removePairRequest(requestId);
  };
  return (
    <EqxPromptStack>
      {toll && (
        <EqxPrompt
          key={tollKey}
          tone="gold"
          message={`${toll.ownerName} charges ${toll.credits}¢ to ride this teleporter.`}
          timeoutMs={TOLL_PROMPT_MS}
          onTimeout={expire}
          data-testid="toll-prompt"
          dataAttrs={{ credits: toll.credits }}
          actions={[
            { label: 'Pay', tone: 'primary', onPick: () => answer('pay'), 'data-testid': 'toll-pay' },
            { label: "Don't pay", onPick: () => answer('decline'), 'data-testid': 'toll-decline' },
            { label: 'Always pay', onPick: () => answer('always'), 'data-testid': 'toll-always' },
            { label: 'Never pay', onPick: () => answer('never'), 'data-testid': 'toll-never' },
          ]}
        />
      )}
      {requests.map((r) => (
        <EqxPrompt
          key={r.requestId}
          tone="info"
          message={`${r.fromName} asks to pair ${r.label}.`}
          data-testid="pair-request"
          actions={[
            { label: 'Accept', tone: 'primary', onPick: () => answerPair(r.requestId, true), 'data-testid': 'pair-request-accept' },
            { label: 'Decline', onPick: () => answerPair(r.requestId, false), 'data-testid': 'pair-request-decline' },
          ]}
        />
      ))}
    </EqxPromptStack>
  );
});
