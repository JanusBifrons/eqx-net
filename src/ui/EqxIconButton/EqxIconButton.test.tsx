import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import PublicIcon from '@mui/icons-material/Public';
import SettingsIcon from '@mui/icons-material/Settings';
import { EqxIconButton } from './EqxIconButton.js';
import { HUD } from '../../client/hud/tokens.js';

afterEach(() => {
  vi.useRealTimers();
});

function boxOf(el: HTMLElement): { w: string; h: string } {
  const cs = getComputedStyle(el);
  return { w: cs.width, h: cs.height };
}

describe('EqxIconButton', () => {
  it('renders an icon-only button whose aria-label is the tooltip', () => {
    render(<EqxIconButton icon={<PublicIcon />} tooltip="Galaxy" data-testid="ib" />);
    const b = screen.getByRole('button', { name: 'Galaxy' });
    expect(b).toBe(screen.getByTestId('ib'));
    expect(b.getAttribute('aria-label')).toBe('Galaxy');
    expect(b.textContent).toBe('');
  });

  it('has the same fixed box for any icon, from HUD.size.iconButton', () => {
    render(
      <>
        <EqxIconButton icon={<PublicIcon />} tooltip="a" data-testid="a" />
        <EqxIconButton icon={<SettingsIcon fontSize="large" />} tooltip="b" data-testid="b" />
        <EqxIconButton icon={<span>xx</span>} tooltip="c" data-testid="c" />
      </>,
    );
    const px = `${HUD.size.iconButton}px`;
    for (const id of ['a', 'b', 'c']) {
      expect(boxOf(screen.getByTestId(id))).toEqual({ w: px, h: px });
      const cs = getComputedStyle(screen.getByTestId(id));
      expect(cs.alignItems).toBe('center');
      expect(cs.justifyContent).toBe('center');
    }
  });

  it('shows the tooltip on hover', async () => {
    render(<EqxIconButton icon={<PublicIcon />} tooltip="Galaxy" />);
    fireEvent.mouseOver(screen.getByRole('button'));
    expect((await screen.findByRole('tooltip')).textContent).toBe('Galaxy');
  });

  it('shows the tooltip on long-press after holdMs', () => {
    vi.useFakeTimers();
    render(<EqxIconButton icon={<PublicIcon />} tooltip="Galaxy" holdMs={300} />);
    fireEvent.touchStart(screen.getByRole('button'));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByRole('tooltip').textContent).toBe('Galaxy');
  });

  it('calls onClick; disabled blocks it', () => {
    const onClick = vi.fn();
    const { rerender } = render(<EqxIconButton icon={<PublicIcon />} tooltip="g" onClick={onClick} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<EqxIconButton icon={<PublicIcon />} tooltip="g" onClick={onClick} disabled />);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('active switches aria-pressed', () => {
    const { rerender } = render(<EqxIconButton icon={<PublicIcon />} tooltip="g" />);
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('false');
    rerender(<EqxIconButton icon={<PublicIcon />} tooltip="g" active />);
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('true');
  });

  it('tone switches the icon colour to the tone token', () => {
    const { rerender } = render(<EqxIconButton icon={<PublicIcon />} tooltip="g" data-testid="ib" />);
    expect(screen.getByTestId('ib').dataset['tone']).toBe('secondary');
    rerender(<EqxIconButton icon={<PublicIcon />} tooltip="g" data-testid="ib" tone="danger" />);
    expect(screen.getByTestId('ib').dataset['tone']).toBe('danger');
    expect(getComputedStyle(screen.getByTestId('ib')).color).not.toBe('');
  });

  it('badge shows a count only when > 0', () => {
    const { rerender, container } = render(<EqxIconButton icon={<PublicIcon />} tooltip="g" />);
    const badge = () => container.querySelector('.MuiBadge-badge');
    expect(badge()?.className).toContain('MuiBadge-invisible');
    rerender(<EqxIconButton icon={<PublicIcon />} tooltip="g" badge={3} />);
    expect(badge()?.className).not.toContain('MuiBadge-invisible');
    expect(badge()?.textContent).toBe('3');
    rerender(<EqxIconButton icon={<PublicIcon />} tooltip="g" badge={0} />);
    expect(badge()?.className).toContain('MuiBadge-invisible');
  });

  it('variant rail: borderless rounded-square tile, cyan well and inset bar when active, badge kept', () => {
    const { rerender, container } = render(
      <EqxIconButton variant="rail" icon={<PublicIcon />} tooltip="g" badge={2} data-testid="ib" />,
    );
    const b = () => screen.getByTestId('ib');
    const cs = () => getComputedStyle(b());
    expect(boxOf(b())).toEqual({ w: `${HUD.size.railItem}px`, h: `${HUD.size.railItem}px` });
    expect(cs().borderRadius).toBe(`${HUD.rail.radius}px`);
    expect(cs().borderStyle).not.toBe('solid');
    expect(cs().boxShadow).toBe('none');
    expect(b().dataset['variant']).toBe('rail');
    expect(container.querySelector('.MuiBadge-badge')?.textContent).toBe('2');
    rerender(<EqxIconButton variant="railTool" icon={<PublicIcon />} tooltip="g" active data-testid="ib" />);
    expect(b().dataset['variant']).toBe('railTool');
    expect(b().getAttribute('aria-pressed')).toBe('true');
    expect(cs().boxShadow).toContain('inset');
  });

  it('variant round (default) keeps the outlined circle', () => {
    render(<EqxIconButton icon={<PublicIcon />} tooltip="g" data-testid="ib" />);
    expect(getComputedStyle(screen.getByTestId('ib')).borderRadius).toBe('50%');
  });
});
