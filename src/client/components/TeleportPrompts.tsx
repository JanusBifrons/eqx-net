/**
 * v4 T4 — teleporter prompts (top centre):
 *  - a TOLL the local rider was offered as a pad armed: Pay / Don't pay /
 *    Always / Never. Always and Never are remembered for that owner's faction.
 *    A rider who doesn't pay still rides; the owner sees to the consequence.
 *  - REQUESTS from other owners to pair with one of your teleporters: Accept /
 *    Decline.
 * Both come from discrete server messages (they are offers, not state) and
 * go away once answered. Names only, never ids.
 */
import { memo, useEffect } from 'react';
import { Box } from '@mui/material';
import { useUIStore } from '../state/store';
import { sendTeleportPairAnswer, sendTollAnswer } from '../structures/structureActionsClient';
import type { TollAnswer } from '../../shared-types/teleport';

/** A toll prompt stays up this long without an answer (the cycle's arming). */
const TOLL_PROMPT_MS = 15_000;

const CARD_SX = {
  px: 1, py: 0.5, borderRadius: '4px', fontSize: 11, color: '#efeaff', textAlign: 'center' as const,
  backgroundColor: 'rgba(40,25,90,0.92)', border: '1px solid #b9a6ff', pointerEvents: 'auto' as const, maxWidth: 300,
};
const ROW_SX = { display: 'flex', gap: '4px', justifyContent: 'center', mt: '4px', flexWrap: 'wrap' as const };
const BTN_SX = {
  px: 0.75, py: '2px', borderRadius: '3px', cursor: 'pointer', userSelect: 'none' as const, fontSize: 10,
  border: '1px solid rgba(185,166,255,0.8)', backgroundColor: 'rgba(60,40,120,0.7)',
};

export const TeleportPrompts = memo(function TeleportPrompts(): JSX.Element | null {
  const toll = useUIStore((s) => s.tollPrompt);
  const requests = useUIStore((s) => s.pairRequests);

  useEffect(() => {
    if (!toll) return undefined;
    const t = setTimeout(() => {
      if (useUIStore.getState().tollPrompt === toll) useUIStore.getState().setTollPrompt(null);
    }, TOLL_PROMPT_MS);
    return () => clearTimeout(t);
  }, [toll]);

  if (!toll && requests.length === 0) return null;
  const answer = (a: TollAnswer): void => {
    if (!toll) return;
    sendTollAnswer(toll.padId, a);
    useUIStore.getState().setTollPrompt(null);
  };
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'center' }}>
      {toll && (
        <Box sx={CARD_SX} data-testid="toll-prompt" data-credits={toll.credits}>
          {`${toll.ownerName} charges ${toll.credits}¢ to ride this teleporter.`}
          <Box sx={ROW_SX}>
            <Box component="span" sx={BTN_SX} data-testid="toll-pay" onClick={() => answer('pay')}>Pay</Box>
            <Box component="span" sx={BTN_SX} data-testid="toll-decline" onClick={() => answer('decline')}>Don&apos;t pay</Box>
            <Box component="span" sx={BTN_SX} data-testid="toll-always" onClick={() => answer('always')}>Always pay</Box>
            <Box component="span" sx={BTN_SX} data-testid="toll-never" onClick={() => answer('never')}>Never pay</Box>
          </Box>
        </Box>
      )}
      {requests.map((r) => (
        <Box key={r.requestId} sx={CARD_SX} data-testid="pair-request">
          {`${r.fromName} asks to pair ${r.label}.`}
          <Box sx={ROW_SX}>
            <Box component="span" sx={BTN_SX} data-testid="pair-request-accept" onClick={() => { sendTeleportPairAnswer(r.requestId, true); useUIStore.getState().removePairRequest(r.requestId); }}>Accept</Box>
            <Box component="span" sx={BTN_SX} data-testid="pair-request-decline" onClick={() => { sendTeleportPairAnswer(r.requestId, false); useUIStore.getState().removePairRequest(r.requestId); }}>Decline</Box>
          </Box>
        </Box>
      ))}
    </Box>
  );
});
