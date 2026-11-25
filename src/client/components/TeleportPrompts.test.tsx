import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const sent = vi.hoisted(() => ({ toll: [] as unknown[], pair: [] as unknown[] }));
vi.mock('../structures/structureActionsClient', () => ({
  sendTollAnswer: (padId: number, a: string) => { sent.toll.push([padId, a]); },
  sendTeleportPairAnswer: (id: string, ok: boolean) => { sent.pair.push([id, ok]); },
}));

import { TeleportPrompts } from './TeleportPrompts';
import { useUIStore } from '../state/store';
import { markWindowOpen } from '../../ui/EqxWindow/windowOpen.js';

const toll = (credits: number) => ({ type: 'teleport_toll' as const, padId: 7, credits, ownerName: 'Kestrel' });

describe('TeleportPrompts (EqxPrompt)', () => {
  beforeEach(() => {
    sent.toll.length = 0;
    sent.pair.length = 0;
    useUIStore.setState({ tollPrompt: null, pairRequests: [] });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('a toll shows a gold prompt with its credits; Pay answers and clears it', () => {
    act(() => { useUIStore.getState().setTollPrompt(toll(25)); });
    render(<TeleportPrompts />);
    const p = screen.getByTestId('toll-prompt');
    expect(p.getAttribute('data-credits')).toBe('25');
    expect(p.getAttribute('data-tone')).toBe('gold');
    expect(p.textContent).toContain('Kestrel charges 25¢');
    fireEvent.click(screen.getByTestId('toll-pay'));
    expect(sent.toll).toEqual([[7, 'pay']]);
    expect(useUIStore.getState().tollPrompt).toBeNull();
  });

  it('a toll expires after 15 s; a new toll restarts the clock', () => {
    vi.useFakeTimers();
    act(() => { useUIStore.getState().setTollPrompt(toll(5)); });
    render(<TeleportPrompts />);
    act(() => { vi.advanceTimersByTime(10_000); });
    act(() => { useUIStore.getState().setTollPrompt(toll(6)); });
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByTestId('toll-prompt').getAttribute('data-credits')).toBe('6');
    act(() => { vi.advanceTimersByTime(5_001); });
    expect(useUIStore.getState().tollPrompt).toBeNull();
    expect(screen.queryByTestId('toll-prompt')).toBeNull();
  });

  it('a pair request is a cyan prompt; Decline answers and removes it', () => {
    act(() => { useUIStore.getState().addPairRequest({ type: 'teleport_pair_request', requestId: 'r1', fromName: 'Vega', label: 'Gate 2' }); });
    render(<TeleportPrompts />);
    expect(screen.getByTestId('pair-request').getAttribute('data-tone')).toBe('info');
    fireEvent.click(screen.getByTestId('pair-request-decline'));
    expect(sent.pair).toEqual([['r1', false]]);
    expect(screen.queryByTestId('pair-request')).toBeNull();
  });

  it('toll and pair prompts stay visible over an open Window', () => {
    act(() => {
      useUIStore.getState().setTollPrompt(toll(5));
      useUIStore.getState().addPairRequest({ type: 'teleport_pair_request', requestId: 'r2', fromName: 'Vega', label: 'Gate 2' });
    });
    markWindowOpen(1);
    try {
      render(<TeleportPrompts />);
      expect(screen.getByTestId('toll-prompt')).toBeTruthy();
      expect(screen.getByTestId('pair-request')).toBeTruthy();
    } finally { markWindowOpen(-1); }
  });
});
