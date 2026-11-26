import { useEffect, useMemo, useState } from 'react';
import { teamColorOf, teamSigilOf } from '../../shared-types/factions';

/**
 * The loading screen's emblem: the pilot's own faction sigil (the same mark
 * their ships wear), still, with a slow shimmer sweeping across it. No RAF
 * and no timers: the sigil is rasterised ONCE per look (the shared
 * `sigilRgba`, loaded lazily like the look picker does) into a data URL
 * cached for the session; the shimmer is a CSS keyframe masked to the sigil's
 * shape. Plain DOM: its CSS (`.eqx-sigil*`, the keyframe, reduced motion)
 * lives in `WarpBriefing`'s `SIGIL_SX`.
 */

const SIGIL_PX = 160;
const cache = new Map<string, string>();

/** The sigil for `playerId` as a PNG data URL (cached per look). */
async function sigilUrl(playerId: string): Promise<string | null> {
  const packed = teamSigilOf(playerId);
  const color = teamColorOf(playerId);
  const key = `${packed}:${color}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const { sigilRgba } = await import('../render/art/sigil');
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIGIL_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(SIGIL_PX, SIGIL_PX);
  img.data.set(sigilRgba(packed, color, SIGIL_PX));
  ctx.putImageData(img, 0, 0);
  const url = canvas.toDataURL('image/png');
  cache.set(key, url);
  return url;
}

export function LoadingSigil({ playerId }: { playerId: string | null }): JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (playerId === null) { setUrl(null); return undefined; }
    let live = true;
    void sigilUrl(playerId).then((u) => { if (live) setUrl(u); }).catch(() => undefined);
    return () => { live = false; };
  }, [playerId]);
  const maskStyle = useMemo(() => {
    if (!url) return undefined;
    const mask = `url(${url}) center / contain no-repeat`;
    return { WebkitMask: mask, mask };
  }, [url]);
  return (
    <>
      {url && <img className="eqx-sigil-img" src={url} alt="" />}
      {url && <div className="eqx-sigil-shimmer" style={maskStyle} />}
    </>
  );
}
