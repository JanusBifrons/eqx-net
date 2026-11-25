/**
 * What the teleporter cycle needs of the chamber blast doors (redesign T2).
 * `PadDoors` implements it; `TeleporterSubsystem` takes it as a hook. Kept in
 * its own file so the subsystem never imports the rig-clip writer (and the
 * room-state schema behind it).
 */
import type { DoorSegment } from '../../core/structures/doorMotion.js';
import type { StructureRecord } from './StructureRegistry.js';

export interface PadDoorDriver {
  /** Steer the doors open / shut; true when the segment changed. */
  drive(rec: StructureRecord, open: boolean): boolean;
  /** Both doorways fully shut. */
  shut(rec: StructureRecord): boolean;
  /** Not shut and unable to move (no power). */
  stalled(rec: StructureRecord): boolean;
  /** The door segment for the room row (undefined: resting open). */
  segFor(id: string): Readonly<DoorSegment> | undefined;
  /** The pad left the world. */
  remove(id: string): void;
}
