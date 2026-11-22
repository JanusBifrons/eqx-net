import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EqxDropdown, type EqxDropdownOption } from './EqxDropdown.js';

const SHIPS: EqxDropdownOption[] = [
  { id: 'skiff', label: 'Skiff' },
  { id: 'barge', label: 'Barge' },
  { id: 'battleship', label: 'Battleship' },
];

describe('EqxDropdown (plain, MUI Select)', () => {
  it('renders with its label as the accessible name and forwards data-testid', () => {
    render(<EqxDropdown options={SHIPS} value="barge" onChange={() => {}} label="Ship" data-testid="dd" />);
    const box = screen.getByRole('combobox', { name: 'Ship' });
    expect(box.textContent).toBe('Barge');
    expect(screen.getByTestId('dd').contains(box)).toBe(true);
  });

  it('single pick returns the id', async () => {
    const onChange = vi.fn();
    render(<EqxDropdown options={SHIPS} value={null} onChange={onChange} label="Ship" />);
    fireEvent.mouseDown(screen.getByRole('combobox'));
    await userEvent.click(within(screen.getByRole('listbox')).getByText('Skiff'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('skiff');
  });

  it('multiple returns an array of ids', async () => {
    const onChange = vi.fn();
    render(<EqxDropdown multiple options={SHIPS} value={['skiff']} onChange={onChange} label="Ships" />);
    fireEvent.mouseDown(screen.getByRole('combobox'));
    await userEvent.click(within(screen.getByRole('listbox')).getByText('Barge'));
    expect(onChange).toHaveBeenCalledWith(['skiff', 'barge']);
  });

  it('shows the placeholder while nothing is picked', () => {
    render(<EqxDropdown options={SHIPS} value={null} onChange={() => {}} label="Ship" placeholder="Pick a ship" />);
    expect(screen.getByRole('combobox').textContent).toBe('Pick a ship');
  });
});

describe('EqxDropdown (searchable, MUI Autocomplete)', () => {
  it('filters the options by typed text', async () => {
    render(<EqxDropdown searchable options={SHIPS} value={null} onChange={() => {}} label="Ship" />);
    const input = screen.getByRole('combobox', { name: 'Ship' });
    await userEvent.click(input);
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(3);
    await userEvent.type(input, 'ba');
    const shown = within(screen.getByRole('listbox'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(shown).toEqual(['Barge', 'Battleship']);
  });

  it('single pick returns the id', async () => {
    const onChange = vi.fn();
    render(<EqxDropdown searchable options={SHIPS} value={null} onChange={onChange} label="Ship" />);
    const input = screen.getByRole('combobox');
    await userEvent.type(input, 'sk');
    await userEvent.click(screen.getByRole('option', { name: 'Skiff' }));
    expect(onChange).toHaveBeenCalledWith('skiff');
  });

  it('multiple returns an array of ids', async () => {
    const onChange = vi.fn();
    render(<EqxDropdown searchable multiple options={SHIPS} value={['barge']} onChange={onChange} label="Ships" />);
    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(screen.getByRole('option', { name: 'Skiff' }));
    expect(onChange).toHaveBeenCalledWith(['barge', 'skiff']);
  });

  it('shows the placeholder in the input', () => {
    render(
      <EqxDropdown searchable options={SHIPS} value={null} onChange={() => {}} label="Ship" placeholder="Search" />,
    );
    expect(screen.getByRole('combobox').getAttribute('placeholder')).toBe('Search');
  });
});

describe('EqxDropdown panel look (mock .field)', () => {
  it('plain and searchable are the compact filled field: no underline, no outlined notch', () => {
    render(
      <>
        <EqxDropdown options={SHIPS} value="barge" onChange={() => {}} label="Ship" data-testid="plain" />
        <EqxDropdown searchable options={SHIPS} value={null} onChange={() => {}} label="Find" data-testid="search" />
      </>,
    );
    for (const id of ['plain', 'search']) {
      const root = screen.getByTestId(id);
      expect(root.querySelector('.MuiFilledInput-root')).not.toBeNull();
      expect(root.querySelector('.MuiFilledInput-underline')).toBeNull();
      expect(root.querySelector('.MuiOutlinedInput-notchedOutline')).toBeNull();
    }
  });
});
