import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const send = vi.fn();
vi.mock('../net/clientSingleton', () => ({
  getGameClient: () => ({ getRoom: () => ({ send }) }),
}));

import { ResearchLabPanel } from './ResearchLabPanel';
import { useUIStore } from '../state/store';
import type { LabBlueprintView, LabState } from '../../shared-types/messages/labMessages';
import { COMBINE_FEE, copyFee, researchFee } from '../../shared-types/research';

const bp = (uid: string, over: Partial<LabBlueprintView> = {}): LabBlueprintView => ({
  uid, product: 'hull:gunship', name: 'Gunship', kind: 'bpo', runs: null, material: 2, output: 30, quality: 40, ...over,
});

const state = (over: Partial<LabState> = {}): LabState => ({
  type: 'lab_state', entityId: 7, powered: true, connected: true, job: null, blueprints: [], ...over,
});

describe('ResearchLabPanel (economy v2 W3)', () => {
  afterEach(() => {
    send.mockReset();
    act(() => useUIStore.getState().setLabState(null));
  });

  it('asks for the view on mount and shows blueprints by name, never ids', () => {
    render(<ResearchLabPanel entityId={7} />);
    expect(send).toHaveBeenCalledWith('lab_query', { type: 'lab_query', entityId: 7 });
    act(() => useUIStore.getState().setLabState(state({ blueprints: [bp('uid-a'), bp('uid-b', { kind: 'bpc', runs: 3 })] })));
    const rows = screen.getAllByTestId('lab-bp');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Gunship');
    expect(rows[1]!.textContent).toContain('Copy · 3 runs');
    expect(document.body.textContent).not.toContain('uid-');
    expect(document.body.textContent).not.toContain('hull:');
  });

  it('an original offers research + copy with the real fees; sends lab_start', () => {
    render(<ResearchLabPanel entityId={7} />);
    act(() => useUIStore.getState().setLabState(state({ blueprints: [bp('a', { material: 2, output: 30 })] })));
    fireEvent.click(screen.getByTestId('lab-bp'));
    expect(screen.getByTestId('lab-research-material').textContent).toContain(`${researchFee(2)}¢`);
    expect(screen.getByTestId('lab-research-output').textContent).toContain(`${researchFee(3)}¢`);
    expect(screen.getByTestId('lab-copy-5').textContent).toContain(`${copyFee(5)}¢`);
    fireEvent.click(screen.getByTestId('lab-research-output'));
    expect(send).toHaveBeenLastCalledWith('lab_start', { type: 'lab_start', entityId: 7, job: { kind: 'research', stat: 'output', uid: 'a' } });
  });

  it('three matching blueprints offer Combine; a mixed set does not', () => {
    render(<ResearchLabPanel entityId={7} />);
    const copies = ['a', 'b', 'c'].map((u) => bp(u, { kind: 'bpc', runs: 2 }));
    act(() => useUIStore.getState().setLabState(state({ blueprints: [...copies, bp('o')] })));
    const rows = screen.getAllByTestId('lab-bp');
    fireEvent.click(rows[0]!);
    fireEvent.click(rows[1]!);
    fireEvent.click(rows[3]!); // an original in a set of copies
    expect(screen.queryByTestId('lab-combine')).toBeNull();
    fireEvent.click(rows[3]!); // deselect
    fireEvent.click(rows[2]!);
    expect(screen.getByTestId('lab-combine').textContent).toContain(`${COMBINE_FEE}¢`);
    fireEvent.click(screen.getByTestId('lab-combine'));
    expect(send).toHaveBeenLastCalledWith('lab_start', { type: 'lab_start', entityId: 7, job: { kind: 'combine', uids: ['a', 'b', 'c'] } });
  });

  it('shows a running job with progress and Cancel, an unpowered warning, and the verdict', () => {
    render(<ResearchLabPanel entityId={7} />);
    act(() => useUIStore.getState().setLabState(state({
      powered: false, ok: false, message: 'The lab is already busy.',
      job: { kind: 'copy', label: 'Copying Gunship (3 runs)', done: 10, pulses: 45 },
    })));
    expect(screen.getByTestId('lab-job').getAttribute('data-done')).toBe('10');
    expect(screen.getByTestId('lab-unpowered')).toBeTruthy();
    expect(screen.getByTestId('lab-message').textContent).toBe('The lab is already busy.');
    // A plain poll reply (no message) keeps the verdict up.
    act(() => useUIStore.getState().setLabState(state({ job: { kind: 'copy', label: 'Copying Gunship (3 runs)', done: 11, pulses: 45 } })));
    expect(screen.getByTestId('lab-message')).toBeTruthy();
    fireEvent.click(screen.getByTestId('lab-cancel'));
    expect(send).toHaveBeenLastCalledWith('lab_cancel', { type: 'lab_cancel', entityId: 7 });
  });

  it('ignores another lab’s state', () => {
    render(<ResearchLabPanel entityId={7} />);
    act(() => useUIStore.getState().setLabState(state({ entityId: 99, blueprints: [bp('a')] })));
    expect(screen.queryAllByTestId('lab-bp')).toHaveLength(0);
  });
});
