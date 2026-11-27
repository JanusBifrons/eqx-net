/**
 * The left strip's items as DATA (selection-HUD redesign S2a). The section
 * builders (`fleetStripItems`, `buildingStripItems`, `placingStripItems`,
 * `routeStripItems`, `selectionStripItems`) return `StripAction[]`; the left
 * strip turns them into its icon elements with `renderStripActions`, and a
 * later slice draws the same data as the bottom-right hex buttons.
 *
 * One kind per strip element the builders use today:
 * - `button`: a one-tap action (EqxIconButton, strip variant);
 * - `flyout`: a pick-one status (EqxStatusFlyout: Order, Stance, Power);
 * - `identity`: a round identity icon (EqxStripIdentity: the building being
 *   placed, the route pick);
 * - `separator`: the strip's divider.
 */
import type { ReactElement, ReactNode } from 'react';
import {
  EqxIcon, EqxIconButton, EqxStatusFlyout, EqxStrip, EqxStripIdentity,
  type EqxIconName, type EqxStatusOption, type EqxStripHealth, type EqxTone,
} from '../../ui/index.js';

interface StripActionBase {
  /** React key; unique within one strip. */
  key: string;
  testId: string;
  /** The words for the icon (tooltip and aria-label). */
  tooltip: string;
}

export interface StripButtonAction extends StripActionBase {
  kind: 'button';
  icon: EqxIconName;
  onPress: () => void;
  tone?: EqxTone;
  active?: boolean;
  disabled?: boolean;
  /** Icon colour (hex) for an action that matches an in-world colour. */
  accent?: string;
  /** `data-state`, for tests. */
  state?: string;
}

export interface StripFlyoutAction<Id extends string = string> extends StripActionBase {
  kind: 'flyout';
  value: Id | null;
  options: readonly EqxStatusOption<Id>[];
  /** Shown while `value` is null (a mixed selection). */
  emptyIcon?: ReactNode;
  // Method syntax so a StripFlyoutAction<'on' | 'off'> fits the StripAction union.
  onPick(id: Id): void;
}

export interface StripIdentityAction extends StripActionBase {
  kind: 'identity';
  /** An icon name, or a custom element (a building's portrait). */
  icon: EqxIconName | ReactElement;
  health: EqxStripHealth;
  count?: number;
  onPress?: () => void;
  state?: string;
}

export interface StripSeparatorAction {
  kind: 'separator';
  key: string;
}

export type StripAction = StripButtonAction | StripFlyoutAction | StripIdentityAction | StripSeparatorAction;

function iconOf(icon: EqxIconName | ReactElement): ReactElement {
  return typeof icon === 'string' ? <EqxIcon name={icon} /> : icon;
}

/** One action as its left-strip element. */
function renderStripAction(a: StripAction): ReactElement {
  switch (a.kind) {
    case 'separator':
      return <EqxStrip.Separator key={a.key} />;
    case 'flyout':
      return (
        <EqxStatusFlyout key={a.key} value={a.value} emptyIcon={a.emptyIcon} options={a.options}
          onChange={(id) => a.onPick(id)} tooltip={a.tooltip} data-testid={a.testId} />
      );
    case 'identity':
      return (
        <EqxStripIdentity key={a.key} icon={iconOf(a.icon)} tooltip={a.tooltip} health={a.health} count={a.count}
          onClick={a.onPress} data-state={a.state} data-testid={a.testId} />
      );
    case 'button':
      return (
        <EqxIconButton key={a.key} variant="strip" icon={<EqxIcon name={a.icon} />} tooltip={a.tooltip}
          tone={a.tone} accent={a.accent} active={a.active} disabled={a.disabled}
          onClick={a.onPress} data-state={a.state} data-testid={a.testId} />
      );
  }
}

/** The actions as a flat element list (EqxStrip checks its children: icons only). */
export function renderStripActions(actions: readonly StripAction[]): ReactElement[] {
  return actions.map(renderStripAction);
}
