import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import CheckIcon from '@mui/icons-material/Check';
import { EqxIconButton } from './EqxIconButton.js';
import { HUD } from '../../client/hud/tokens.js';

/** The computed form jsdom gives a colour, so tokens compare to computed styles. */
function computed(prop: 'color' | 'backgroundColor' | 'borderColor', c: string): string {
  const probe = document.createElement('div');
  probe.style[prop] = c;
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const v = prop === 'borderColor' ? cs.borderTopColor : cs[prop];
  probe.remove();
  return v;
}

function tile(el: JSX.Element): CSSStyleDeclaration {
  render(el);
  return getComputedStyle(screen.getByTestId('t'));
}

describe('EqxIconButton variant="strip" (mock .ib)', () => {
  it('is a rounded-square tile of HUD.strip.tile, cell well, edge border', () => {
    const cs = tile(<EqxIconButton variant="strip" icon={<CheckIcon />} tooltip="Rotate" data-testid="t" />);
    const px = `${HUD.strip.tile}px`;
    expect({ w: cs.width, h: cs.height }).toEqual({ w: px, h: px });
    expect(cs.borderRadius).toBe(`${HUD.strip.tileRadius}px`);
    expect(cs.backgroundColor).toBe(computed('backgroundColor', HUD.strip.cell));
    expect(cs.borderTopColor).toBe(computed('borderColor', HUD.strip.edge));
    expect(cs.color).toBe(computed('color', HUD.color.ink));
  });

  it('primary = ok: filled green, dark icon', () => {
    const cs = tile(<EqxIconButton variant="strip" tone="primary" icon={<CheckIcon />} tooltip="Place" data-testid="t" />);
    expect(cs.backgroundColor).toBe(computed('backgroundColor', HUD.color.hullOk));
    expect(cs.color).toBe(computed('color', HUD.strip.okInk));
  });

  it('danger = no: red icon and red-ish edge on the dark well (outline, not a red fill)', () => {
    const cs = tile(<EqxIconButton variant="strip" tone="danger" icon={<CheckIcon />} tooltip="Stop" data-testid="t" />);
    expect(cs.color).toBe(computed('color', HUD.color.danger));
    expect(cs.borderTopColor).toBe(computed('borderColor', HUD.strip.noEdge));
    expect(cs.backgroundColor).toBe(computed('backgroundColor', HUD.strip.cell));
  });

  it('status: cyan icon + cyan edge; alert turns the icon red; active adds the cyan ring', () => {
    const { rerender } = render(
      <EqxIconButton variant="strip" status="calm" icon={<CheckIcon />} tooltip="Order" data-testid="t" />,
    );
    const el = () => screen.getByTestId('t');
    expect(getComputedStyle(el()).color).toBe(computed('color', HUD.color.auto));
    expect(getComputedStyle(el()).borderTopColor).toBe(computed('borderColor', HUD.strip.statusEdge));
    expect(el().dataset['status']).toBe('calm');
    rerender(<EqxIconButton variant="strip" status="alert" icon={<CheckIcon />} tooltip="Stance" data-testid="t" />);
    expect(getComputedStyle(el()).color).toBe(computed('color', HUD.color.danger));
    rerender(<EqxIconButton variant="strip" status="calm" active icon={<CheckIcon />} tooltip="Order" data-testid="t" />);
    expect(getComputedStyle(el()).borderTopColor).toBe(computed('borderColor', HUD.color.auto));
    expect(getComputedStyle(el()).boxShadow).toContain('1px');
  });

  it('badge is a gold pill', () => {
    const { container } = render(<EqxIconButton variant="strip" icon={<CheckIcon />} tooltip="x" badge={5} />);
    const b = container.querySelector('.MuiBadge-badge') as HTMLElement;
    expect(b.textContent).toBe('5');
    expect(getComputedStyle(b).backgroundColor).toBe(computed('backgroundColor', HUD.color.credits));
  });
});
