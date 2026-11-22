import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { EqxIcon } from '../EqxIcon/EqxIcon.js';
import { EqxStripIdentity, HEALTH_RING, type EqxStripHealth } from './EqxStripIdentity.js';
import { HUD } from '../../client/hud/tokens.js';

/** The computed form jsdom gives a colour, so hex tokens compare to computed styles. */
function computedColor(c: string): string {
  const probe = document.createElement('div');
  probe.style.borderColor = c;
  document.body.appendChild(probe);
  const v = getComputedStyle(probe).borderTopColor;
  probe.remove();
  return v;
}

function computedBg(c: string): string {
  const probe = document.createElement('div');
  probe.style.backgroundColor = c;
  document.body.appendChild(probe);
  const v = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return v;
}

describe('EqxStripIdentity', () => {
  it('is a round icon-only button whose aria-label is the tooltip', () => {
    render(<EqxStripIdentity icon={<EqxIcon name="fleet" />} tooltip="Fighter" health="ok" data-testid="id" />);
    const b = screen.getByRole('button', { name: 'Fighter' });
    expect(b).toBe(screen.getByTestId('id'));
    expect(b.textContent).toBe('');
    expect(getComputedStyle(b).borderRadius).toBe('50%');
  });

  it('has the same outer box as a strip tile, icon centred', () => {
    render(<EqxStripIdentity icon={<EqxIcon name="fleet" />} tooltip="Fighter" health="ok" data-testid="id" />);
    const cs = getComputedStyle(screen.getByTestId('id'));
    const px = `${HUD.strip.tile}px`;
    expect({ w: cs.width, h: cs.height }).toEqual({ w: px, h: px });
    expect(cs.alignItems).toBe('center');
    expect(cs.justifyContent).toBe('center');
  });

  it('health switches the ring colour to the hull token', () => {
    expect(HEALTH_RING).toEqual({ ok: HUD.color.hullOk, warn: HUD.color.hullWarn, crit: HUD.color.hullCrit });
    const { rerender } = render(<EqxStripIdentity icon={<EqxIcon name="fleet" />} tooltip="f" health="ok" data-testid="id" />);
    const seen = new Set<string>();
    for (const h of ['ok', 'warn', 'crit'] as EqxStripHealth[]) {
      rerender(<EqxStripIdentity icon={<EqxIcon name="fleet" />} tooltip="f" health={h} data-testid="id" />);
      const el = screen.getByTestId('id');
      expect(el.dataset['health']).toBe(h);
      const ring = getComputedStyle(el).borderTopColor;
      expect(ring).toBe(computedColor(HEALTH_RING[h]));
      expect(getComputedStyle(el).boxShadow).toContain('inset');
      seen.add(ring);
    }
    expect(seen.size).toBe(3);
  });

  it('gold icon by default; iconColor tints it (the ring stays the hull); data-state passes through', () => {
    const { rerender } = render(<EqxStripIdentity icon={<EqxIcon name="ship" />} tooltip="f" health="ok" data-testid="id" />);
    const el = (): HTMLElement => screen.getByTestId('id');
    expect(getComputedStyle(el()).color).toBe(computedColor(HUD.color.credits));
    expect(el().dataset['state']).toBeUndefined();
    rerender(<EqxStripIdentity icon={<EqxIcon name="ship" />} tooltip="f" health="ok" iconColor="#ff6b6b" data-state="hostile" data-testid="id" />);
    expect(getComputedStyle(el()).color).toBe(computedColor('#ff6b6b'));
    expect(getComputedStyle(el()).borderTopColor).toBe(computedColor(HUD.color.hullOk));
    expect(el().dataset['state']).toBe('hostile');
  });

  it('count > 1 shows a badge; 1 or none shows none', () => {
    const { rerender, container } = render(<EqxStripIdentity icon={<EqxIcon name="fleet" />} tooltip="f" health="ok" />);
    const badge = () => container.querySelector('.MuiBadge-badge');
    expect(badge()?.className).toContain('MuiBadge-invisible');
    rerender(<EqxStripIdentity icon={<EqxIcon name="fleet" />} tooltip="f" health="ok" count={4} />);
    expect(badge()?.className).not.toContain('MuiBadge-invisible');
    expect(badge()?.textContent).toBe('4');
    expect(getComputedStyle(badge() as HTMLElement).backgroundColor).toBe(computedBg(HUD.color.credits));
    rerender(<EqxStripIdentity icon={<EqxIcon name="fleet" />} tooltip="f" health="ok" count={1} />);
    expect(badge()?.className).toContain('MuiBadge-invisible');
  });

  it('calls onClick and shows the tooltip on hover', async () => {
    const onClick = vi.fn();
    render(<EqxStripIdentity icon={<EqxIcon name="fleet" />} tooltip="Fighter" health="warn" onClick={onClick} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
    fireEvent.mouseOver(screen.getByRole('button'));
    expect((await screen.findByRole('tooltip')).textContent).toBe('Fighter');
  });
});
