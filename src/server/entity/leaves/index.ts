/**
 * Barrel for the server-side Entity leaf classes (Generic Entity Pipeline — the
 * OOP identity layer). A new world-object type is a leaf here + a row in
 * `EntityKindRegistry`; the resolver (B2) + sync-router/factory (B4) handle it
 * generically.
 */

export * from './entityLeaf.js';
export * from './swarmDamageStrategy.js';
export * from './swarmLeafBase.js';
export * from './shipEntity.js';
export * from './wreckEntity.js';
export * from './droneEntity.js';
export * from './asteroidEntity.js';
export * from './structureEntity.js';
export * from './projectileEntity.js';
export * from './missileEntity.js';
