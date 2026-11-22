/**
 * The compact building card stays inside its border at the capped width
 * (NARROW_W: the old selection card's 179 px on a sideways Pixel 7). A Pixel 7 still showed the
 * shipyard's "NEEDS A BLUEPRINT" chip and its "making" slot, and the solar
 * plant's "you" owner label, running past the card's right edge.
 *
 * jsdom does no layout, so this locks the style contract that keeps each
 * element shrinkable: min-width 0, no wrap, hidden overflow, ellipsis.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Box } from '@mui/material';
import { StructureCardRows, type StructureCardData } from './structureCard.js';
import { CARD_MAX_W, EntityStatsPanel } from './EntityStatsPanel.js';
import { applySelectionStats, resetSelectionStats } from '../net/selectionStats.js';
import { useUIStore } from '../state/store.js';
import { RECIPES, type RecipeId } from '@shared-types/recipes';

/** A narrow width the card rows must fit (the old top-centre card on a sideways Pixel 7). */
const NARROW_W = '179px';
const RECIPE = Object.keys(RECIPES)[0] as RecipeId;

function renderCard(d: StructureCardData): void {
  render(<Box sx={{ maxWidth: NARROW_W, display: 'grid', gridTemplateColumns: 'auto auto' }}><StructureCardRows d={d} /></Box>);
}

function expectEllipsis(el: HTMLElement): void {
  const s = getComputedStyle(el);
  expect(s.minWidth).toBe('0px');
  expect(s.overflow).toBe('hidden');
  expect(s.textOverflow).toBe('ellipsis');
  expect(s.whiteSpace).toBe('nowrap');
}

describe('structure card overflow guards', () => {
  it('a shipyard with a long status chip and a queue slot keeps every element shrinkable', () => {
    renderCard({
      name: 'Shipyard', hpPct: 100, level: 1, owner: 'you', selfPower: -5, powered: false, built: true,
      prodStatus: 'Needs a blueprint', makes: true, recipe: RECIPE, prodPct: 40,
    });
    // The row wraps (the chip drops to its own line) and never outgrows the card.
    const row = getComputedStyle(screen.getByTestId('entity-stats-card'));
    expect(row.flexWrap).toBe('wrap');
    expect(row.minWidth).toBe('0px');
    expect(row.maxWidth).toBe('100%');
    // The head line (badge .. power) shrinks; its name ellipsizes.
    const head = getComputedStyle(screen.getByTestId('entity-stats-card-head'));
    expect(head.minWidth).toBe('0px');
    expect(head.maxWidth).toBe('100%');
    expectEllipsis(screen.getByTestId('entity-stats-name'));
    // The status chip is capped at the card width and ellipsizes past it.
    const chip = screen.getByTestId('entity-stats-status');
    expect(chip.textContent).toBe('Needs a blueprint');
    expectEllipsis(chip);
    expect(getComputedStyle(chip).maxWidth).toBe('100%');
    // The owner takes only the space left (basis 0) and ellipsizes.
    const owner = screen.getByTestId('entity-stats-owner');
    expectEllipsis(owner);
    expect(getComputedStyle(owner).flexBasis).toMatch(/^0(px|%)?$/);
    expect(getComputedStyle(owner).flexGrow).toBe('1');
    // The mini queue slot fits the card; its label ellipsizes.
    const slot = screen.getByTestId('entity-stats-making');
    expect(getComputedStyle(slot).minWidth).toBe('0px');
    expect(getComputedStyle(slot).maxWidth).toBe('100%');
    expectEllipsis(slot.querySelector('span') as HTMLElement);
  });
});
