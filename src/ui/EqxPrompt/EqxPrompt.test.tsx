import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EqxPrompt, EqxPromptStack, PROMPT_TONE_COLOR } from './EqxPrompt.js';
import { HUD } from '../../client/hud/tokens.js';

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('EqxPrompt', () => {
  it('a readout: message, tone on data-tone, takes no taps, no buttons', () => {
    render(<EqxPrompt message="Doors closing." tone="warn" data-testid="p" />);
    const p = screen.getByTestId('p');
    expect(p).toHaveTextContent('Doors closing.');
    expect(p.getAttribute('data-tone')).toBe('warn');
    expect(p.getAttribute('role')).toBe('status');
    expect(getComputedStyle(p).pointerEvents).toBe('none');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('each tone maps to its token colour', () => {
    expect(PROMPT_TONE_COLOR.info).toBe(HUD.color.auto);
    expect(PROMPT_TONE_COLOR.warn).toBe(HUD.color.manual);
    expect(PROMPT_TONE_COLOR.danger).toBe(HUD.color.danger);
    expect(PROMPT_TONE_COLOR.good).toBe(HUD.color.hullOk);
    expect(PROMPT_TONE_COLOR.gold).toBe(HUD.color.credits);
  });

  it('actions are buttons named by their label; a tap calls onPick once', () => {
    const pay = vi.fn();
    const no = vi.fn();
    render(<EqxPrompt message="Toll 5¢" tone="gold" data-testid="p" actions={[
      { label: 'Pay', onPick: pay, tone: 'primary', 'data-testid': 'pay' },
      { label: 'Decline', onPick: no, 'data-testid': 'no' },
    ]} />);
    expect(getComputedStyle(screen.getByTestId('p')).pointerEvents).toBe('auto');
    fireEvent.click(screen.getByRole('button', { name: 'Pay' }));
    expect(pay).toHaveBeenCalledTimes(1);
    expect(no).not.toHaveBeenCalled();
    expect(screen.getByTestId('no')).toBeTruthy();
  });

  it('inline lays the buttons beside the message', () => {
    render(<EqxPrompt message="Warping to Belt A" inline actions={[{ label: 'Cancel', onPick: () => {} }]} data-testid="p" />);
    expect(getComputedStyle(screen.getByTestId('p')).flexDirection).toBe('row');
  });

  it('onTap makes the card one button; ignored with actions', () => {
    const onTap = vi.fn();
    render(<EqxPrompt message="Hauler under fire" tone="danger" onTap={onTap} data-testid="p" />);
    const p = screen.getByRole('button', { name: 'Hauler under fire' });
    expect(p).toBe(screen.getByTestId('p'));
    fireEvent.click(p);
    expect(onTap).toHaveBeenCalledTimes(1);
    cleanup();
    render(<EqxPrompt message="m" onTap={onTap} actions={[{ label: 'Ok', onPick: () => {} }]} data-testid="q" />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('timeoutMs calls onTimeout once; a new key restarts the timer', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const { rerender } = render(<EqxPrompt key={1} message="m" timeoutMs={1000} onTimeout={onTimeout} />);
    act(() => { vi.advanceTimersByTime(900); });
    rerender(<EqxPrompt key={2} message="m" timeoutMs={1000} onTimeout={onTimeout} />);
    act(() => { vi.advanceTimersByTime(900); });
    expect(onTimeout).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(200); });
    expect(onTimeout).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('dataAttrs become data-* and win over data-tone; dim fades it', () => {
    render(<EqxPrompt message="m" tone="gold" dim dataAttrs={{ tone: 'world', 'warning-secs': 4 }} data-testid="p" />);
    const p = screen.getByTestId('p');
    expect(p.getAttribute('data-tone')).toBe('world');
    expect(p.getAttribute('data-warning-secs')).toBe('4');
    expect(getComputedStyle(p).opacity).toBe(String(HUD.prompt.dimOpacity));
  });

  it('EqxPromptStack renders its box even empty, with data attrs', () => {
    render(<EqxPromptStack data-testid="s" dataAttrs={{ 'warning-active': '0' }} />);
    expect(screen.getByTestId('s').getAttribute('data-warning-active')).toBe('0');
  });
});
