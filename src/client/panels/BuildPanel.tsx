/**
 * The Build panel (UI language plan U2-1; was components/BuildSidebar.tsx, which
 * re-exports it): a right-hand side panel (SidePanel.tsx). It is open while the
 * store's one panel flag is `rightPanel === 'build'`, so the rail highlight, Esc,
 * the 1–9 / Q / E keys and the fire-control stand-down all read that one flag.
 * No auto-open: entering Build opens nothing; the rail's Build item opens it (a
 * second tap closes it), and so does a Build tap on the mode switch while already
 * in Build ({@link requestBuildPanel}). A vertical rail of the build
 * categories (buildCategories.tsx) runs down its LEFT edge; the active category
 * shows a grid of kind tiles (BuildKindTile.tsx, drawn by the shared HullTile).
 * A tile tap is the kind pick (`onPick` → `setPlacementKind`); BuildSidebarHost
 * mounts it and drives the flag. Under the grid, a details strip shows the
 * hovered (desktop) or last tapped kind: a locked tile's tap shows why.
 *
 * One right panel at a time: opening this clears `structureSettingsOpen`, which
 * closes the building settings panel; that panel opening announces a game
 * window, which closes this (BuildSidebarHost's onGameWindowOpen). Any other
 * rail panel replaces it (the same flag).
 *
 * Its ✕ (SidePanel draws the header; the panel covers the top-right toolbar), Esc (SidePanel) and a swipe on the
 * handle close it. The active category is local state (presentation only), kept
 * across closes so the next structure is one tap away.
 *
 * Desktop keys while open (input/buildMenuKeys.ts; they moved here from the old
 * bottom build hotbar): 1–9 pick the Nth tile of the open category (a tile click),
 * Q / E step to the previous / next category. The fire-control keys stand down
 * meanwhile, so 1–9 do not also switch weapon groups.
 *
 * Strip mode (`strip`, while placing): the same panel folds to a slim strip on
 * the right edge (BuildPlacingStrip.tsx, SidePanel BUILD_STRIP_SIZE): the picked
 * kind, a portrait tap to expand, a ✕ to cancel. No rail, no tiles, no keys.
 * It stays until U3-7 moves placing to the left strip.
 */
import { useEffect, useState } from 'react';
import { Box } from '@mui/material';
import type { StructureKindId } from '@shared-types/structureKinds';
import { buildEntry } from '@shared-types/packedStock';
import { HUD } from '../hud/tokens';
import { useUIStore } from '../state/store';
import { usePackedStock } from '../structures/usePackedStock';
import { BUILD_CATEGORIES, CATEGORY_ICON, categoryById, type BuildCategoryId } from '../components/buildCategories';
import { BuildKindDetails, BuildKindTile } from '../components/BuildKindTile';
import { BUILD_PANEL_SIZE, BUILD_STRIP_SIZE, SidePanel } from '../components/SidePanel';
import { BuildPlacingStrip } from '../components/BuildPlacingStrip';
import { WINDOW_ROOT_SX } from '../components/GameWindow';
import { buildMenuKeyAction, stepCategory } from '../input/buildMenuKeys';

/** Open the Build panel (the mode switch's Build tap while already in Build).
 *  Outside Build it opens nothing. */
export function requestBuildPanel(): void {
  const s = useUIStore.getState();
  if (s.buildMode) s.setRightPanel('build');
}

const CATEGORY_IDS: readonly BuildCategoryId[] = BUILD_CATEGORIES.map((c) => c.id);

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el?.tagName && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

export interface BuildPanelProps {
  open: boolean;
  onClose: () => void;
  onPick: (kind: StructureKindId) => void;
  /** Folded to the placing strip (only while a kind is picked; `open` wins). */
  strip?: boolean;
  /** The strip's portrait tap: back to the full sidebar. */
  onExpand?: () => void;
  /** The strip's ✕: cancel placing. */
  onCancel?: () => void;
}

export function BuildPanel({ open, onClose, onPick, strip = false, onExpand, onCancel }: BuildPanelProps): JSX.Element {
  const [category, setCategory] = useState<BuildCategoryId>(BUILD_CATEGORIES[0]!.id);
  // Stock keeps polling while placing: the keep-placing rule reads it (placementCancel.ts).
  const placingKind = useUIStore((s) => s.placementKind);
  const placing = placingKind !== null;
  const stripShown = !open && strip && placingKind !== null;
  const packedStock = usePackedStock(open || placing);
  const inSector = useUIStore((s) => s.currentSectorKey !== null); // no sector = no crate rule
  useEffect(() => {
    if (open && useUIStore.getState().structureSettingsOpen) useUIStore.setState({ structureSettingsOpen: false });
  }, [open]);
  const [shown, setShown] = useState<StructureKindId | null>(null);
  const cat = categoryById(category);
  const shownKind = shown !== null && cat.kinds.includes(shown) ? shown : null;
  // 1–9 / Q / E while open (see the header): the old hotbar's number-key path.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.repeat || e.altKey || e.ctrlKey || e.metaKey || isTyping(e.target)) return;
      const a = buildMenuKeyAction(e.key, e.code);
      if (!a) return;
      e.preventDefault();
      if (a.kind === 'step') {
        setCategory(stepCategory(CATEGORY_IDS, category, a.delta));
        return;
      }
      const k = cat.kinds[a.index];
      if (k === undefined) return;
      setShown(k);
      if (!buildEntry(k, packedStock, inSector).locked) onPick(k);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, category, cat, packedStock, inSector, onPick]);
  if (stripShown) {
    return (
      <SidePanel open onClose={onClose} testId="build-sidebar" size={BUILD_STRIP_SIZE}
        paperAttrs={{ 'data-open': '0', 'data-mode': 'strip' }}>
        <BuildPlacingStrip kind={placingKind} onExpand={onExpand ?? noop} onCancel={onCancel ?? noop} />
      </SidePanel>
    );
  }
  return (
    <SidePanel open={open} onClose={onClose} testId="build-sidebar" size={BUILD_PANEL_SIZE} closeOnEscape
      paperAttrs={{ 'data-open': open ? '1' : '0', 'data-mode': 'full' }} title="Build" headerTestId="build-sidebar-head"
      closeTestId="build-sidebar-close" body="bare">
      {open && (
        <Box sx={WINDOW_ROOT_SX}>
          <Box sx={BODY_SX}>
            <Box sx={RAIL_SX} role="tablist" aria-orientation="vertical" data-testid="build-rail">
              {BUILD_CATEGORIES.map((c) => (
                <Box key={c.id} component="button" type="button" role="tab" aria-selected={c.id === category}
                  aria-label={c.label} title={c.label} data-testid={`build-cat-${c.id}`}
                  sx={c.id === category ? RAIL_BTN_ACTIVE_SX : RAIL_BTN_SX} onClick={() => setCategory(c.id)}>
                  {CATEGORY_ICON[c.id]}
                </Box>
              ))}
            </Box>
            <Box sx={KINDS_COL_SX}>
              <Box sx={KINDS_SX} data-testid="build-kinds" data-category={category}>
                <Box sx={CAT_LABEL_SX}>{cat.label}</Box>
                <Box sx={GRID_SX}>
                  {cat.kinds.map((k) => (
                    <BuildKindTile key={k} kindId={k} entry={buildEntry(k, packedStock, inSector)} onPick={onPick}
                      onShow={setShown} selected={k === shownKind} />
                  ))}
                </Box>
              </Box>
              <BuildKindDetails kindId={shownKind} entry={shownKind === null ? null : buildEntry(shownKind, packedStock, inSector)} />
            </Box>
          </Box>
        </Box>
      )}
    </SidePanel>
  );
}

const noop = (): void => {};
const C = HUD.color;
const RAIL_ICON_PX = 40;
const BODY_SX = { flex: '1 1 auto', minHeight: 0, display: 'flex' } as const;
// The rail scrolls when the categories do not fit the panel's height.
const RAIL_SX = {
  flex: 'none', display: 'flex', flexDirection: 'column', gap: '4px', p: '6px 4px',
  overflowY: 'auto', overscrollBehavior: 'contain', borderRight: `1px solid ${C.panelEdge}`,
} as const;
const RAIL_BTN_SX = {
  flex: 'none', width: RAIL_ICON_PX, height: RAIL_ICON_PX, display: 'flex', alignItems: 'center', justifyContent: 'center',
  p: 0, cursor: 'pointer', color: C.inkDim, bgcolor: 'transparent', border: '1px solid transparent', borderRadius: '4px',
  '&:hover': { color: C.ink, bgcolor: 'rgba(255,255,255,0.06)' },
} as const;
const RAIL_BTN_ACTIVE_SX = { ...RAIL_BTN_SX, color: C.auto, borderColor: C.autoGlow, bgcolor: 'rgba(52,216,255,0.12)' } as const;
const KINDS_COL_SX = { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column' } as const;
const KINDS_SX = { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', p: 1 } as const;
const CAT_LABEL_SX = {
  color: C.inkDim, fontSize: 11, fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', mb: 0.75,
  fontFamily: HUD.font.label,
} as const;
const GRID_SX = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: '6px' } as const;
