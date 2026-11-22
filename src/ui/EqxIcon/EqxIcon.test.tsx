import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EqxIcon } from './EqxIcon.js';
import { EQX_ICONS, EQX_ICON_NAMES, type EqxIconName } from '../icons.js';
import { HUD } from '../../client/hud/tokens.js';

describe('EqxIcon registry', () => {
  it('every name resolves to a component, and the registry has no extra keys', () => {
    for (const name of EQX_ICON_NAMES) {
      const c: unknown = EQX_ICONS[name];
      expect(c, name).toBeTruthy();
      expect(['function', 'object'], name).toContain(typeof c);
    }
    expect(Object.keys(EQX_ICONS).sort()).toEqual([...EQX_ICON_NAMES].sort());
  });

  it('one icon means one thing: no two names share a component', () => {
    const owner = new Map<unknown, EqxIconName>();
    for (const name of EQX_ICON_NAMES) {
      const c = EQX_ICONS[name];
      expect(owner.get(c), `${name} shares its icon with ${String(owner.get(c))}`).toBeUndefined();
      owner.set(c, name);
    }
    expect(owner.size).toBe(EQX_ICON_NAMES.length);
  });

  it('lists the brief names (orders, stances, actions, rail items, sections)', () => {
    const required: readonly EqxIconName[] = [
      'defend', 'patrol', 'hunt', 'escort', 'retreat', 'defensive', 'aggressive', 'holdFire',
      'stop', 'trade', 'target', 'build', 'rotate', 'mirror', 'confirm', 'cancel', 'undo',
      'cog', 'close', 'back', 'contacts', 'hold', 'fleet', 'galaxy', 'jobs', 'faction',
      'details', 'orders', 'route', 'power',
    ];
    for (const n of required) expect(EQX_ICON_NAMES).toContain(n);
  });
});

describe('EqxIcon', () => {
  it('renders an svg for every name', () => {
    for (const name of EQX_ICON_NAMES) {
      const { container, unmount } = render(<EqxIcon name={name} />);
      const svg = container.querySelector('svg');
      expect(svg, name).not.toBeNull();
      expect(svg?.getAttribute('data-icon')).toBe(name);
      unmount();
    }
  });

  it('takes its size from HUD.size.iconGlyph (medium by default)', () => {
    render(
      <>
        <EqxIcon name="patrol" data-testid="d" />
        <EqxIcon name="patrol" size="small" data-testid="s" />
        <EqxIcon name="patrol" size="large" data-testid="l" />
      </>,
    );
    const cases = [['d', HUD.size.iconGlyph.medium], ['s', HUD.size.iconGlyph.small], ['l', HUD.size.iconGlyph.large]] as const;
    for (const [id, px] of cases) {
      const cs = getComputedStyle(screen.getByTestId(id));
      expect(cs.width).toBe(`${px}px`);
      expect(cs.height).toBe(`${px}px`);
    }
  });

  it('is decorative by default and named when given a title', () => {
    render(
      <>
        <EqxIcon name="galaxy" data-testid="hidden" />
        <EqxIcon name="galaxy" title="Galaxy" data-testid="named" />
      </>,
    );
    expect(screen.getByTestId('hidden').getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('img', { name: 'Galaxy' })).toBe(screen.getByTestId('named'));
  });
});
