# CLAUDE.md — src/shared-types (shared data catalogues)

Pure TS + zod read by core, server and client alike. Project-wide invariants: root [CLAUDE.md](../../CLAUDE.md).

## Kind catalogues

- **New structure kind:** a record in its family file under `structureKinds/` (or a new family file), then APPEND it to `structureKinds/catalogueOrder.ts`. Never reorder or remove: the list index is the wire subtype byte (invariant #11).
- **New ship kind:** the same under `shipKinds/`, appended to `shipKinds/catalogueOrder.ts`.
- `structureKinds.ts` and `shipKinds.ts` are barrels only: never add records or logic there; re-export from the folder.
- A numeric edit to an existing structure record bumps `STRUCTURE_KIND_CATALOGUE_VERSION` (`structureKinds/lookup.ts`); appending a kind does not.
- `tests/unit/structureKinds.test.ts` locks the structure id order; never edit that list except to append.

Details: [god-file-extension-points](../../docs/architecture/god-file-extension-points.md).
