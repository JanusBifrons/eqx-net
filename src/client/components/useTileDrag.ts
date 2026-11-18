/**
 * Cargo pods slice 18: drag a loot-window tile onto the other grid. Pointer
 * events (touch never fires HTML5 drag events). Below `DRAG_START_PX` of
 * travel it stays a tap (the tile's click moves the stack); past it a copy of
 * the tile follows the pointer and a release over the other grid moves it.
 * The ghost moves by direct style writes: pointer-rate input never re-renders.
 */
import { useEffect, useRef } from 'react';
import { Z } from '../layout/zIndex';

export const DRAG_START_PX = 8;
export type TileSide = 'here' | 'aboard';
/** A grid a tile can be dropped on carries this attribute. */
export const DROP_SIDE_ATTR = 'data-drop-side';

interface Drag {
  side: TileSide;
  key: string;
  x0: number;
  y0: number;
  dragging: boolean;
  ghost: HTMLElement | null;
  /** Half the ghost's size: it hangs centred under the pointer. */
  half: number;
}

export interface TileDrag {
  /** Attach to a tile's onPointerDown. */
  start: (e: { clientX: number; clientY: number; currentTarget: EventTarget }, side: TileSide, key: string) => void;
  /** True right after a drag ended: the tile's click must not move it again. */
  consumeClick: () => boolean;
}

function dropSideAt(x: number, y: number): TileSide | null {
  const host = document.elementFromPoint(x, y)?.closest(`[${DROP_SIDE_ATTR}]`);
  const side = host?.getAttribute(DROP_SIDE_ATTR);
  return side === 'here' || side === 'aboard' ? side : null;
}

/** `onDrop(from, key)` runs when a tile from side `from` lands on the other side. */
export function useTileDrag(onDrop: (from: TileSide, key: string) => void): TileDrag {
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  // Built once: the window listeners must be the same functions to remove.
  const api = useRef<(TileDrag & { end: () => void }) | null>(null);
  if (api.current === null) {
    let drag: Drag | null = null;
    let dropped = false;
    const move = (e: PointerEvent): void => {
      if (drag === null) return;
      if (!drag.dragging) {
        if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < DRAG_START_PX) return;
        drag.dragging = true;
      }
      if (drag.ghost) {
        drag.ghost.style.left = `${e.clientX - drag.half}px`;
        drag.ghost.style.top = `${e.clientY - drag.half}px`;
      }
    };
    const end = (): void => {
      if (drag?.ghost) drag.ghost.remove();
      drag = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', end);
    };
    function up(e: PointerEvent): void {
      if (drag !== null && drag.dragging) {
        dropped = true;
        const to = dropSideAt(e.clientX, e.clientY);
        if (to !== null && to !== drag.side) onDropRef.current(drag.side, drag.key);
      }
      end();
    }
    const start: TileDrag['start'] = (e, side, key) => {
      end();
      dropped = false;
      let ghost: HTMLElement | null = null;
      let half = 22;
      if (e.currentTarget instanceof HTMLElement) {
        // Ignores the pointer, so the drop test sees the grid under it.
        // The tile itself, lifted and tilted, at its own size.
        half = Math.max(22, e.currentTarget.getBoundingClientRect().width / 2);
        ghost = e.currentTarget.cloneNode(true) as HTMLElement;
        ghost.removeAttribute('data-testid');
        ghost.setAttribute('data-drag-ghost', '1');
        Object.assign(ghost.style, {
          position: 'fixed', left: '-100px', top: '-100px', width: `${half * 2}px`, height: `${half * 2}px`,
          pointerEvents: 'none', opacity: '0.95', transform: 'rotate(-6deg)', boxShadow: '0 6px 18px rgba(0,0,0,0.8)', zIndex: String(Z.transit),
        });
        document.body.appendChild(ghost);
      }
      drag = { side, key, x0: e.clientX, y0: e.clientY, dragging: false, ghost, half };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', end);
    };
    const consumeClick = (): boolean => {
      const was = dropped;
      dropped = false;
      return was;
    };
    api.current = { start, consumeClick, end };
  }
  const a = api.current;
  useEffect(() => a.end, [a]);
  return a;
}
