import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { EqxSegmented, type EqxSegmentedOption } from './EqxSegmented.js';

const VIEWS: EqxSegmentedOption[] = [
  { id: 'list', label: 'List' },
  { id: 'map', label: 'Map' },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EqxSegmented', () => {
  it('renders the group with its accessible name, marks the value, forwards data-testid', () => {
    render(<EqxSegmented options={VIEWS} value="map" onChange={() => {}} label="View" data-testid="seg" />);
    expect(screen.getByRole('group', { name: 'View' })).toBe(screen.getByTestId('seg'));
    expect(screen.getByRole('button', { name: 'Map' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'List' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('seg-list')).toBe(screen.getByRole('button', { name: 'List' }));
  });

  it('calls onChange once per pick, never on re-clicking the current option', () => {
    const onChange = vi.fn();
    render(<EqxSegmented options={VIEWS} value="list" onChange={onChange} label="View" />);
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('map');
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('icon options use their tooltip as the accessible name', () => {
    render(
      <EqxSegmented
        options={[
          { id: 'a', icon: <svg />, tooltip: 'Attack' },
          { id: 'p', icon: <svg />, tooltip: 'Patrol' },
        ]}
        value="a"
        onChange={() => {}}
        label="Order"
      />,
    );
    expect(screen.getByRole('button', { name: 'Patrol' })).toBeTruthy();
  });

  it('accepts 2 to 5 options', () => {
    const five: EqxSegmentedOption[] = [...VIEWS, ...['c', 'd', 'e'].map((id) => ({ id, label: id }))];
    render(<EqxSegmented options={five} value="list" onChange={() => {}} label="View" />);
    expect(screen.getAllByRole('button')).toHaveLength(5);
  });

  it('rejects fewer than 2 or more than 5 options in dev', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(import.meta.env.DEV).toBe(true);
    const one: EqxSegmentedOption[] = [{ id: 'a', label: 'A' }];
    expect(() => render(<EqxSegmented options={one} value="a" onChange={() => {}} label="V" />)).toThrow(/2-5/);
    const six: EqxSegmentedOption[] = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, label: id }));
    expect(() => render(<EqxSegmented options={six} value="a" onChange={() => {}} label="V" />)).toThrow(/2-5/);
  });

  it('appliedValue: changed only while the value differs from it', () => {
    const { rerender } = render(
      <EqxSegmented options={VIEWS} value="map" appliedValue="list" onChange={() => {}} label="View" data-testid="seg" />,
    );
    expect(screen.getByTestId('seg').getAttribute('data-changed')).toBe('true');
    rerender(<EqxSegmented options={VIEWS} value="map" appliedValue="map" onChange={() => {}} label="View" data-testid="seg" />);
    expect(screen.getByTestId('seg').getAttribute('data-changed')).toBeNull();
    rerender(<EqxSegmented options={VIEWS} value="map" onChange={() => {}} label="View" data-testid="seg" />);
    expect(screen.getByTestId('seg').getAttribute('data-changed')).toBeNull();
  });

  it('disabled blocks picks', () => {
    const onChange = vi.fn();
    render(<EqxSegmented options={VIEWS} value="list" onChange={onChange} label="View" disabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
