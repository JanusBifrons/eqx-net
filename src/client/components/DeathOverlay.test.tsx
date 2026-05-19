/**
 * Coverage lock for the death-overlay "Send diagnostics" affordance
 * (added from the weapon-hit-prediction smoke-test feedback loop —
 * the player needed a one-tap capture exactly where problems are
 * noticed, instead of opening the hidden Debug drawer mid-frustration).
 *
 * Locks: the button reuses the shared `captureDiagnostic` mechanism,
 * passes the death-overlay note + the same `window.__eqxClient.stats`
 * source the Debug tab uses, disables while in-flight, and surfaces the
 * resulting capture dir (or the error) back to the player. Also locks
 * the Respawn passthrough and the `isDead` null-gate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../debug/diagCapture', () => ({ captureDiagnostic: vi.fn() }));

import { captureDiagnostic } from '../debug/diagCapture';
import { DeathOverlay, DeathOverlayContent } from './DeathOverlay.js';
import { useUIStore } from '../state/store';

const mockCapture = vi.mocked(captureDiagnostic);

describe('DeathOverlayContent — Send diagnostics', () => {
  beforeEach(() => {
    mockCapture.mockReset();
    delete (window as unknown as { __eqxClient?: unknown }).__eqxClient;
  });

  it('renders You Died, Respawn, and the Send diagnostics button', () => {
    render(<DeathOverlayContent onRespawn={() => {}} />);
    expect(screen.getByText('You Died')).toBeInTheDocument();
    expect(screen.getByText('Respawn')).toBeInTheDocument();
    expect(screen.getByTestId('death-diag-capture-button')).toHaveTextContent('Send diagnostics');
  });

  it('Respawn click calls onRespawn', () => {
    const onRespawn = vi.fn();
    render(<DeathOverlayContent onRespawn={onRespawn} />);
    fireEvent.click(screen.getByText('Respawn'));
    expect(onRespawn).toHaveBeenCalledTimes(1);
  });

  it('on success: calls captureDiagnostic with the death-overlay note + stats, then shows the saved dir', async () => {
    (window as unknown as { __eqxClient?: { stats?: Record<string, unknown> } }).__eqxClient = {
      stats: { corrRate: 0.42 },
    };
    mockCapture.mockResolvedValue({ ok: true, dir: '2026-05-19T10-00-00-000Z-abc123' });

    render(<DeathOverlayContent onRespawn={() => {}} />);
    fireEvent.click(screen.getByTestId('death-diag-capture-button'));

    await waitFor(() =>
      expect(screen.getByTestId('death-diag-capture-status')).toHaveTextContent(
        'Sent: 2026-05-19T10-00-00-000Z-abc123',
      ),
    );
    expect(mockCapture).toHaveBeenCalledWith({
      note: 'sent from death overlay',
      stats: { corrRate: 0.42 },
    });
  });

  it('disables the button while the capture is in flight', async () => {
    let resolve!: (v: { ok: boolean; dir?: string }) => void;
    mockCapture.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );

    render(<DeathOverlayContent onRespawn={() => {}} />);
    const btn = screen.getByTestId('death-diag-capture-button');
    fireEvent.click(btn);

    await waitFor(() => expect(btn).toBeDisabled());
    expect(btn).toHaveTextContent('Sending…');

    resolve({ ok: true, dir: 'd1' });
    await waitFor(() => expect(btn).not.toBeDisabled());
  });

  it('on failure: surfaces the error to the player', async () => {
    mockCapture.mockResolvedValue({ ok: false, error: 'HTTP 500' });
    render(<DeathOverlayContent onRespawn={() => {}} />);
    fireEvent.click(screen.getByTestId('death-diag-capture-button'));
    await waitFor(() =>
      expect(screen.getByTestId('death-diag-capture-status')).toHaveTextContent('Failed: HTTP 500'),
    );
  });
});

describe('DeathOverlay — isDead gate', () => {
  it('renders nothing while the player is alive', () => {
    useUIStore.setState({ isDead: false });
    const { container } = render(<DeathOverlay onRespawn={() => {}} />);
    expect(screen.queryByTestId('death-overlay')).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });
});
