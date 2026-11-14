import { describe, it, expect } from 'vitest';
import type { RenderMirror, ShipRenderState } from '@core/contracts/IRenderer';
import { isOwnedByMe, isShipIAmFlying, shipOwner } from './shipOwnership.js';

const pose = (o: Partial<ShipRenderState> = {}): ShipRenderState => ({ x: 0, y: 0, vx: 0, vy: 0, angle: 0, ...o });

function mirror(localPlayerId: string | null): RenderMirror {
  return {
    localPlayerId,
    ships: new Map([['P', pose()], ['Q', pose({ ownerPlayerId: 'Q' })]]),
    lingeringShips: new Map([
      ['S-mine', { ...pose(), ownerPlayerId: 'P', isActive: false }],
      ['S-theirs', { ...pose(), ownerPlayerId: 'Q', isActive: false }],
    ]),
  } as unknown as RenderMirror;
}

describe('shipOwnership', () => {
  it('shipOwner: ownerPlayerId, else the key (active ships are keyed by pilot)', () => {
    expect(shipOwner('P', pose())).toBe('P');
    expect(shipOwner('S-1', pose({ ownerPlayerId: 'Q' }))).toBe('Q');
  });

  it('the ship I am flying is my own mirror.ships entry, nothing else', () => {
    const m = mirror('P');
    expect(isShipIAmFlying(m, 'P')).toBe(true);
    expect(isShipIAmFlying(m, 'Q')).toBe(false);
    expect(isShipIAmFlying(m, 'S-mine')).toBe(false);
    m.ships.delete('P');
    expect(isShipIAmFlying(m, 'P'), 'no entry ⇒ flying nothing').toBe(false);
    expect(isShipIAmFlying(mirror(null), 'P'), 'no local id').toBe(false);
  });

  it('owned by me covers my active ship and my parked hulls', () => {
    const m = mirror('P');
    expect(isOwnedByMe(m, 'P', m.ships.get('P')!)).toBe(true);
    expect(isOwnedByMe(m, 'S-mine', m.lingeringShips!.get('S-mine')!)).toBe(true);
    expect(isOwnedByMe(m, 'Q', m.ships.get('Q')!)).toBe(false);
    expect(isOwnedByMe(m, 'S-theirs', m.lingeringShips!.get('S-theirs')!)).toBe(false);
    const n = mirror(null);
    expect(isOwnedByMe(n, 'S-mine', n.lingeringShips!.get('S-mine')!), 'no local id').toBe(false);
  });
});
