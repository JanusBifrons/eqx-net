import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { EqxIconButton } from './EqxIconButton.js';
import { EqxIcon } from '../EqxIcon/EqxIcon.js';
import { TONE_COLOR } from '../EqxButton/EqxButton.js';
import { HEX_CLIP } from './hexTile.js';
import { HUD } from '../../client/hud/tokens.js';

/** The computed form jsdom gives a colour, so tokens compare to computed styles. */
function computed(c: string): string {
  const probe = document.createElement('div');
  probe.style.color = c;
  document.body.appendChild(probe);
  const v = getComputedStyle(probe).color;
  probe.remove();
  return v;
}

const el = () => screen.getByTestId('h');
const cs = () => getComputedStyle(el());

describe('EqxIconButton variant="hex" (selection HUD)', () => {
  it('is a pointy-top hexagon of HUD.hex, named by its tooltip, icon only by default', () => {
    render(<EqxIconButton variant="hex" icon={<EqxIcon name="move" />} tooltip="Move" data-testid="h" />);
    expect(screen.getByRole('button', { name: 'Move' })).toBe(el());
    expect(el().dataset['variant']).toBe('hex');
    expect({ w: cs().width, h: cs().height }).toEqual({ w: `${HUD.hex.w}px`, h: `${HUD.hex.h}px` });
    expect(cs().clipPath).toBe(HEX_CLIP);
    expect(el().querySelector('svg')).not.toBeNull();
    expect(el().textContent).toBe('');
    expect(screen.queryByTestId('h-word')).toBeNull();
  });

  it('a picture icon (a building portrait) shrinks to the icon footprint inside the frame', () => {
    render(<EqxIconButton variant="hex" icon={<img src="x.png" alt="" data-testid="pic" />} tooltip="Capital" word="Capital" data-testid="h" />);
    const img = getComputedStyle(screen.getByTestId('pic'));
    expect({ w: img.width, h: img.height }).toEqual({ w: `${HUD.hex.icon}px`, h: `${HUD.hex.icon}px` });
    expect(img.objectFit).toBe('contain');
    expect(screen.getByTestId('h-word').textContent).toBe('Capital');
  });

  it('word shows under the icon in the HUD label font with a black outline', () => {
    render(<EqxIconButton variant="hex" icon={<EqxIcon name="move" />} tooltip="Move: tap a point" word="Move" data-testid="h" />);
    const w = screen.getByTestId('h-word');
    expect(w.textContent).toBe('Move');
    const ws = getComputedStyle(w);
    expect(ws.fontFamily).toBe(HUD.font.label);
    // jsdom drops the space after the comma; compare without whitespace.
    expect(ws.textShadow.replace(/\s/g, '')).toBe(HUD.hex.textOutline.replace(/\s/g, ''));
    expect(ws.color).toBe(computed(HUD.strip.ink));
    // The word is not the accessible name: the tooltip is.
    expect(el().getAttribute('aria-label')).toBe('Move: tap a point');
  });

  it('tone colours the edge and the icon; the body stays dark panel', () => {
    const tones = ['good', 'danger', 'patrol', 'warn', 'primary', 'neutral'] as const;
    const { rerender } = render(<EqxIconButton variant="hex" icon={<EqxIcon name="move" />} tooltip="x" data-testid="h" />);
    for (const tone of tones) {
      rerender(<EqxIconButton variant="hex" tone={tone} icon={<EqxIcon name="move" />} tooltip="x" data-testid="h" />);
      expect(el().dataset['tone']).toBe(tone);
      expect(cs().color).toBe(computed(TONE_COLOR[tone]));
      expect(cs().backgroundColor).toBe(computed(TONE_COLOR[tone]));
    }
    expect(TONE_COLOR.good).toBe(HUD.color.hullOk);
    expect(TONE_COLOR.patrol).toBe(HUD.hex.patrol);
    expect(TONE_COLOR.warn).toBe(HUD.color.manual);
  });

  it('lit glows on the wrapper and flags data-lit; dim fades but still taps', () => {
    const onClick = vi.fn();
    const { rerender } = render(<EqxIconButton variant="hex" tone="good" icon={<EqxIcon name="move" />} tooltip="x" onClick={onClick} data-testid="h" />);
    const wrap = () => el().parentElement!;
    expect(getComputedStyle(wrap()).filter).toBe('none');
    rerender(<EqxIconButton variant="hex" tone="good" lit icon={<EqxIcon name="move" />} tooltip="x" onClick={onClick} data-testid="h" />);
    expect(el().dataset['lit']).toBe('true');
    expect(getComputedStyle(wrap()).filter).toContain('drop-shadow');
    rerender(<EqxIconButton variant="hex" tone="good" dim icon={<EqxIcon name="move" />} tooltip="x" onClick={onClick} data-testid="h" />);
    expect(el().dataset['dim']).toBe('true');
    expect(cs().opacity).toBe(String(HUD.hex.dimOpacity));
    fireEvent.click(el());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('disabled fades and blocks the tap', () => {
    const onClick = vi.fn();
    render(<EqxIconButton variant="hex" tone="danger" disabled word="Lock" icon={<EqxIcon name="target" />} tooltip="Lock" onClick={onClick} data-testid="h" />);
    expect((el() as HTMLButtonElement).disabled).toBe(true);
    expect(cs().opacity).toBe(String(HUD.hex.dimOpacity));
    fireEvent.click(el());
    expect(onClick).not.toHaveBeenCalled();
  });
});
