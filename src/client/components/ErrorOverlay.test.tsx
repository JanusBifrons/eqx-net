import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import type { ErrorInfo } from 'react';
import { ErrorBoundary } from './ErrorOverlay.js';

const { logEventMock } = vi.hoisted(() => ({ logEventMock: vi.fn() }));
vi.mock('../debug/ClientLogger', () => ({ logEvent: logEventMock }));
// The overlay's Send button pulls these; stub to keep the render pure.
vi.mock('../debug/diagCapture', () => ({ captureDiagnostic: vi.fn(async () => ({ ok: true })) }));
vi.mock('../net/clientSingleton', () => ({ getGameClient: () => null }));

describe('ErrorBoundary (B3 — R2)', () => {
  beforeEach(() => {
    (logEventMock as Mock).mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders children normally when there is no error', () => {
    render(
      <ErrorBoundary>
        <div data-testid="child-ok">hello</div>
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('child-ok')).toBeInTheDocument();
    expect(screen.queryByTestId('error-overlay')).toBeNull();
  });

  // The boundary deliberately re-renders children after catching (recoverable
  // design), which fights React 18's concurrent error-retry under
  // testing-library. B3's actual addition is the componentDidCatch → ClientLogger
  // line, so lock that lifecycle behaviour directly.
  it('componentDidCatch captures the error AND routes it into ClientLogger (B3)', () => {
    const boundary = new ErrorBoundary({ children: null });
    boundary.componentDidCatch(new Error('kaboom'), { componentStack: '\n  at Thing' } as ErrorInfo);
    expect(logEventMock).toHaveBeenCalledWith(
      'react_error_boundary',
      expect.objectContaining({ message: 'kaboom' }),
    );
  });

  it('getDerivedStateFromError flips the boundary into its error state', () => {
    expect(ErrorBoundary.getDerivedStateFromError()).toEqual({ hasError: true });
  });
});
