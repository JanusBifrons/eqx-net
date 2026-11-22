/**
 * Door-leaf hit boxes moved to core (`core/structures/doorLeafBoxes.ts`) so
 * the client's warp route check builds a gate's boxes with the same code as
 * the server (#15). Re-exported here for the server's existing importers.
 */
export { doorLeafCount, gateHitBoxes, writeDoorLeafBoxes } from '../../core/structures/doorLeafBoxes.js';
