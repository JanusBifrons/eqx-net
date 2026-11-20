/**
 * The building-MANAGEMENT buttons of the inspector card (`EntityStatsPanel`):
 * deconstruct, reconnect, blueprint load / unload, recipe, gate access, clear
 * connections, upgrade. Build mode only (`canManageBuildings`); the panel
 * renders this inside its own action row, next to the pilot-service buttons
 * (repair, refine) that show in every mode.
 */
import { IconButton, Tooltip } from '@mui/material';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import CancelIcon from '@mui/icons-material/Cancel';
import HubIcon from '@mui/icons-material/Hub';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import UpgradeIcon from '@mui/icons-material/Upgrade';
import SchoolIcon from '@mui/icons-material/School';
import EjectIcon from '@mui/icons-material/Eject';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import { sendStructureAction, sendUpgradeStructure, sendSetGateAccess, sendSetRecipe, sendBlueprintSlot } from '../structures/structureActionsClient';
import { nextRecipe } from '@shared-types/production';
import { RECIPES, type RecipeId } from '@shared-types/recipes';
import { GATE_ACCESS_IDS, type GateAccess } from '@shared-types/gateAccess';
import { StructureSettingsCog } from './StructureSettingsModal';

export const ACTION_BTN_SX = {
  p: '2px',
  color: 'rgba(180,220,255,0.85)',
  '&:hover': { color: '#cde', bgcolor: 'rgba(120,200,255,0.15)' },
};
const ACTION_BTN_WARN_SX = {
  p: '2px',
  color: '#ff9b6b',
  '&:hover': { color: '#ffb892', bgcolor: 'rgba(255,120,80,0.15)' },
};
export const ICON_SX = { fontSize: { xs: 16, sm: 28 } };

/** The card fields the management buttons read (a subset of the panel's data). */
export interface ManageActionData {
  name?: string;
  isDeconstructing?: boolean;
  isConnector?: boolean;
  canUpgrade?: boolean;
  upgradeGoods?: string;
  gateAccess?: GateAccess;
  recipe?: RecipeId;
  canChangeRecipe?: boolean;
  needsBlueprint?: boolean;
  blueprintLine?: string;
}

/** The next gate access setting in the cycle (owner + allies → owner only →
 *  anyone not hostile → …). */
export function nextGateAccess(a: GateAccess): GateAccess {
  const i = GATE_ACCESS_IDS.indexOf(a);
  return GATE_ACCESS_IDS[(i + 1) % GATE_ACCESS_IDS.length]!;
}

export function StructureManageActions({ entityId, data }: { entityId: number; data: ManageActionData }): JSX.Element {
  return (
    <>
      <StructureSettingsCog entityId={entityId} title={data.name ?? ''} />
      <Tooltip title={data.isDeconstructing ? 'Cancel deconstruction' : 'Deconstruct (reverse build, returns resources)'}>
        <IconButton
          data-testid="structure-action-deconstruct"
          data-active={data.isDeconstructing ? '1' : '0'}
          size="small"
          sx={data.isDeconstructing ? ACTION_BTN_WARN_SX : ACTION_BTN_SX}
          onClick={() => sendStructureAction(entityId, 'toggle_deconstruct')}
        >
          {data.isDeconstructing ? <CancelIcon sx={ICON_SX} /> : <DeleteForeverIcon sx={ICON_SX} />}
        </IconButton>
      </Tooltip>
      <Tooltip title="Reconnect to the nearest structure">
        <IconButton
          data-testid="structure-action-reconnect"
          size="small"
          sx={ACTION_BTN_SX}
          onClick={() => sendStructureAction(entityId, 'reconnect')}
        >
          <HubIcon sx={ICON_SX} />
        </IconButton>
      </Tooltip>
      {data.recipe !== undefined && data.needsBlueprint && (
        <Tooltip title={data.blueprintLine !== undefined ? 'Swap in the best blueprint from storage' : 'Load a blueprint from storage'}>
          <IconButton
            data-testid="structure-action-load-blueprint"
            size="small"
            sx={ACTION_BTN_SX}
            onClick={() => sendBlueprintSlot(entityId, 'load')}
          >
            <SchoolIcon sx={ICON_SX} />
          </IconButton>
        </Tooltip>
      )}
      {data.blueprintLine !== undefined && (
        <Tooltip title="Put the blueprint back in storage">
          <IconButton
            data-testid="structure-action-unload-blueprint"
            size="small"
            sx={ACTION_BTN_SX}
            onClick={() => sendBlueprintSlot(entityId, 'unload')}
          >
            <EjectIcon sx={ICON_SX} />
          </IconButton>
        </Tooltip>
      )}
      {data.recipe !== undefined && data.canChangeRecipe && (
        <Tooltip title="Change what this makes">
          <IconButton
            data-testid="structure-action-recipe"
            size="small"
            sx={ACTION_BTN_SX}
            onClick={() => sendSetRecipe(entityId, nextRecipe(RECIPES[data.recipe!].processors[0]!, data.recipe!))}
          >
            <SwapHorizIcon sx={ICON_SX} />
          </IconButton>
        </Tooltip>
      )}
      {data.gateAccess !== undefined && (
        <Tooltip title="Change who this gate opens for">
          <IconButton
            data-testid="structure-action-gate-access"
            size="small"
            sx={ACTION_BTN_SX}
            onClick={() => sendSetGateAccess(entityId, nextGateAccess(data.gateAccess!))}
          >
            <LockOpenIcon sx={ICON_SX} />
          </IconButton>
        </Tooltip>
      )}
      {data.isConnector && (
        <Tooltip title="Clear all connections">
          <IconButton
            data-testid="structure-action-clear"
            size="small"
            sx={ACTION_BTN_SX}
            onClick={() => sendStructureAction(entityId, 'clear_connections')}
          >
            <LinkOffIcon sx={ICON_SX} />
          </IconButton>
        </Tooltip>
      )}
      {data.canUpgrade && (
        // WS-B4 — a paid Upgrade (level-up build phase). Gated to OWNED +
        // BUILT + below-cap (set in the panel's readData).
        <Tooltip title={data.upgradeGoods !== undefined ? `Upgrade (minerals + ${data.upgradeGoods} from base storage)` : 'Upgrade (paid level-up: boosts this structure\x27s key stat)'}>
          <IconButton
            data-testid="structure-action-upgrade"
            size="small"
            sx={ACTION_BTN_SX}
            onClick={() => sendUpgradeStructure(entityId)}
          >
            <UpgradeIcon sx={ICON_SX} />
          </IconButton>
        </Tooltip>
      )}
    </>
  );
}
