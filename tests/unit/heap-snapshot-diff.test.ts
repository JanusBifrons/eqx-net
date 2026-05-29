/**
 * Unit test for the heap-snapshot diff utility.
 *
 * plan: imperative-taco-r2 §1.1.
 *
 * The V8 `.heapsnapshot` format is plain JSON with this shape (simplified):
 *   {
 *     "snapshot": { "meta": { "node_fields": [...], "node_types": [...] } },
 *     "nodes":   [type, name, id, self_size, edge_count, trace_node_id, detachedness, ...repeats],
 *     "edges":   [type, name_or_index, to_node, ...repeats],
 *     "strings": ["", "<some string>", ...]
 *   }
 *
 * Each NODE occupies `node_fields.length` consecutive integers in the flat
 * `nodes` array. `type` is an index into `node_types[0]` (a small array of
 * strings like "object", "array", "string", "closure", "code"). `name` is an
 * index into `strings` (the constructor / class name).
 *
 * The diff utility groups nodes by `(type, name)`, sums `self_size` per group,
 * then compares snap1 vs snap2: per-group `count_delta` and `size_delta_bytes`.
 *
 * This test feeds two hand-crafted minimal snapshots and asserts the diff
 * output ranks the growing groups correctly.
 */
import { describe, it, expect } from 'vitest';
import { diffSnapshots, type SnapshotJson } from '../../scripts/heap-snapshot-diff';

/** Build a minimal valid V8 heap snapshot from a list of (typeIdx, nameStr, selfSizeBytes). */
function makeSnapshot(entries: ReadonlyArray<[number, string, number]>, typeNames: string[]): SnapshotJson {
  const strings: string[] = [''];
  const stringIdx = (s: string): number => {
    const i = strings.indexOf(s);
    if (i >= 0) return i;
    strings.push(s);
    return strings.length - 1;
  };
  // 7 fields per node: type, name, id, self_size, edge_count, trace_node_id, detachedness
  const nodes: number[] = [];
  let nextId = 1;
  for (const [typeIdx, name, selfSize] of entries) {
    nodes.push(typeIdx, stringIdx(name), nextId++, selfSize, 0, 0, 0);
  }
  return {
    snapshot: {
      meta: {
        node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness'],
        node_types: [typeNames, 'string', 'number', 'number', 'number', 'number', 'number'],
        edge_fields: ['type', 'name_or_index', 'to_node'],
        edge_types: [['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak'], 'string_or_number', 'node'],
      },
      node_count: entries.length,
      edge_count: 0,
      trace_function_count: 0,
    },
    nodes,
    edges: [],
    strings,
  };
}

const TYPE_NAMES = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native'];
const TYPE_OBJECT = 3;
const TYPE_ARRAY = 1;
const TYPE_STRING = 2;
const TYPE_CLOSURE = 5;

describe('heap-snapshot-diff (plan: imperative-taco-r2)', () => {
  it('detects a single growing constructor', () => {
    const snap1 = makeSnapshot([
      [TYPE_OBJECT, 'Foo', 100],
      [TYPE_OBJECT, 'Foo', 100],
    ], TYPE_NAMES);
    const snap2 = makeSnapshot([
      [TYPE_OBJECT, 'Foo', 100],
      [TYPE_OBJECT, 'Foo', 100],
      [TYPE_OBJECT, 'Foo', 100],
      [TYPE_OBJECT, 'Foo', 100],
      [TYPE_OBJECT, 'Foo', 100],
    ], TYPE_NAMES);
    const result = diffSnapshots(snap1, snap2);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'object',
      name: 'Foo',
      countDelta: 3,
      sizeDeltaBytes: 300,
    });
  });

  it('ranks multiple growers by size delta descending', () => {
    const snap1 = makeSnapshot([
      [TYPE_OBJECT, 'Small', 100],
      [TYPE_ARRAY, 'Array', 1000],
    ], TYPE_NAMES);
    const snap2 = makeSnapshot([
      [TYPE_OBJECT, 'Small', 100],
      [TYPE_OBJECT, 'Small', 100],
      [TYPE_OBJECT, 'Small', 100],  // +200 bytes
      [TYPE_ARRAY, 'Array', 1000],
      [TYPE_ARRAY, 'Array', 1000],  // +1000 bytes
    ], TYPE_NAMES);
    const result = diffSnapshots(snap1, snap2);
    // Array growth (1000) > Object/Small growth (200) so Array comes first.
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Array');
    expect(result[0].sizeDeltaBytes).toBe(1000);
    expect(result[0].countDelta).toBe(1);
    expect(result[1].name).toBe('Small');
    expect(result[1].sizeDeltaBytes).toBe(200);
    expect(result[1].countDelta).toBe(2);
  });

  it('omits zero-delta groups (steady-state)', () => {
    const snap1 = makeSnapshot([
      [TYPE_OBJECT, 'Stable', 50],
      [TYPE_OBJECT, 'Stable', 50],
      [TYPE_OBJECT, 'Grower', 100],
    ], TYPE_NAMES);
    const snap2 = makeSnapshot([
      [TYPE_OBJECT, 'Stable', 50],
      [TYPE_OBJECT, 'Stable', 50],
      [TYPE_OBJECT, 'Grower', 100],
      [TYPE_OBJECT, 'Grower', 100],
    ], TYPE_NAMES);
    const result = diffSnapshots(snap1, snap2);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Grower');
  });

  it('reports SHRUNK groups too (negative deltas, ranked descending so growers come first)', () => {
    const snap1 = makeSnapshot([
      [TYPE_ARRAY, 'A', 500],
      [TYPE_ARRAY, 'A', 500],
      [TYPE_OBJECT, 'B', 200],
    ], TYPE_NAMES);
    const snap2 = makeSnapshot([
      [TYPE_ARRAY, 'A', 500],
      [TYPE_OBJECT, 'B', 200],
      [TYPE_OBJECT, 'B', 200],
      [TYPE_OBJECT, 'B', 200],
    ], TYPE_NAMES);
    const result = diffSnapshots(snap1, snap2);
    // B grew +400 bytes (rank 1), A shrunk -500 bytes (rank 2 — most-negative last).
    expect(result.map((r) => r.name)).toEqual(['B', 'A']);
    expect(result[0].sizeDeltaBytes).toBe(400);
    expect(result[1].sizeDeltaBytes).toBe(-500);
  });

  it('treats same `name` but different `type` as separate groups', () => {
    // V8 will sometimes have a function named "Foo" (closure) AND a class
    // named "Foo" (object). Group by (type, name), not name alone.
    const snap1 = makeSnapshot([
      [TYPE_OBJECT, 'Foo', 100],
      [TYPE_CLOSURE, 'Foo', 80],
    ], TYPE_NAMES);
    const snap2 = makeSnapshot([
      [TYPE_OBJECT, 'Foo', 100],
      [TYPE_OBJECT, 'Foo', 100],   // +100 bytes object Foo
      [TYPE_CLOSURE, 'Foo', 80],
      [TYPE_CLOSURE, 'Foo', 80],   // +80 bytes closure Foo
    ], TYPE_NAMES);
    const result = diffSnapshots(snap1, snap2);
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.type === 'object' && r.name === 'Foo')?.sizeDeltaBytes).toBe(100);
    expect(result.find((r) => r.type === 'closure' && r.name === 'Foo')?.sizeDeltaBytes).toBe(80);
  });

  it('handles strings (type=2 → name field is content) the same as constructors', () => {
    // V8 represents strings as type=string with name=the literal string.
    // The diff treats them as a normal group keyed by ("string", "hello").
    const snap1 = makeSnapshot([
      [TYPE_STRING, 'hello', 12],
    ], TYPE_NAMES);
    const snap2 = makeSnapshot([
      [TYPE_STRING, 'hello', 12],
      [TYPE_STRING, 'hello', 12],   // +1 instance, +12 bytes
    ], TYPE_NAMES);
    const result = diffSnapshots(snap1, snap2);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('string');
    expect(result[0].countDelta).toBe(1);
    expect(result[0].sizeDeltaBytes).toBe(12);
  });
});
