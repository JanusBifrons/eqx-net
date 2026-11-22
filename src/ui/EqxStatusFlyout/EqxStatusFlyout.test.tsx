import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { EqxIcon } from '../EqxIcon/EqxIcon.js';
import { EqxStatusFlyout, type EqxStatusOption } from './EqxStatusFlyout.js';
import { EqxStrip } from '../EqxStrip/EqxStrip.js';
import { EqxIconButton } from '../EqxIconButton/EqxIconButton.js';
import { HUD } from '../../client/hud/tokens.js';

afterEach(() => {
  vi.restoreAllMocks();
});

type Stance = 'hold' | 'defend' | 'attack';
const OPTIONS: readonly EqxStatusOption<Stance>[] = [
  { id: 'hold', icon: <EqxIcon name="holdFire" />, tooltip: 'Hold fire' },
  { id: 'defend', icon: <EqxIcon name="defensive" />, tooltip: 'Defensive', tone: 'primary' },
  { id: 'attack', icon: <EqxIcon name="aggressive" />, tooltip: 'Aggressive', tone: 'danger' },
];

function Harness({ onChange = vi.fn() }: { onChange?: (id: Stance) => void }) {
  return (
    <div>
      <button type="button" data-testid="outside">
        world
      </button>
      <EqxStrip aria-label="Selection">
        <EqxStatusFlyout value="defend" options={OPTIONS} onChange={onChange} tooltip="Stance" data-testid="stance" />
        <EqxIconButton variant="strip" icon={<EqxIcon name="stop" />} tooltip="Stop" data-testid="stop" />
      </EqxStrip>
    </div>
  );
}

function openFlyout(): HTMLElement {
  fireEvent.click(screen.getByTestId('stance'));
  return screen.getByTestId('stance-options');
}

describe('EqxStatusFlyout', () => {
  it('trigger shows the current option, named by its tooltip; closed by default', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Stance' });
    expect(trigger.dataset['status']).toBe('calm');
    expect(trigger.textContent).toBe('');
    expect(screen.queryByTestId('stance-options')).toBeNull();
  });

  it('tapping it opens the options, the current one marked active', () => {
    render(<Harness />);
    const flyout = openFlyout();
    expect(flyout.getAttribute('role')).toBe('toolbar');
    expect(screen.getByTestId('stance-option-defend').dataset['active']).toBe('true');
    expect(screen.getByTestId('stance-option-hold').dataset['active']).toBe('false');
    expect(screen.getByTestId('stance-option-attack').dataset['active']).toBe('false');
    expect(screen.getByRole('button', { name: 'Aggressive' })).toBe(screen.getByTestId('stance-option-attack'));
  });

  it('a pick calls onChange exactly once with the id and closes', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    openFlyout();
    fireEvent.click(screen.getByTestId('stance-option-attack'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('attack');
    expect(screen.queryByTestId('stance-options')).toBeNull();
  });

  it('an outside tap closes it without calling onChange', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    // MUI ClickAwayListener arms itself one task after mount.
    await act(() => new Promise<void>((r) => setTimeout(r, 0)));
    openFlyout();
    fireEvent.click(screen.getByTestId('outside'));
    expect(screen.queryByTestId('stance-options')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Esc closes it without calling onChange, before other Esc handlers see it', () => {
    const onChange = vi.fn();
    const other = vi.fn();
    window.addEventListener('keydown', other);
    render(<Harness onChange={onChange} />);
    openFlyout();
    fireEvent.keyDown(screen.getByTestId('stance-option-hold'), { key: 'Escape' });
    expect(screen.queryByTestId('stance-options')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
    // Closed: Esc passes through to the rest of the app again.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(other).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', other);
  });

  it('tapping the trigger again closes it', () => {
    render(<Harness />);
    openFlyout();
    fireEvent.click(screen.getByTestId('stance'));
    expect(screen.queryByTestId('stance-options')).toBeNull();
  });

  it('options are the same box as the strip buttons, icon centred', () => {
    render(<Harness />);
    openFlyout();
    const px = `${HUD.strip.tile}px`;
    const boxes = [screen.getByTestId('stop'), screen.getByTestId('stance'), ...OPTIONS.map((o) => screen.getByTestId(`stance-option-${o.id}`))];
    for (const b of boxes) {
      const cs = getComputedStyle(b);
      expect({ w: cs.width, h: cs.height }).toEqual({ w: px, h: px });
      expect(cs.alignItems).toBe('center');
      expect(cs.justifyContent).toBe('center');
    }
  });

  it('has zero text nodes in the fly-out and on the trigger', () => {
    render(<Harness />);
    const flyout = openFlyout();
    for (const root of [flyout, screen.getByTestId('stance')]) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const texts: string[] = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if ((n.textContent ?? '').trim() !== '') texts.push(n.textContent ?? '');
      }
      expect(texts).toEqual([]);
    }
  });

  it('trigger is a status tile: calm, alert for a danger option, open marks it active; current option active', () => {
    const { rerender } = render(
      <EqxStatusFlyout value="defend" options={OPTIONS} onChange={vi.fn()} tooltip="Stance" data-testid="stance" />,
    );
    const trigger = screen.getByTestId('stance');
    expect(trigger.dataset['variant']).toBe('strip');
    expect(trigger.dataset['status']).toBe('calm');
    expect(trigger.dataset['active']).toBe('false');
    rerender(<EqxStatusFlyout value="attack" options={OPTIONS} onChange={vi.fn()} tooltip="Stance" data-testid="stance" />);
    expect(screen.getByTestId('stance').dataset['status']).toBe('alert');
    fireEvent.click(screen.getByTestId('stance'));
    expect(screen.getByTestId('stance').dataset['active']).toBe('true');
    expect(screen.getByTestId('stance-option-attack').dataset['active']).toBe('true');
    expect(screen.getByTestId('stance-option-hold').dataset['active']).toBe('false');
    expect(screen.getByTestId('stance-option-attack').dataset['variant']).toBe('strip');
  });

  it('is an allowed EqxStrip child (no dev warning)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<Harness />);
    expect(warn).not.toHaveBeenCalled();
  });

  it('disabled trigger does not open', () => {
    render(<EqxStatusFlyout value="hold" options={OPTIONS} onChange={vi.fn()} tooltip="Stance" disabled data-testid="stance" />);
    fireEvent.click(screen.getByTestId('stance'));
    expect(screen.queryByTestId('stance-options')).toBeNull();
  });
});
