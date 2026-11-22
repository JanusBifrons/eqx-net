import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EqxIcon } from '../EqxIcon/EqxIcon.js';
import { EqxStrip, FLYOUT_HEIGHT, STRIP_WIDTH } from './EqxStrip.js';
import { EqxIconButton } from '../EqxIconButton/EqxIconButton.js';
import { EqxStripIdentity } from '../EqxStripIdentity/EqxStripIdentity.js';
import { HUD } from '../../client/hud/tokens.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function SelectionStrip({ open, count }: { open?: boolean; count?: number }) {
  return (
    <EqxStrip data-testid="strip" aria-label="Selection" {...(open === undefined ? {} : { open })}>
      <EqxStripIdentity
        icon={<EqxIcon name="fleet" />}
        tooltip="Fighter"
        health="warn"
        data-testid="identity"
        {...(count === undefined ? {} : { count })}
      />
      <EqxIconButton variant="strip" icon={<EqxIcon name="stop" />} tooltip="Stop" tone="danger" badge={2} />
      <EqxStrip.Separator data-testid="sep" />
      <EqxIconButton variant="strip" icon={<EqxIcon name="cog" size="large" />} tooltip="Menu" />
      <EqxIconButton variant="strip" icon={<EqxIcon name="close" />} tooltip="Deselect" />
    </EqxStrip>
  );
}

/** Every non-blank text node in `root` that is not inside a count badge. */
function textNodesOutsideBadges(root: HTMLElement): string[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out: string[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent ?? '';
    if (text.trim() === '') continue;
    if (n.parentElement?.closest('.MuiBadge-badge')) continue;
    out.push(text);
  }
  return out;
}

describe('EqxStrip', () => {
  it('has zero text nodes except badges', () => {
    render(<SelectionStrip count={3} />);
    const strip = screen.getByTestId('strip');
    expect(textNodesOutsideBadges(strip)).toEqual([]);
    // The badges are there and are the only text.
    expect(strip.querySelectorAll('.MuiBadge-badge:not(.MuiBadge-invisible)').length).toBe(2);
  });

  it('every child button is the same box with its icon centred', () => {
    render(<SelectionStrip />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBe(4);
    const px = `${HUD.strip.tile}px`;
    for (const b of buttons) {
      const cs = getComputedStyle(b);
      expect({ w: cs.width, h: cs.height }).toEqual({ w: px, h: px });
      expect(cs.alignItems).toBe('center');
      expect(cs.justifyContent).toBe('center');
    }
  });

  it('is one centred column exactly one tile plus padding wide, not self-positioned', () => {
    render(<SelectionStrip />);
    const strip = screen.getByRole('toolbar', { name: 'Selection' });
    const cs = getComputedStyle(strip);
    expect(cs.flexDirection).toBe('column');
    expect(cs.alignItems).toBe('center');
    expect(cs.boxSizing).toBe('border-box');
    // One tile plus padding, widened by the camera band (safe-area-inset-left)
    // so the strip can sit flush on the edge with its buttons clear of the band.
    expect(strip.style.width || cs.width).toContain(`${STRIP_WIDTH}px`);
    expect(cs.position).not.toBe('fixed');
    expect(cs.position).not.toBe('absolute');
  });

  it('is docked to the left edge: no left border, square left corners (mock .lbar)', () => {
    render(<SelectionStrip />);
    const cs = getComputedStyle(screen.getByTestId('strip'));
    expect(cs.borderLeftWidth === '0' || cs.borderLeftWidth === '0px' || cs.borderLeftStyle === 'none').toBe(true);
    expect(cs.borderRightWidth).toBe('1px');
    expect(cs.borderRadius).toBe(`0 ${HUD.strip.radius}px ${HUD.strip.radius}px 0`);
    expect(cs.paddingTop).toBe(`${HUD.strip.pad}px`);
    expect(cs.paddingRight).toBe(`${HUD.strip.pad}px`);
    // Flush on the edge: the left padding also steps the buttons past a phone's camera band.
    expect(cs.paddingLeft).toContain('safe-area-inset-left');
    expect(cs.gap).toBe(`${HUD.strip.gap}px`);
  });

  it('separator is a thin rule with no text', () => {
    render(<SelectionStrip />);
    const sep = screen.getByTestId('sep');
    expect(sep.textContent).toBe('');
    expect(screen.getByRole('separator')).toBe(sep);
  });

  it('warns in dev for a child that is not a strip entry', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(
      <EqxStrip>
        <EqxIconButton variant="strip" icon={<EqxIcon name="stop" />} tooltip="Stop" />
        <span>Stop</span>
      </EqxStrip>,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('[EqxStrip]');
  });

  it('does not warn for strip entries only', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<SelectionStrip />);
    expect(warn).not.toHaveBeenCalled();
  });

  it('open=false slides it fully out of view to the left', () => {
    // jsdom has no layout: give the strip a slot position (16 px in, one strip wide).
    const width = STRIP_WIDTH;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 16, top: 0, right: 16 + width, bottom: 200, width, height: 200, x: 16, y: 0, toJSON: () => ({}),
    } as DOMRect);
    render(<SelectionStrip open={false} />);
    const strip = screen.getByTestId('strip');
    expect(strip.dataset['open']).toBe('false');
    expect(strip.style.visibility).toBe('hidden');
    const m = /translateX\((-?[\d.]+)px\)/.exec(strip.style.transform);
    expect(m).not.toBeNull();
    // Moved left by at least its own left edge + width: no pixel stays on screen.
    expect(Number(m?.[1])).toBeLessThanOrEqual(-(16 + width));
  });

  it('open=true shows it in place', () => {
    render(<SelectionStrip open />);
    const strip = screen.getByTestId('strip');
    expect(strip.dataset['open']).toBe('true');
    expect(strip.style.visibility).not.toBe('hidden');
    expect(strip.style.transform === '' || strip.style.transform === 'none').toBe(true);
  });

  it('orientation=horizontal is the fly-out row: one tile plus padding tall, cyan edge, same tiles', () => {
    render(
      <EqxStrip orientation="horizontal" aria-label="Options" data-testid="row">
        <EqxIconButton variant="strip" icon={<EqxIcon name="stop" />} tooltip="Stop" />
        <EqxIconButton variant="strip" icon={<EqxIcon name="cog" size="large" />} tooltip="Menu" />
        <EqxIconButton variant="strip" icon={<EqxIcon name="close" />} tooltip="Deselect" />
      </EqxStrip>,
    );
    const row = screen.getByRole('toolbar', { name: 'Options' });
    expect(row.getAttribute('aria-orientation')).toBe('horizontal');
    const cs = getComputedStyle(row);
    expect(cs.flexDirection).toBe('row');
    expect(cs.alignItems).toBe('center');
    expect(cs.height).toBe(`${FLYOUT_HEIGHT}px`);
    expect(cs.width).not.toBe(`${STRIP_WIDTH}px`);
    expect(cs.borderLeftWidth).toBe('1px');
    expect(cs.borderRadius).toBe(`${HUD.strip.flyRadius}px`);
    expect(cs.gap).toBe(`${HUD.strip.flyGap}px`);
    const px = `${HUD.strip.tile}px`;
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBe(3);
    for (const b of buttons) {
      const bs = getComputedStyle(b);
      expect({ w: bs.width, h: bs.height }).toEqual({ w: px, h: px });
    }
  });

  it('defaults to vertical', () => {
    render(<SelectionStrip />);
    expect(screen.getByTestId('strip').getAttribute('aria-orientation')).toBe('vertical');
  });
});
