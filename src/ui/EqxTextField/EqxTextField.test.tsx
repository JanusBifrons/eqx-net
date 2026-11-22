import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { EqxTextField } from './EqxTextField.js';

describe('EqxTextField', () => {
  it('renders its label as the accessible name and forwards data-testid', () => {
    render(<EqxTextField label="Callsign" value="Vega" onChange={() => {}} data-testid="tf" />);
    const input = screen.getByRole('textbox', { name: 'Callsign' });
    expect(input).toHaveProperty('value', 'Vega');
    expect(screen.getByTestId('tf').contains(input)).toBe(true);
  });

  it('onChange receives the typed text', () => {
    const onChange = vi.fn();
    render(<EqxTextField label="Callsign" value="" onChange={onChange} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Orion' } });
    expect(onChange).toHaveBeenCalledWith('Orion');
  });

  it('error switches the error state and shows the message', () => {
    const { rerender } = render(<EqxTextField label="A" value="" onChange={() => {}} data-testid="tf" />);
    expect(screen.getByTestId('tf').dataset['error']).toBe('false');
    expect(screen.getByRole('textbox').getAttribute('aria-invalid')).toBe('false');
    rerender(<EqxTextField label="A" value="" onChange={() => {}} data-testid="tf" error="Name taken" />);
    expect(screen.getByTestId('tf').dataset['error']).toBe('true');
    expect(screen.getByRole('textbox').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Name taken')).toBeTruthy();
  });

  it('onBlur fires when focus leaves; inputMode picks the keyboard', () => {
    const onBlur = vi.fn();
    render(<EqxTextField label="X" value="1" onChange={() => {}} onBlur={onBlur} inputMode="decimal" />);
    const input = screen.getByRole('textbox');
    expect(input.getAttribute('inputmode')).toBe('decimal');
    fireEvent.blur(input);
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it('disabled blocks input', () => {
    render(<EqxTextField label="A" value="" onChange={() => {}} disabled />);
    expect(screen.getByRole('textbox')).toHaveProperty('disabled', true);
  });
});
