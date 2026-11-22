/**
 * Economy v2 W6 — the Trade panel's Blueprints page: traders' blueprints for
 * sale (Buy) and the blueprints in the selected base (Sell). Rebuilt ONLY from
 * the server's `bp_market_state` replies (#16): it asks on mount, every few
 * seconds while on screen, and after each action. Names only, never ids.
 *
 * UI language U2-6b: catalogue sections and rows; each listing is an
 * `EqxListRow` with its Buy / Sell button at the right. A listing with no
 * price has no button (plan A4: actions that can't work are hidden).
 */
import { memo, useEffect } from 'react';
import { EqxButton, EqxIcon, EqxListRow, EqxSection } from '../../../../ui/index.js';
import { useUIStore } from '../../../state/store';
import { sendBpBuy, sendBpMarketQuery, sendBpSell } from '../../../net/tradeClient';
import type { BpListing } from '../../../../shared-types/blueprintMarket';

export const BP_MARKET_POLL_MS = 3000;

function stars(quality: number): string {
  const n = Math.max(0, Math.min(5, Math.round(quality / 20)));
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

/** "Original" or "Copy · 4 runs", then the stats. */
export function listingLine(b: BpListing): string {
  const kind = b.kind === 'bpo' ? 'Original' : `Copy · ${b.runs ?? 0} run${b.runs === 1 ? '' : 's'}`;
  return `${kind} · −${b.material}% mats · Q${b.output}`;
}

function Row({ b, action, testid, onClick }: { b: BpListing; action: string; testid: string; onClick: () => void }): JSX.Element {
  const button = b.price > 0
    ? <EqxButton onClick={onClick} data-testid={`${testid}-action`}>{action} {b.price.toLocaleString('en-US')}¢</EqxButton>
    : undefined;
  return <EqxListRow primary={`${b.name} ${stars(b.quality)}`} secondary={listingLine(b)} side={button} data-testid={testid} />;
}

export const BlueprintMarketSection = memo(function BlueprintMarketSection({ baseId }: { baseId: number | null }): JSX.Element {
  const state = useUIStore((s) => (s.bpMarket !== null && s.bpMarket.networkEntityId === baseId ? s.bpMarket : null));

  useEffect(() => {
    if (baseId === null) return;
    sendBpMarketQuery(baseId);
    const t = setInterval(() => sendBpMarketQuery(baseId), BP_MARKET_POLL_MS);
    return () => clearInterval(t);
  }, [baseId]);

  if (baseId === null) {
    return (
      <EqxListRow primary="No base to trade from" secondary="Build a Capital or Cargo Bay here to trade blueprints."
        data-testid="bp-market-no-base" />
    );
  }
  if (state === null) return <EqxListRow primary="Loading…" data-testid="bp-market-loading" />;
  return (
    <div data-testid="bp-market">
      {state.message !== undefined && (
        <EqxListRow primary={state.ok ? 'Done' : 'Not done'} secondary={state.message} icon={<EqxIcon name={state.ok ? 'confirm' : 'cancel'} />}
          data-testid="bp-market-message" />
      )}
      <EqxSection title="Traders sell" data-testid="bp-market-offers">
        {state.offers.length === 0 && <EqxListRow primary="Nothing for sale right now." />}
        {state.offers.map((b) => (
          <Row key={b.id} b={b} action="Buy" testid="bp-offer" onClick={() => sendBpBuy(baseId, b.id)} />
        ))}
      </EqxSection>
      <EqxSection title="Your blueprints here" data-testid="bp-market-mine">
        {state.mine.length === 0 && <EqxListRow primary="None in this base." />}
        {state.mine.map((b) => (
          <Row key={b.id} b={b} action="Sell" testid="bp-mine" onClick={() => sendBpSell(baseId, b.id)} />
        ))}
      </EqxSection>
    </div>
  );
});
