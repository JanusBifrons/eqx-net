/**
 * Galaxy map 0c — the ship-look picker in the Factions tab. Pick a colour,
 * then one of the free sigils in it; the preview is the player's own hull
 * forged in that pair by the real livery path (`shipLookPreview.ts`), and
 * "Wear this look" sends `claim_faction_look` (the verdict is a toast).
 *
 * Only free choices show: an emblem another player or faction already wears
 * in that colour is left out (`sigilChoices.ts`). The current look is marked.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, Typography } from '@mui/material';
import { useUIStore } from '../../../state/store';
import { sendClaimFactionLook } from '../../../net/tradeClient';
import { LOOK_SLOTS, lookChoices, type LookChoice } from '../../../render/art/sigilChoices';
import { PLAYER_LIVERY, factionLookVersion, packLook, teamSigilOf } from '../../../../shared-types/factions';
import { DETAIL_SX, SECTION_SX, hex } from './factionsTabStyles';

type Preview = typeof import('../../../render/art/shipLookPreview');

const TILE = 30;
const PREVIEW_H = 76;
const PREVIEW_SX = { width: '100%', height: PREVIEW_H, display: 'block', borderRadius: 1, bgcolor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' } as const;
const SWATCH_ROW_SX = { display: 'flex', flexWrap: 'wrap', gap: '4px', my: 0.75 } as const;
const GRID_SX = { display: 'grid', gridTemplateColumns: `repeat(auto-fill, ${TILE}px)`, gap: '4px', maxHeight: 4 * (TILE + 4), overflowY: 'auto', py: 0.25 } as const;
const FOOT_SX = { display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.75 } as const;
const SMALL_BTN_SX = { fontSize: 10, minWidth: 0, px: 1, py: 0 } as const;

function swatchSx(color: number, selected: boolean, current: boolean): object {
  return {
    width: 20, height: 20, p: 0, borderRadius: '50%', cursor: 'pointer', bgcolor: hex(color),
    border: selected ? '2px solid #ffffff' : '2px solid transparent',
    boxShadow: current ? '0 0 0 1px #00ff88' : 'none',
  };
}

function tileSx(selected: boolean, current: boolean): object {
  return {
    width: TILE, height: TILE, p: 0, borderRadius: 1, cursor: 'pointer', bgcolor: 'rgba(255,255,255,0.04)',
    border: selected ? '1px solid #ffffff' : current ? '1px solid #00ff88' : '1px solid rgba(255,255,255,0.08)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };
}

/** A canvas drawn once the preview module is loaded (and on `deps` change). */
function useDrawn(preview: Preview | null, draw: (p: Preview, c: HTMLCanvasElement) => void, deps: readonly unknown[]): React.RefObject<HTMLCanvasElement> {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (preview && ref.current) draw(preview, ref.current);
    // `deps` are the draw's inputs.
  }, [preview, ...deps]);
  return ref;
}

const SigilTile = memo(function SigilTile({ preview, choice, selected, onPick }: {
  preview: Preview | null; choice: LookChoice; selected: boolean; onPick: (c: LookChoice) => void;
}): JSX.Element {
  const dpr = Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
  const size = Math.round((TILE - 6) * dpr);
  const ref = useDrawn(preview, (p, c) => p.drawSigilTile(c, packLook(choice.colorSlot, choice.sigil), PLAYER_LIVERY[choice.colorSlot]!), [choice.colorSlot, choice.sigil]);
  return (
    <Box
      component="button"
      type="button"
      sx={tileSx(selected, choice.current)}
      onClick={() => onPick(choice)}
      title={choice.current ? 'Your current look' : 'Pick this sigil'}
      aria-pressed={selected}
      data-testid="faction-look-sigil"
      data-sigil={choice.sigil}
      data-current={choice.current || undefined}
    >
      <canvas ref={ref} width={size} height={size} style={{ width: TILE - 6, height: TILE - 6 }} />
    </Box>
  );
});

export const FactionLookPicker = memo(function FactionLookPicker({ playerId, knownPlayerIds, onClaimed }: {
  playerId: string | null; knownPlayerIds: readonly string[]; onClaimed: () => void;
}): JSX.Element {
  const kind = useUIStore((s) => s.selectedShipKind);
  const [preview, setPreview] = useState<Preview | null>(null);
  useEffect(() => {
    let live = true;
    void import('../../../render/art/shipLookPreview').then((m) => { if (live) setPreview(m); });
    return () => { live = false; };
  }, []);

  const version = factionLookVersion();
  const mine = playerId ? teamSigilOf(playerId) : null;
  const mySlot = mine === null ? 0 : mine >>> 12;
  const [slot, setSlot] = useState(mySlot);
  const [picked, setPicked] = useState<LookChoice | null>(null);
  const known = knownPlayerIds.join(',');
  const choices = useMemo(
    () => lookChoices(slot, playerId, knownPlayerIds),
    // Keyed on the ids' content and the claims' version.
    [slot, playerId, known, version],
  );
  const current = choices.find((c) => c.current) ?? null;
  const shown = picked && picked.colorSlot === slot ? picked : current;

  const previewRef = useDrawn(preview, (p, c) => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.max(1, Math.round(c.clientWidth * dpr));
    c.height = Math.round(PREVIEW_H * dpr);
    if (shown) p.drawShipLook(c, kind, shown.colorSlot, shown.sigil);
    else if (mine !== null) p.drawShipLook(c, kind, mine >>> 12, mine & 0xfff);
  }, [kind, shown?.colorSlot, shown?.sigil, mine]);

  const onPick = useCallback((c: LookChoice) => setPicked(c), []);
  const claim = (): void => {
    if (!picked || picked.current) return;
    if (!sendClaimFactionLook(picked.colorSlot, picked.sigil)) return;
    setPicked(null);
    setTimeout(onClaimed, 300);
  };

  return (
    <Box data-testid="faction-look-picker">
      <Typography sx={SECTION_SX}>Your ship look</Typography>
      <canvas ref={previewRef} style={PREVIEW_SX as React.CSSProperties} data-testid="faction-look-preview" />
      <Box sx={SWATCH_ROW_SX}>
        {LOOK_SLOTS.map((i) => (
          <Box
            key={i}
            component="button"
            type="button"
            sx={swatchSx(PLAYER_LIVERY[i]!, i === slot, mine !== null && i === mySlot)}
            onClick={() => setSlot(i)}
            aria-label={`Colour ${i + 1}`}
            aria-pressed={i === slot}
            data-testid="faction-look-colour"
          />
        ))}
      </Box>
      <Box sx={GRID_SX}>
        {choices.map((c) => (
          <SigilTile key={c.sigil} preview={preview} choice={c} selected={picked?.colorSlot === c.colorSlot && picked.sigil === c.sigil} onPick={onPick} />
        ))}
      </Box>
      <Box sx={FOOT_SX}>
        <Typography sx={{ ...DETAIL_SX, flex: 1 }}>
          {picked && !picked.current ? 'Preview — not yet yours' : `${choices.length} free in this colour`}
        </Typography>
        <Button size="small" sx={SMALL_BTN_SX} disabled={!playerId || !picked || picked.current} onClick={claim} data-testid="faction-look-claim">
          Wear this look
        </Button>
      </Box>
    </Box>
  );
});
