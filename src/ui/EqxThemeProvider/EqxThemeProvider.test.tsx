import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useTheme } from '@mui/material';
import { EqxThemeProvider } from './EqxThemeProvider.js';
import { eqxTheme } from '../theme.js';

function PrimaryProbe() {
  const theme = useTheme();
  return <span data-testid="probe">{theme.palette.primary.main}</span>;
}

describe('EqxThemeProvider', () => {
  it('renders its child inside the EQX theme', () => {
    render(
      <EqxThemeProvider>
        <PrimaryProbe />
      </EqxThemeProvider>,
    );
    expect(screen.getByTestId('probe').textContent).toBe(eqxTheme.palette.primary.main);
  });
});
