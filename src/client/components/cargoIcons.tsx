/**
 * Cargo pods: one small flat icon per item in the loot window's tiles
 * (26 px, a 26-unit viewBox). Goods by id, then packed items and blueprints;
 * anything new falls back to a plain crate.
 */
import type { GoodId } from '../../shared-types/goods';

const GOOD_ICONS: Record<GoodId, JSX.Element> = {
  minerals: <><path d="M5 18l3-9 6-4 7 6-3 9z" fill="#8a7a6a" /><path d="M8 9l6 3 7-1" stroke="#b8a48c" fill="none" /></>,
  salvage: <><path d="M4 18l4-11 6 3 8-4-3 13z" fill="#9aa4b0" /><path d="M8 7l6 3-2 9" stroke="#5b636e" fill="none" /></>,
  alloy: <><path d="M3 17l6-8h14l-6 8z" fill="#4aa8ff" /><path d="M3 17h14v4H3z" fill="#2c6fb0" /></>,
  core: <><circle cx="13" cy="13" r="9" fill="#ffc83a" /><circle cx="13" cy="13" r="4" fill="#fff4c2" /></>,
  ice: <><path d="M13 3l8 5v10l-8 5-8-5V8z" fill="#bfe8ff" /><path d="M13 3v20M5 8l16 10M21 8L5 18" stroke="#7cc4ec" fill="none" /></>,
  gas: <><circle cx="10" cy="14" r="6" fill="#7fd6c2" opacity="0.8" /><circle cx="16" cy="11" r="6" fill="#a8f0e0" opacity="0.7" /></>,
  crystal: <><path d="M13 2l6 8-6 14-6-14z" fill="#c78bff" /><path d="M7 10h12M13 2v22" stroke="#e8ccff" fill="none" /></>,
  fuel: <><rect x="7" y="5" width="12" height="17" rx="3" fill="#e0703a" /><rect x="10" y="3" width="6" height="3" fill="#a04a22" /></>,
  polymer: <><rect x="5" y="6" width="16" height="4" rx="2" fill="#e6e0c8" /><rect x="5" y="12" width="16" height="4" rx="2" fill="#cfc8ac" /><rect x="5" y="18" width="16" height="4" rx="2" fill="#b4ad90" /></>,
  silicon: <><rect x="5" y="5" width="16" height="16" rx="1" fill="#4c5a78" /><path d="M5 11h16M5 15h16M11 5v16M15 5v16" stroke="#8fa4cc" /></>,
  provisions: <><rect x="5" y="9" width="16" height="11" rx="2" fill="#b58b4c" /><path d="M5 12h16" stroke="#7a5a2c" /></>,
  components: <><circle cx="13" cy="13" r="8" fill="#7d8796" /><circle cx="13" cy="13" r="3" fill="#2a3040" /><path d="M13 3v4M13 19v4M3 13h4M19 13h4" stroke="#7d8796" strokeWidth="3" /></>,
  electronics: <><rect x="6" y="6" width="14" height="14" rx="2" fill="#2e8a6a" /><rect x="10" y="10" width="6" height="6" fill="#bdf5dc" /></>,
  munitions: <><rect x="5" y="7" width="4" height="14" rx="2" fill="#d9a35b" /><rect x="11" y="7" width="4" height="14" rx="2" fill="#d9a35b" /><rect x="17" y="7" width="4" height="14" rx="2" fill="#d9a35b" /></>,
  machinery: <><path d="M4 20V10l6-4v6l6-4v6l6-4v10z" fill="#9b8f7e" /><rect x="4" y="18" width="18" height="3" fill="#6a6152" /></>,
  consumer_goods: <><rect x="4" y="8" width="18" height="13" rx="2" fill="#e58fb0" /><path d="M9 8a4 4 0 0 1 8 0" stroke="#e58fb0" strokeWidth="2" fill="none" /></>,
};

const BLUEPRINT = <><rect x="4" y="5" width="18" height="16" rx="2" fill="#1f4f8c" /><path d="M7 10h12M7 14h8M7 18h10" stroke="#9fd0ff" /></>;
const CRATE = <><rect x="4" y="6" width="18" height="15" rx="2" fill="#8c6a3c" /><path d="M4 11h18M13 6v15" stroke="#5e4524" /></>;

/** The icon for a cargo row key (`g:<good>`, `p:<product>`, `b:<uid>`). */
export function CargoIcon({ rowKey }: { rowKey: string }): JSX.Element {
  const body = rowKey.startsWith('b:') ? BLUEPRINT
    : rowKey.startsWith('g:') ? (GOOD_ICONS[rowKey.slice(2) as GoodId] ?? CRATE)
      : CRATE;
  return <svg viewBox="0 0 26 26" width="100%" height="100%" aria-hidden>{body}</svg>;
}
