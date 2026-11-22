import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EqxSection } from './EqxSection.js';

describe('EqxSection', () => {
  it('renders a section named by its heading, with its rows, and forwards data-testid', () => {
    render(<EqxSection title="Nearby" data-testid="sec"><div>row</div></EqxSection>);
    const section = screen.getByRole('region', { name: 'Nearby' });
    expect(section).toBe(screen.getByTestId('sec'));
    expect(screen.getByRole('heading', { name: 'Nearby' })).toBeTruthy();
    expect(section).toHaveTextContent('row');
  });

  it('renders the heading alone with no children', () => {
    render(<EqxSection title="Far" />);
    expect(screen.getByRole('heading', { name: 'Far' })).toBeTruthy();
  });
});
