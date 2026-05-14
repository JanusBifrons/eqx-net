/**
 * 2026-05-14 — DebugTab snapshot-rate gate regression lock.
 *
 * With `ModalProps.keepMounted: true` on AdvancedDrawer (2026-05-13,
 * commit `2aa7d4f`), drawer-tab content stays in DOM even when the
 * drawer is closed. DebugTab returns `null` when `isDrawerOpen === false`
 * so the snapshot-rate Zustand subscriptions inside `ConnectionDiagnostics`,
 * `DevOverlay`, and `LogPanel` don't fire when the panel can't be seen.
 *
 * If this test fails, the gate has been removed — restore it before
 * shipping, otherwise the historic 17 Hz background-render cost is live
 * for any user who has switched to the Debug tab once during a session
 * (`drawerTab` persists in Zustand). See `docs/LESSONS.md` 2026-05-13 §3.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DebugTab } from './DebugTab.js';
import { useUIStore } from '../../../state/store.js';

beforeEach(() => {
  // Default to closed; each test sets explicitly.
  useUIStore.setState({
    isDrawerOpen: false,
    drawerTab: 'debug',
    showDevOverlay: false,
    showLogPanel: false,
  });
});

describe('DebugTab — snapshot-rate gate', () => {
  it('returns null when the drawer is closed', () => {
    useUIStore.setState({ isDrawerOpen: false });
    const { container } = render(<DebugTab />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('diag-capture-button')).not.toBeInTheDocument();
  });

  it('renders the capture button when the drawer is open', () => {
    useUIStore.setState({ isDrawerOpen: true });
    render(<DebugTab />);
    expect(screen.getByTestId('diag-capture-button')).toBeInTheDocument();
  });
});
