import type { Camera } from '../worker/Camera';
import type { FleetOverlayModel, FleetOverlayShip, FleetPickKindWire, RenderMirror, RendererFeedback } from '@core/contracts/IRenderer';
import type { GalaxyMapLayer } from '../galaxy/GalaxyMapLayer';
import { resolveSelectable, type SelectableTarget, type SelectionBracket } from '../SelectionBracket';
import { fingerSlopWorld, onCraneBayPad, pickEntityAt, TAP_SLOP, type PickedEntityKind } from '../pickEntity';
import { CommandPointerRouter, type BoxRect, type HoldArmed, type RouterAction, type RouterPointerEvent } from '../input/commandPointerRouter.js';
import { decideTapAction } from '../input/tapAction.js';
import { DoubleTapTracker } from '../input/doubleTap.js';
import { createFleetPickState, decidePickTap, pickAddPoint, pickFinishPatrol, pickStart, pickUndoPoint, type FleetPickResult } from '../input/fleetPick.js';
import { applySelection, boxSelectOwn, collectFleetShips, focusSurvives, isMine, isOwnShipPresent, isOwnStructure, pickOwnShipAt, sameSelection, tapSelectOwn } from '../fleetSelection.js';
import type { FleetOverlay, OrderFlash } from '../FleetOverlay.js';
import { isParkedHull } from '../shipOwnership.js';

/**
 * What the input controller reads from the renderer: a live getter view built
 * once by PixiRenderer (the camera, overlays and galaxy layer are assigned in
 * `init`; the mirror changes every frame), so reads allocate nothing.
 */
export interface RendererInputDeps {
  readonly camera: Camera;
  readonly lastMirror: RenderMirror | null;
  readonly galaxyLayer: GalaxyMapLayer | null;
  readonly feedback: RendererFeedback;
  readonly selectionBracket: SelectionBracket | null;
  readonly fleetOverlay: FleetOverlay | null;
}

/**
 * RTS command routing and THE selection for PixiRenderer (the base of
 * `RendererInputController`): placement pointer state, drag-select, command
 * taps and orders, fleet picks, gameplay tap / hover and the selection
 * (ships + focus + hover). The camera half of a gesture is the subclass's.
 */
export abstract class RendererCommandRouting {
  constructor(protected readonly deps: RendererInputDeps) {}

  protected get camera(): Camera { return this.deps.camera; }
  protected get _lastMirror(): RenderMirror | null { return this.deps.lastMirror; }
  protected get _galaxyLayer(): GalaxyMapLayer | null { return this.deps.galaxyLayer; }
  protected get feedback(): RendererFeedback { return this.deps.feedback; }
  protected get selectionBracket(): SelectionBracket | null { return this.deps.selectionBracket; }
  protected get fleetOverlay(): FleetOverlay | null { return this.deps.fleetOverlay; }

  /** Tap/drag-to-position placement state (2026-06-07). `_placementActive` is
   *  set each frame from `mirror.pendingPlacementPreview`. While active, canvas
   *  pointer events position the blueprint ghost (game-space) instead of
   *  panning the camera. `_placementChosenX/Y` is the chosen GAME point (null =
   *  not yet positioned → fall back to the ahead-of-ship preview).
   *  `_placementFollowing` true ⇒ the ghost tracks the pointer (desktop hover /
   *  mobile drag); set false on pointer-up so the ghost parks and the Confirm
   *  banner appears. */
  _placementActive = false;
  _placementFollowing = true;
  _placementChosenX: number | null = null;
  _placementChosenY: number | null = null;
  /**
   * RTS command view (slice 13a). Enabled while spectating (command mode);
   * decides what a pointer gesture means (camera / box / tap-select / order).
   */
  private readonly _cmdRouter = new CommandPointerRouter(false);
  /** Own-ship fleet selection (ids per the pick convention). Replaced (never
   *  mutated) on a gesture; pruned in place in `update()` when a ship leaves. */
  _selShips: Set<string> = new Set();
  /** RTS slice 10: double tap / click on an own parked ship = take the controls. */
  private readonly _doubleTap = new DoubleTapTracker();
  /** Drag box in screen px while a box gesture is live (reused object). */
  private readonly _fleetBoxRect: BoxRect = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private _fleetBoxActive = false;
  private readonly _orderFlash: OrderFlash = { x: 0, y: 0, attack: false, t0: -1 };
  /** The focus's pose for `attackFocus` (reused). */
  private readonly _focusPose: SelectableTarget = { x: 0, y: 0, r: 0, hw: 0, hh: 0 };
  /** "Pick on the map" for move / patrol / escort / retreat (slice 14b; move
   *  is tap rule T3). While a
   *  kind is set, map taps go here and never change the selection. */
  private readonly _fleetPick = createFleetPickState();
  /** Own ships' squads + orders by id (slice 15a), replaced on each
   *  `setFleetOverlayModel` (main-thread fleet status version change). */
  private _fleetModel: Map<string, FleetOverlayShip> = new Map();
  private readonly _squadOf = (id: string): string | null | undefined => this._fleetModel.get(id)?.squadId;
  /** Hold-to-box cue scratch (reused per frame). */
  private readonly _holdArmed: HoldArmed = { x: 0, y: 0, armedMs: 0 };
  private readonly _fleetProject = (wx: number, wy: number, out: { x: number; y: number }): void => {
    this.camera.toScreenInto(wx, wy, out);
  };
  /**
   * Click-to-inspect selection (structures follow-up Item B2). The renderer
   * OWNS the selected entity — set on a gameplay tap that resolves to an
   * entity, toggled off on a re-tap of the SAME entity, cleared on an
   * empty-space tap. Published each frame via `feedback.selectedPickId/Kind`
   * (the main thread mirrors it into Zustand for panel visibility). The id form
   * matches the `HealthBarManager`/`SelectionBracket` lookup convention.
   */
  _focusId: string | null = null;
  _focusKind: PickedEntityKind | null = null;
  /** WS-10 (R2.4) — the entity the desktop pointer is HOVERING over (set from
   *  pointer-move via `pickEntityAt`). Renderer-local, NEVER Zustand (updates at
   *  move cadence — invariant #2). Drives the lighter `HoverBracket` outline. */
  _hoveredId: string | null = null;

  /** Command view routes pointers through the router (never over the galaxy
   *  overlay, whose taps stay warp taps; placement is routed before this). */
  protected commandRoutingActive(): boolean {
    return this._cmdRouter.enabled && !this.galaxyTapSuppressed() && !this._placementActive;
  }

  /** Build mode (placement in the Command view): the router may take a touch
   *  gesture; `routerBusy` = it already owns one (a pinch's second finger). */
  protected buildRouterReady(): boolean {
    return this._cmdRouter.enabled && !this.galaxyTapSuppressed();
  }
  protected buildRouterBusy(): boolean { return !this._cmdRouter.idle; }

  protected routeCommandPointer(
    type: string, pointerId: number, x: number, y: number, stamp: number,
    button: number, buttons: number, shiftKey: boolean, pointerType: string,
  ): void {
    if (type === 'pointerleave') {
      // Not a router event: a leave after a lift is noise, and a live gesture
      // keeps going (the DOM path captures the pointer in command view).
      return;
    }
    if (type !== 'pointerdown' && type !== 'pointermove' && type !== 'pointerup' && type !== 'pointercancel') return;
    // Allocated per input event (not a frame-loop path): the router keeps the
    // down event of a gesture by reference.
    const ev: RouterPointerEvent = { type, pointerId, button, buttons, x, y, shiftKey, pointerType, timeMs: stamp };
    const actions = this._cmdRouter.handle(ev);
    for (let i = 0; i < actions.length; i++) this.applyRouterAction(actions[i]!);
  }

  private applyRouterAction(a: RouterAction): void {
    // Build mode: a pan/pinch stays the camera's; a tap moves the ghost there;
    // a hold-box is neither drawn nor selects while placing.
    if (this._placementActive && a.kind !== 'camera') {
      if (a.kind === 'tapSelect') this.placementTap(a.x, a.y, a.pointerType);
      return;
    }
    if (this._fleetPick.kind !== null && a.kind !== 'camera') {
      this.applyPickRouterAction(a);
      return;
    }
    switch (a.kind) {
      case 'camera':
        this.cameraPointer(a.ev.type, a.ev.pointerId, a.ev.x, a.ev.y, a.ev.timeMs, a.ev.pointerType);
        return;
      case 'boxStart':
      case 'boxUpdate':
        this._fleetBoxRect.x0 = a.x0; this._fleetBoxRect.y0 = a.y0;
        this._fleetBoxRect.x1 = a.x1; this._fleetBoxRect.y1 = a.y1;
        this._fleetBoxActive = true;
        return;
      case 'boxCancel':
        this._fleetBoxActive = false;
        return;
      case 'boxEnd':
        this._fleetBoxActive = false;
        this.commandBoxSelect(a.x0, a.y0, a.x1, a.y1, a.additive);
        return;
      case 'tapSelect':
        this.commandTap(a.x, a.y, a.additive, a.pointerType);
        return;
      case 'order':
        this.commandOrder(a.x, a.y);
        return;
    }
  }

  /**
   * Router actions while a fleet pick is on (slice 14b): a tap (or a box
   * gesture's end, which a finger easily makes) is a pick, never a selection;
   * a mouse right-click is Done for a patrol and a pick otherwise. Boxes are
   * not drawn.
   */
  private applyPickRouterAction(a: RouterAction): void {
    switch (a.kind) {
      case 'tapSelect':
      case 'order':
        if (a.kind === 'order' && this._fleetPick.kind === 'patrol') {
          this.commitFleetPick();
          return;
        }
        this.pickTap(a.x, a.y, a.kind === 'tapSelect' ? a.pointerType : 'mouse');
        return;
      case 'boxStart':
      case 'boxUpdate':
      case 'boxCancel':
      case 'boxEnd':
        this._fleetBoxActive = false;
        return;
      case 'camera':
        return;
    }
  }

  /** Pick slop for a tap: a mouse keeps the world-unit {@link TAP_SLOP}; a
   *  finger (touch / pen) gets a fingertip's screen reach at this zoom. */
  protected tapSlop(pointerType: string): number {
    return pointerType === 'mouse' ? TAP_SLOP : fingerSlopWorld(this.camera.scale.x);
  }

  /** A map tap during a fleet pick (`decidePickTap`). */
  private pickTap(screenX: number, screenY: number, pointerType: string): void {
    const m = this._lastMirror;
    if (m === null) return;
    const w = this.camera.screenToWorld(screenX, screenY);
    const gx = w.x;
    const gy = -w.y;
    const pick = this._fleetPick;
    const own = pick.kind === 'escort'
      ? pickOwnShipAt(gx, gy, collectFleetShips(m), m.localPlayerId, this.tapSlop(pointerType))
      : null;
    switch (decidePickTap(pick.kind, own, own !== null && this._selShips.has(own), pick.count)) {
      case 'addPoint':
        pickAddPoint(pick, gx, gy);
        this.feedback.fleetPickPoints = pick.count;
        return;
      case 'retreatHere':
        this.publishPickResult({ kind: 'retreat', x: gx, y: gy });
        return;
      case 'moveHere':
        // Tap rule T3: a move order (the right-click path), never a pick
        // result. The pick ends here; gameRafLoop ends the Zustand pick.
        pickStart(pick, null);
        this.feedback.fleetPickPoints = 0;
        this.publishOrder(gx, gy, null);
        return;
      case 'escortShip':
        this.publishPickResult({ kind: 'escort', escortId: own! });
        return;
      case 'ignore':
        return;
    }
  }

  /** End the pick and hand its result to the main thread (sent once per seq). */
  private publishPickResult(result: FleetPickResult): void {
    pickStart(this._fleetPick, null);
    const fb = this.feedback;
    fb.fleetPickPoints = 0;
    fb.fleetPickResult = result;
    fb.fleetPickSeq++;
  }

  /** Box (screen px) → own ships whose centre is inside it (game space). */
  private commandBoxSelect(x0: number, y0: number, x1: number, y1: number, additive: boolean): void {
    const m = this._lastMirror;
    if (m === null) return;
    const a = this.camera.screenToWorld(x0, y0);
    const b = this.camera.screenToWorld(x1, y1);
    const hits = boxSelectOwn(a.x, -a.y, b.x, -b.y, collectFleetShips(m), m.localPlayerId, this._squadOf);
    // The focus stays if it is one of the selected ships or not mine.
    this.setSelection(applySelection(this._selShips, hits, additive), this._focusId, this._focusKind);
  }

  /** Command-view tap: an own ship selects it (whole squad, below); any other
   *  tap goes to {@link handleGameplayTap} (`decideTapAction`: focus a
   *  not-mine entity keeping the ships, deselect on free space). A tap is
   *  never an order: orders stay on right-click. A finger gets a fingertip's
   *  screen reach at this zoom (zoomed out, 24 world units is a pixel or two). */
  private commandTap(screenX: number, screenY: number, additive: boolean, pointerType: string): void {
    const m = this._lastMirror;
    if (m === null) return;
    const w = this.camera.screenToWorld(screenX, screenY);
    const gx = w.x;
    const gy = -w.y;
    const fleet = collectFleetShips(m);
    const slop = this.tapSlop(pointerType);
    const own = pickOwnShipAt(gx, gy, fleet, m.localPlayerId, slop);
    // RTS slice 10: a second tap on the same own PARKED ship (not the active
    // one, which is flown already) takes its controls. Any other tap breaks
    // the pair.
    const parked = own !== null && own !== m.localPlayerId ? own : null;
    // eslint-disable-next-line no-restricted-properties -- real time: pointer stamps are Date.now() (both paths)
    if (this._doubleTap.tap(parked, Date.now(), screenX, screenY)) {
      this.feedback.takeControlsId = parked;
      this.feedback.takeControlsSeq++;
      return;
    }
    if (own === null) {
      this.handleGameplayTap(screenX, screenY, slop, additive, pointerType);
      return;
    }
    // Slice 15a: whole squad; a tap on an exactly-selected squad narrows.
    // The tapped ship becomes the focus (its details panel); shift-tapping
    // it off keeps the old focus if that is still selected.
    const next = tapSelectOwn(this._selShips, own, additive, fleet, m.localPlayerId, this._squadOf);
    if (next.has(own)) {
      const entry = m.ships.get(own);
      this.setSelection(next, own, entry !== undefined && isParkedHull(m, own, entry) ? 'lingering' : 'ship');
    } else {
      this.setSelection(next, this._focusId, this._focusKind);
    }
  }

  /** Not own (ship or structure), not an asteroid or a cargo pod (shots pass
   *  pods): something the fleet can be told to attack. An own structure under
   *  the finger / cursor falls back to a move order. */
  private isAttackable(id: string, kind: string, m: RenderMirror): boolean {
    if (kind === 'structure') return !isOwnStructure(id, m);
    return kind !== 'asteroid' && kind !== 'pod' && !this._selShips.has(id) && !isOwnShipPresent(id, m);
  }

  /** Command-view right-click: attack a non-own entity under the cursor, else
   *  move to the point. Needs a selection. */
  private commandOrder(screenX: number, screenY: number): void {
    const m = this._lastMirror;
    if (m === null || this._selShips.size === 0) return;
    const w = this.camera.screenToWorld(screenX, screenY);
    const gx = w.x;
    const gy = -w.y;
    const hit = pickEntityAt(gx, gy, m);
    this.publishOrder(gx, gy, hit !== null && this.isAttackable(hit.id, hit.kind, m) ? hit.id : null);
  }

  /** See `IFleetView.attackFocus`: the strip Lock / T key. The same attack
   *  order a right-click on the focus gives (flash on it); a no-op without
   *  ships, without a focus, or for a focus that is mine or not attackable. */
  attackFocus(): void {
    const m = this._lastMirror;
    const id = this._focusId;
    const kind = this._focusKind;
    if (m === null || id === null || kind === null || this._selShips.size === 0) return;
    if (isMine(id, m) || !this.isAttackable(id, kind, m) || !resolveSelectable(m, id, this._focusPose)) return;
    this.publishOrder(this._focusPose.x, this._focusPose.y, id);
  }

  /** Publish an order via feedback (`gameRafLoop` sends it once per seq):
   *  attack `targetId`, or move to (gx, gy) game space when null. */
  private publishOrder(gx: number, gy: number, targetId: string | null): void {
    const attack = targetId !== null;
    const fb = this.feedback;
    fb.orderKind = attack ? 'attack' : 'move';
    fb.orderTargetId = targetId;
    fb.orderX = gx;
    fb.orderY = gy;
    fb.orderSeq++;
    this._orderFlash.x = gx;
    this._orderFlash.y = gy;
    this._orderFlash.attack = attack;
    // eslint-disable-next-line no-restricted-properties -- real time: the order flash is UI
    this._orderFlash.t0 = performance.now();
  }

  /**
   * THE selection (RTS Part A: one selection concept): the selected ships
   * (`_selShips`, each gets the same `SelectionBracket` marker) and the focus
   * (`_focusId/_focusKind`, the entity whose details panel shows: the one you
   * clicked). Rule (`focusSurvives`): with ships selected, the focus is one of
   * them, something that is NOT mine (an enemy you tapped: the ships stay
   * selected, the left strip shows it), or null; with none it can be anything
   * you tapped. Publishes the ship set only when it changed; the focus is
   * published every frame in `update()`.
   */
  setSelection(nextShips: Set<string>, focusId: string | null, focusKind: PickedEntityKind | null): void {
    const m = this._lastMirror;
    const keepFocus = focusSurvives(nextShips, focusId, focusId !== null && m !== null && isMine(focusId, m));
    this._focusId = keepFocus ? focusId : null;
    this._focusKind = keepFocus ? focusKind : null;
    if (sameSelection(this._selShips, nextShips)) return;
    this._selShips = nextShips;
    this.publishFleetSelection();
  }

  /** Focus an entity (a tap). Focusing one of MY ships or structures that is
   *  not a selected ship ends the ship selection; focusing something that is
   *  not mine keeps the ships (the rule in {@link setSelection}). */
  private setFocus(id: string | null, kind: PickedEntityKind | null): void {
    const m = this._lastMirror;
    const endsShips = id !== null && this._selShips.size > 0 && !this._selShips.has(id) && m !== null && isMine(id, m);
    this.setSelection(endsShips ? new Set() : this._selShips, id, kind);
  }

  /**
   * Per frame: drop selected ids that are no longer own ships in the mirror
   * (in place, no allocation unless one went); a dropped focus goes with them.
   * The markers and the overlay are drawn in the ticker, after this frame's
   * camera tick.
   */
  updateFleetSelection(mirror: RenderMirror): void {
    if (this._selShips.size > 0) {
      let pruned = false;
      for (const id of this._selShips) {
        if (!isOwnShipPresent(id, mirror)) {
          this._selShips.delete(id);
          if (id === this._focusId) {
            this._focusId = null;
            this._focusKind = null;
          }
          pruned = true;
        }
      }
      if (pruned) this.publishFleetSelection();
    }
  }

  /**
   * Redraw the selection markers and the command-view overlay (box, order
   * lines, flash, hold cue, pick route). Runs in the Pixi ticker AFTER
   * `camera.tick`, right before the frame renders, so both project through
   * the SAME camera transform the world is drawn with this frame. The overlay
   * used to run inside `update()`, i.e. with the camera as it stood BEFORE
   * this frame's tick: during a pan or a glide every marker sat a frame of
   * camera motion (~20 px) off its ship and the ships "snapped into" them
   * when the camera stopped (RTS review 2026-11-14; lock
   * `tests/e2e/fleet-overlay-camera.spec.ts`).
   */
  drawFleetOverlay(): void {
    const mirror = this._lastMirror;
    if (mirror === null) return;
    this.selectionBracket?.draw(mirror, this._selShips, this._focusId, this._fleetProject, this.camera.scale.x);
    if (this.fleetOverlay === null) return;
    this.fleetOverlay.update(
      mirror,
      this._selShips,
      this._fleetBoxActive ? this._fleetBoxRect : null,
      this._orderFlash,
      // eslint-disable-next-line no-restricted-properties -- real time: the selection overlay is UI
      performance.now(),
      this._fleetProject,
      // eslint-disable-next-line no-restricted-properties -- real time: pointer stamps are Date.now() (both paths)
      this._cmdRouter.holdArmedAt(Date.now(), this._holdArmed),
      this._fleetModel,
      this._fleetPick,
    );
  }

  publishFleetSelection(): void {
    // Allocates on a selection change only (a gesture or a ship leaving).
    this.feedback.fleetSelIds = Array.from(this._selShips);
    this.feedback.fleetSelSeq++;
  }

  /**
   * Click-to-inspect (Item B2) and THE tap rule (`decideTapAction`; Command,
   * Fly and Build alike). A confirmed gameplay tap (NOT a drag) resolves to
   * the nearest entity under the tap via the pure `pickEntityAt` (`slop`: a
   * finger passes `fingerSlopWorld`). The renderer OWNS the selection:
   *   - tap empty space        → clear the focus; with ships selected, clear
   *                              them too (deselect; shift keeps them)
   *   - tap a new entity       → focus it (a not-mine one keeps the ships)
   *   - re-tap the SAME entity → toggle the focus off (ships kept)
   * The result is published each frame in `feedback.selectedPickId/Kind`.
   *
   * Gated by the callers on `!galaxyTapSuppressed() && !_placementActive` so it
   * never cross-fires with the galaxy selector/overlay or blueprint placement.
   * `screenX/Y` are canvas-relative pixels; `screenToWorld` returns pixi-world
   * coords (y = -gameY), so the pick runs in GAME space.
   */
  protected handleGameplayTap(screenX: number, screenY: number, slop = TAP_SLOP, additive = false, pointerType = 'mouse'): void {
    const m = this._lastMirror;
    if (m === null) return;
    const w = this.camera.screenToWorld(screenX, screenY);
    const gameX = w.x;
    const gameY = -w.y;
    // A crane bay pad is open space to park on: a tap there is a course even
    // when a parked hull or the host's tap slop overlaps it (phone film, base
    // loop: pad taps went nowhere). The host's body still opens its card.
    const hit = onCraneBayPad(gameX, gameY, m) ? null : pickEntityAt(gameX, gameY, m, slop);
    const action = decideTapAction({
      pointerType,
      hitOwn: hit !== null && isOwnShipPresent(hit.id, m),
      hitEntity: hit !== null,
      hasSelection: this._selShips.size > 0,
      additive,
    });
    if (hit === null) {
      if (action === 'deselect') this.setSelection(new Set(), null, null);
      else this.setFocus(null, null);
      // Helm orders: the pilot's tap on empty space sets the course (every
      // hull: the autopilot, navigation slice 13).
      if (m.localPlayerId !== null && m.ships.has(m.localPlayerId)) {
        this.feedback.helmCourseX = gameX;
        this.feedback.helmCourseY = gameY;
        this.feedback.helmCourseSeq++;
      }
    } else if (hit.id === this._focusId) {
      this.setFocus(null, null); // re-tap toggles off
    } else {
      this.setFocus(hit.id, hit.kind);
    }
  }

  /**
   * Hover outline (WS-10 / R2.4). On desktop pointer-MOVE (no button), resolve
   * the entity under the cursor via the SAME pure `pickEntityAt` the tap uses and
   * stash it in `_hoveredId` (renderer-local — NEVER Zustand, #2). The per-frame
   * `update()` draws the lighter `HoverBracket` around it. Reads the already-
   * resolved `_lastMirror` (one-pose-per-frame; pickEntityAt reads `entry.x/y`
   * for kind 1/2, never re-interpolates). Gated by the callers on
   * `!galaxyTapSuppressed() && !_placementActive` (same as selection) so it never
   * fires over the galaxy layer or during blueprint placement.
   */
  protected handleGameplayHover(screenX: number, screenY: number): void {
    if (this._lastMirror === null) {
      this._hoveredId = null;
      return;
    }
    const w = this.camera.screenToWorld(screenX, screenY);
    const hit = pickEntityAt(w.x, -w.y, this._lastMirror);
    this._hoveredId = hit?.id ?? null;
  }

  /**
   * DEV/E2E-only deterministic hover at a GAME-space point — bypasses
   * screen→world projection (camera-transform fragility) so a Playwright spec can
   * hover an entity at its known world position. Mirrors `devSelectAtWorld`; runs
   * the SAME `pickEntityAt` the real pointer-move hover uses. Returns the id.
   */
  devHoverAtWorld(gameX: number, gameY: number): string | null {
    if (this._lastMirror === null) return null;
    const hit = pickEntityAt(gameX, gameY, this._lastMirror);
    this._hoveredId = hit?.id ?? null;
    return this._hoveredId;
  }

  /** True while the galaxy layer should swallow gameplay taps — either the
   *  full-screen selector (pan/zoom active) OR the in-game additive overlay is
   *  up (a tap there warps to a neighbour). Selection must not fire in either. */
  protected galaxyTapSuppressed(): boolean {
    const gl = this._galaxyLayer;
    return gl !== null && (gl.isPanZoomActive() || gl.visible);
  }

  /**
   * DEV/E2E-only deterministic selection at a GAME-space point — bypasses
   * screen→world projection so a Playwright spec can select an entity at its
   * known world position without the camera-transform fragility a real screen
   * tap would carry. Mirrors the `__eqxGalaxyPick` DEV-hook pattern. Runs the
   * SAME `pickEntityAt` + toggle logic the real tap uses, so it exercises the
   * full pick → select → bracket → feedback path. Returns the resolved id.
   */
  devSelectAtWorld(gameX: number, gameY: number): string | null {
    if (this._lastMirror === null) return null;
    const hit = pickEntityAt(gameX, gameY, this._lastMirror);
    if (hit === null || hit.id === this._focusId) this.setFocus(null, null);
    else this.setFocus(hit.id, hit.kind);
    return this._focusId;
  }

  /** The camera half of a pointer gesture (the subclass). */
  /** A build-mode tap on empty space: move the placement ghost there. */
  protected abstract placementTap(x: number, y: number, pointerType: string): void;
  protected abstract cameraPointer(type: string, pointerId: number, x: number, y: number, stamp: number, pointerType?: string): boolean;

  /** See `IRenderer.setFleetPick`. */
  setFleetPick(kind: FleetPickKindWire | null): void {
    pickStart(this._fleetPick, kind);
    this.feedback.fleetPickPoints = 0;
    if (kind !== null) this._fleetBoxActive = false;
  }

  /** See `IRenderer.commitFleetPick`. A no-op until the route is long enough. */
  commitFleetPick(): void {
    const result = pickFinishPatrol(this._fleetPick);
    if (result !== null) this.publishPickResult(result);
  }

  /** See `IRenderer.undoFleetPickPoint`. Drops the last patrol point. */
  undoFleetPickPoint(): void {
    if (pickUndoPoint(this._fleetPick)) this.feedback.fleetPickPoints = this._fleetPick.count;
  }

  /** See `IRenderer.setFleetOverlayModel`. Allocates on a status change only. */
  setFleetOverlayModel(model: FleetOverlayModel): void {
    const next = new Map<string, FleetOverlayShip>();
    for (const s of model.ships) next.set(s.id, s);
    this._fleetModel = next;
  }

  /** RTS fleet warp (S8) — these own ships become THE selection (focus
   *  cleared), through the one `setSelection`. Ids that are not own ships in
   *  the last mirror are skipped (the per-frame prune would drop them). */
  selectFleetShips(ids: readonly string[]): void {
    const m = this._lastMirror;
    const next = new Set<string>();
    for (const id of ids) if (m === null || isOwnShipPresent(id, m)) next.add(id);
    this.setSelection(next, null, null);
  }


  /** Focus an entity by id, the same path as a map tap on it (Contacts row
   *  tap). Never toggles off: tapping the focused contact keeps it. */
  focusEntity(id: string, kind: PickedEntityKind): void { this.setFocus(id, kind); }

  /** Command view follows spectating (see `PixiRenderer.setSpectator`). */
  setCommandView(active: boolean): void {
    // RTS command view == spectating for now (a later slice renames it).
    // Leaving it drops any live box and clears the ship selection (and the
    // focus with it when the focus was one of those ships).
    const cancel = this._cmdRouter.setEnabled(active);
    for (let i = 0; i < cancel.length; i++) this.applyRouterAction(cancel[i]!);
    if (!active && this._selShips.size > 0) this.setSelection(new Set(), null, null);
    if (!active) this.setFleetPick(null);
  }
}
