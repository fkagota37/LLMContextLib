// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { expect, it } from 'vitest';
import { PersistentStringTree } from '../src/storage/persistent-string-tree.js';

it('preserves past roots and their weights across sorted insertions and mixed edits', () => {
  let tree = new PersistentStringTree<number>();
  const expected = new Map<string, number>();
  const snapshots: { tree: PersistentStringTree<number>; expected: Map<string, number> }[] = [];
  const set = (key: string, value: number) => {
    tree = tree.set(key, value, BigInt(value));
    expected.set(key, value);
  };
  for (let index = 0; index < 512; index++) set(`key${String(index).padStart(3, '0')}`, index);
  snapshots.push({ tree, expected: new Map(expected) });
  const shifted = [['key222', 900], ['key010', 700], ['key505', 800]] as const;
  const revised = tree.replaceValues(shifted);
  for (const [key, value] of shifted) {
    expect(revised.get(key)).toBe(value);
    expect(tree.get(key)).toBe(expected.get(key));
  }
  expect(revised.weight).toBe(tree.weight);
  expect([...revised]).toEqual([...tree]);
  expect(() => tree.replaceValues([['missing', 0]])).toThrow(RangeError);
  let seed = 1729;
  for (let step = 0; step < 3000; step++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const key = `key${String((seed >>> 8) % 512).padStart(3, '0')}`;
    if (seed >>> 31) set(key, step);
    else {
      tree = tree.delete(key);
      expected.delete(key);
    }
    if (step % 500 === 0) snapshots.push({ tree, expected: new Map(expected) });
  }
  for (const snapshot of [...snapshots, { tree, expected }]) {
    expect([...snapshot.tree]).toEqual([...snapshot.expected.keys()].sort());
    expect(snapshot.tree.size).toBe(snapshot.expected.size);
    expect(snapshot.tree.weight).toBe([...snapshot.expected.values()].reduce((sum, value) => sum + BigInt(value), 0n));
    for (const [key, value] of snapshot.expected) expect(snapshot.tree.get(key)).toBe(value);
    for (const bound of ['before', 'key250', 'key250x', 'key511', 'past']) {
      const sorted = [...snapshot.expected.keys()].sort();
      expect([...snapshot.tree.from(bound)]).toEqual(sorted.filter((key) => key >= bound).map((key) => snapshot.expected.get(key)));
      expect(snapshot.tree.hasAfter(bound)).toBe(sorted.some((key) => key > bound));
    }
  }
});
