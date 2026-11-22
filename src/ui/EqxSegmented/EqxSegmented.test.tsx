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

  it('accepts 2 to 4 options', () => {
    const four: EqxSegmentedOption[] = [...VIEWS, { id: 'c', label: 'C' }, { id: 'd', label: 'D' }];
    render(<EqxSegmented options={four} value="list" onChange={() => {}} label="View" />);
    expect(screen.getAllByRole('button')).toHaveLength(4);
  });

  it('rejects fewer than 2 or more than 4 options in dev', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(import.meta.env.DEV).toBe(true);
    const one: EqxSegmentedOption[] = [{ id: 'a', label: 'A' }];
    expect(() => render(<EqxSegmented options={one} value="a" onChange={() => {}} label="V" />)).toThrow(/2-4/);
    const five: EqxSegmentedOption[] = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, label: id }));
    expect(() => render(<EqxSegmented options={five} value="a" onChange={() => {}} label="V" />)).toThrow(/2-4/);
  });

  it('disabled blocks picks', () => {
    const onChange = vi.fn();
    render(<EqxSegmented options={VIEWS} value="list" onChange={onChange} label="View" disabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    expect(onChange).not.toHaveBeenCalled();
  });
  it('per-option testId overrides the default; the group carries data-value', () => {
    render(
      <EqxSegmented
        options={[{ id: 'list', label: 'List', testId: 'list-btn' }, { id: 'map', label: 'Map' }]}
        value='map'
        onChange={() => {}}
        label='View'
        data-testid='seg'
      />,
    );
    expect(screen.getByTestId('list-btn')).toBe(screen.getByRole('button', { name: 'List' }));
    expect(screen.getByTestId('seg-map')).toBeTruthy();
    expect(screen.getByTestId('seg').getAttribute('data-value')).toBe('map');
  });

  it('onPress fires on every press (re-clicks too) with the button, before onChange', () => {
    const calls: string[] = [];
    const onPress = vi.fn((el: HTMLElement) => calls.push(`press:${el.textContent ?? ''}`));
    const onChange = vi.fn((id: string) => calls.push(`change:${id}`));
    render(
      <EqxSegmented
        options={[{ id: 'list', label: 'List', onPress }, { id: 'map', label: 'Map' }]}
        value='map'
        onChange={onChange}
        label='View'
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(calls).toEqual(['press:List', 'change:list']);
  });

  it('onPress also fires when the pressed option is already the value', () => {
    const onPress = vi.fn();
    const onChange = vi.fn();
    render(<EqxSegmented options={[{ id: 'list', label: 'List', onPress }, { id: 'map', label: 'Map' }]} value='list' onChange={onChange} label='View' />);
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a label option may carry a leading icon; hud renders the same buttons', () => {
    render(
      <EqxSegmented
        hud
        options={[{ id: 'a', label: 'Fly', icon: <svg data-testid='ico' /> }, { id: 'b', label: 'Build' }]}
        value='a'
        onChange={() => {}}
        label='Mode'
      />,
    );
    expect(screen.getByRole('button', { name: 'Fly' }).contains(screen.getByTestId('ico'))).toBe(true);
    expect(screen.getByRole('button', { name: 'Build' }).getAttribute('aria-pressed')).toBe('false');
  });
  it('a text option may set its own accessible name (ariaLabel)', () => {
    render(
      <EqxSegmented
        options={[{ id: 'a', label: 'Fly', ariaLabel: 'Fly a ship' }, { id: 'b', label: 'Build' }]}
        value="a"
        onChange={() => {}}
        label="Mode"
      />,
    );
    expect(screen.getByRole('button', { name: 'Fly a ship' }).textContent).toBe('Fly');
    expect(screen.getByRole('button', { name: 'Build' })).toBeTruthy();
  });
});
