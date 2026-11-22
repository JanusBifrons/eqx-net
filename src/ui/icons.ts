/**
 * The icon registry: one place that maps a game meaning to its icon.
 * Features render `<EqxIcon name="patrol" />`; they never import an icon directly.
 *
 * - One icon means one thing: no two names share a component (tested).
 * - `EqxIconName` is a string union, so a typo fails tsc.
 * - Where a feature already shows an icon for a meaning, the registry uses the
 *   same one (noted per line), so moving that feature onto the registry changes nothing.
 * - The game's own inline SVGs (cargo goods, ship silhouettes, entity badges,
 *   the free-look stick glyph) draw data, not a meaning in this list, so none is
 *   registered here yet.
 */
import type { SvgIconComponent } from '@mui/icons-material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AssignmentOutlinedIcon from '@mui/icons-material/AssignmentOutlined';
import BlockIcon from '@mui/icons-material/Block';
import BoltIcon from '@mui/icons-material/Bolt';
import CampaignIcon from '@mui/icons-material/Campaign';
import CancelIcon from '@mui/icons-material/Cancel';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import ConstructionIcon from '@mui/icons-material/Construction';
import DirectionsRunIcon from '@mui/icons-material/DirectionsRun';
import FlagOutlinedIcon from '@mui/icons-material/FlagOutlined';
import FlipIcon from '@mui/icons-material/Flip';
import FollowTheSignsIcon from '@mui/icons-material/FollowTheSigns';
import GppGoodIcon from '@mui/icons-material/GppGood';
import GpsFixedIcon from '@mui/icons-material/GpsFixed';
import HexagonOutlinedIcon from '@mui/icons-material/HexagonOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import Inventory2Icon from '@mui/icons-material/Inventory2';
import LoopIcon from '@mui/icons-material/Loop';
import RadarIcon from '@mui/icons-material/Radar';
import RotateRightIcon from '@mui/icons-material/RotateRight';
import RouteIcon from '@mui/icons-material/Route';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import ShieldIcon from '@mui/icons-material/Shield';
import StopIcon from '@mui/icons-material/Stop';
import StorefrontOutlinedIcon from '@mui/icons-material/StorefrontOutlined';
import TrackChangesIcon from '@mui/icons-material/TrackChanges';
import UndoIcon from '@mui/icons-material/Undo';
import WhatshotIcon from '@mui/icons-material/Whatshot';
import WorkspacesIcon from '@mui/icons-material/Workspaces';

/** Every game meaning the registry knows. Add a name here and in EQX_ICONS together. */
export const EQX_ICON_NAMES = [
  // Fleet orders
  'defend',
  'patrol',
  'hunt',
  'escort',
  'retreat',
  // Stances
  'defensive',
  'aggressive',
  'holdFire',
  // Quick actions
  'stop',
  'trade',
  'target',
  'build',
  // Doing mode (placing, route points)
  'rotate',
  'mirror',
  'confirm',
  'cancel',
  'undo',
  // Chrome
  'cog',
  'close',
  'back',
  // Right rail (build and trade above)
  'contacts',
  'hold',
  'fleet',
  'galaxy',
  'jobs',
  'faction',
  // Panel sections
  'details',
  'orders',
  'route',
  'power',
] as const;

export type EqxIconName = (typeof EQX_ICON_NAMES)[number];

/** Name -> icon component. `satisfies` makes a missing or extra name a tsc error. */
export const EQX_ICONS = {
  defend: ShieldIcon,
  patrol: LoopIcon,
  hunt: TrackChangesIcon,
  escort: FollowTheSignsIcon,
  retreat: DirectionsRunIcon,
  defensive: GppGoodIcon,
  aggressive: WhatshotIcon,
  holdFire: BlockIcon,
  stop: StopIcon, // as HyperspaceOverlay's stop-warp button
  trade: StorefrontOutlinedIcon, // as the drawer rail's Trade
  target: GpsFixedIcon, // as SpeedDialMenu's weapon / BountyAction
  build: ConstructionIcon, // as PilotSpectatorToggle's Build mode
  rotate: RotateRightIcon, // as StructurePlacementBanner
  mirror: FlipIcon, // as StructurePlacementBanner
  confirm: CheckIcon, // as StructurePlacementBanner
  cancel: CancelIcon,
  undo: UndoIcon,
  cog: SettingsOutlinedIcon, // as the drawer rail's Settings
  close: CloseIcon, // as the drawer's close
  back: ArrowBackIcon,
  contacts: RadarIcon,
  hold: Inventory2Icon, // as LootWindow's cargo toggle
  fleet: WorkspacesIcon,
  galaxy: HexagonOutlinedIcon, // as the drawer rail's Galaxy
  jobs: AssignmentOutlinedIcon, // as the drawer rail's Contracts
  faction: FlagOutlinedIcon, // as the drawer rail's Factions
  details: InfoOutlinedIcon,
  orders: CampaignIcon,
  route: RouteIcon,
  power: BoltIcon, // as structureCard / the Power build category
} as const satisfies Record<EqxIconName, SvgIconComponent>;
