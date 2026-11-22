/**
 * The Trade panel's Gift page (UI language U2-6b): send goods or credits to a
 * side for standing. Catalogue only: a note row, the side on an EqxSegmented,
 * what to give on an EqxDropdown, the amount on an EqxTextField and Send.
 *
 * Sends the same `send_gift` message as before (`sendGift`). With no base to
 * trade from, Send is hidden and a row says why (plan A4: actions that can't
 * work are hidden, never shown and refused).
 */
import { useState } from 'react';
import { EqxButton, EqxDropdown, EqxListRow, EqxSection, EqxSegmented, EqxTextField } from '../../ui/index.js';
import { sendGift } from '../net/tradeClient';
import { goodName } from '../net/tradeView';
import { ECON_ALLEGIANCES, type EconAllegiance } from '../../shared-types/economy';
import { GOOD_IDS, type GoodId } from '../../shared-types/goods';

const CREDITS = 'credits';

const SIDE_OPTIONS = ECON_ALLEGIANCES.map((a) => ({ id: a, label: a.charAt(0).toUpperCase() + a.slice(1) }));
const GIFT_OPTIONS = [{ id: CREDITS, label: 'Credits' }, ...GOOD_IDS.map((g) => ({ id: g, label: goodName(g) }))];

/** The amount typed, as a whole number ≥ 1, or null if it isn't one. */
export function giftAmount(text: string): number | null {
  const n = Math.floor(Number(text));
  return Number.isFinite(n) && n >= 1 ? n : null;
}

export function TradeGiftPage({ baseId }: { baseId: number | null }): JSX.Element {
  const [to, setTo] = useState<EconAllegiance>('traders');
  const [good, setGood] = useState<GoodId | typeof CREDITS>(CREDITS);
  const [amount, setAmount] = useState('100');
  const n = giftAmount(amount);
  const send = (): void => {
    if (baseId === null || n === null) return;
    sendGift({
      allegiance: to,
      networkEntityId: baseId,
      good: good === CREDITS ? null : good,
      qty: good === CREDITS ? 0 : n,
      credits: good === CREDITS ? n : 0,
    });
  };
  return (
    <EqxSection title="Send a gift" data-testid="trade-gift">
      <EqxListRow primary="A hauler collects it from your base"
        secondary="Standing gained shrinks if you give a lot at once." />
      <EqxSegmented label="Give to" options={SIDE_OPTIONS} value={to}
        onChange={(id) => setTo(id as EconAllegiance)} data-testid="trade-gift-to" />
      <EqxDropdown label="Gift" options={GIFT_OPTIONS} value={good}
        onChange={(id) => setGood((id ?? CREDITS) as GoodId | typeof CREDITS)} data-testid="trade-gift-good" />
      <EqxTextField label="Amount" value={amount} onChange={setAmount}
        error={n === null ? 'A whole number, 1 or more' : undefined} data-testid="trade-gift-amount" />
      {baseId === null ? (
        <EqxListRow primary="No base to send from" secondary="Build a Capital or Cargo Bay in this sector."
          data-testid="trade-gift-no-base" />
      ) : (
        <EqxButton tone="primary" disabled={n === null} onClick={send} data-testid="trade-gift-send">
          Send gift
        </EqxButton>
      )}
    </EqxSection>
  );
}
