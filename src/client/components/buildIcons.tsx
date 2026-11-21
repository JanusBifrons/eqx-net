import type { ReactNode } from 'react';
import HexagonIcon from '@mui/icons-material/Hexagon';
import HubIcon from '@mui/icons-material/Hub';
import SolarPowerIcon from '@mui/icons-material/SolarPower';
import DiamondIcon from '@mui/icons-material/Diamond';
import ShieldIcon from '@mui/icons-material/Shield';
import BatteryChargingFullIcon from '@mui/icons-material/BatteryChargingFull';
import InventoryIcon from '@mui/icons-material/Inventory2';
import SecurityIcon from '@mui/icons-material/Security';
import BoltIcon from '@mui/icons-material/Bolt';
import RocketLaunchIcon from '@mui/icons-material/RocketLaunch';
import DoorSlidingIcon from '@mui/icons-material/DoorSliding';
import MeetingRoomIcon from '@mui/icons-material/MeetingRoom';
import AirIcon from '@mui/icons-material/Air';
import RecyclingIcon from '@mui/icons-material/Recycling';
import WhatshotIcon from '@mui/icons-material/Whatshot';
import OilBarrelIcon from '@mui/icons-material/OilBarrel';
import MemoryIcon from '@mui/icons-material/Memory';
import GrassIcon from '@mui/icons-material/Grass';
import PrecisionManufacturingIcon from '@mui/icons-material/PrecisionManufacturing';
import HardwareIcon from '@mui/icons-material/Hardware';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import TerrainIcon from '@mui/icons-material/Terrain';
import FactoryIcon from '@mui/icons-material/Factory';
import SettingsIcon from '@mui/icons-material/Settings';
import ScienceIcon from '@mui/icons-material/Science';
import SailingIcon from '@mui/icons-material/Sailing';
import ApartmentIcon from '@mui/icons-material/Apartment';
import HomeWorkIcon from '@mui/icons-material/HomeWork';
import BlurCircularIcon from '@mui/icons-material/BlurCircular';
import TripOriginIcon from '@mui/icons-material/TripOrigin';
import AllOutIcon from '@mui/icons-material/AllOut';
import FlareIcon from '@mui/icons-material/Flare';
import TrackChangesIcon from '@mui/icons-material/TrackChanges';
import FortIcon from '@mui/icons-material/Fort';
import AdjustIcon from '@mui/icons-material/Adjust';
import AnchorIcon from '@mui/icons-material/Anchor';
import CastleIcon from '@mui/icons-material/Castle';
import TrainIcon from '@mui/icons-material/Train';
import LockIcon from '@mui/icons-material/Lock';
import GpsFixedIcon from '@mui/icons-material/GpsFixed';
import type { StructureKindId } from '@shared-types/structureKinds';

/** Per-structure-kind build icon. Exported so the desktop RTS BottomControlPanel
 *  (Phase 5 WS-4) renders the same building glyphs as the speed-dial build drill. */
export const BUILD_ICONS: Record<StructureKindId, ReactNode> = {
  capital: <HexagonIcon />,
  connector: <HubIcon />,
  solar: <SolarPowerIcon />,
  miner: <DiamondIcon />,
  turret: <ShieldIcon />,
  battery: <BatteryChargingFullIcon />,
  shield_pylon: <SecurityIcon />,
  laser_bolt_turret: <BoltIcon />, // WS-8 (R2.15)
  missile_turret: <RocketLaunchIcon />,
  cargo_bay: <InventoryIcon />, // Living World P1a-2
  shield_gate: <DoorSlidingIcon />,
  shield_airlock: <MeetingRoomIcon />,
  // Production chains (plan soft-leaping-truffle v3, P2a).
  gas_collector: <AirIcon />,
  reclaimer: <RecyclingIcon />,
  smelter: <WhatshotIcon />,
  refinery: <OilBarrelIcon />,
  silicon_works: <MemoryIcon />,
  hydroponics: <GrassIcon />,
  fabricator: <PrecisionManufacturingIcon />,
  munitions_works: <HardwareIcon />,
  freight_dock: <LocalShippingIcon />,
  deep_core_rig: <TerrainIcon />,
  ore_processing_complex: <SettingsIcon />,
  assembly_plant: <FactoryIcon />,
  research_lab: <ScienceIcon />, // economy v2 W3
  autocannon_turret: <GpsFixedIcon />, // P2d
  reactor: <WhatshotIcon />, // D1 consolidated
  battery_bank: <BatteryChargingFullIcon />,
  storage_vault: <InventoryIcon />,
  shipyard: <SailingIcon />, // economy v2 W5b
  habitat_module: <HomeWorkIcon />, // D3 habitation
  tower_module: <ApartmentIcon />,
  mine_layer: <BlurCircularIcon />, // Mine Layer
  teleporter: <TripOriginIcon />, // v4 T1
  teleporter_large: <AllOutIcon />,
  alien_gate: <AllOutIcon />, // never in a build menu (unbuildable)
  pocket_pad: <AllOutIcon />, // never in a build menu (unbuildable)
  // Coastal defences — the gun batteries.
  aa_quad_40mm: <FlareIcon />,
  dp_mount_5in: <TrackChangesIcon />,
  coastal_casemate_8in: <FortIcon />,
  coastal_turret_11in: <AdjustIcon />,
  coastal_barbette_16in: <AnchorIcon />,
  coastal_lindemann: <CastleIcon />,
  territory_lock: <LockIcon />, // sector control
  siege_gun_80cm: <TrainIcon />,
};
