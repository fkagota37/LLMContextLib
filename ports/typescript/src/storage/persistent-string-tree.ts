// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

interface Node<T> {
  readonly key: string;
  readonly value: T;
  readonly left: Node<T> | undefined;
  readonly right: Node<T> | undefined;
  readonly height: number;
  readonly size: number;
  readonly ownWeight: bigint;
  readonly weight: bigint;
}

const height = <T>(node: Node<T> | undefined) => node?.height ?? 0;

function make<T>(key: string, value: T, ownWeight: bigint, left?: Node<T>, right?: Node<T>): Node<T> {
  return { key, value, ownWeight, left, right, height: 1 + Math.max(height(left), height(right)),
    size: 1 + (left?.size ?? 0) + (right?.size ?? 0), weight: ownWeight + (left?.weight ?? 0n) + (right?.weight ?? 0n) };
}

function shape<T>(node: Node<T>, left?: Node<T>, right?: Node<T>): Node<T> {
  return make(node.key, node.value, node.ownWeight, left, right);
}

function rotateLeft<T>(node: Node<T>): Node<T> {
  const top = node.right!;
  return shape(top, shape(node, node.left, top.left), top.right);
}

function rotateRight<T>(node: Node<T>): Node<T> {
  const top = node.left!;
  return shape(top, top.left, shape(node, top.right, node.right));
}

function balance<T>(node: Node<T>, left?: Node<T>, right?: Node<T>): Node<T> {
  if (height(left) - height(right) > 1) {
    if (height(left!.left) < height(left!.right)) left = rotateLeft(left!);
    return rotateRight(shape(node, left, right));
  }
  if (height(right) - height(left) > 1) {
    if (height(right!.right) < height(right!.left)) right = rotateRight(right!);
    return rotateLeft(shape(node, left, right));
  }
  return shape(node, left, right);
}

function put<T>(node: Node<T> | undefined, key: string, value: T, weight: bigint): Node<T> {
  if (!node) return make(key, value, weight);
  if (key === node.key) {
    return value === node.value && weight === node.ownWeight ? node : make(key, value, weight, node.left, node.right);
  }
  if (key < node.key) {
    const left = put(node.left, key, value, weight);
    return left === node.left ? node : balance(node, left, node.right);
  }
  const right = put(node.right, key, value, weight);
  return right === node.right ? node : balance(node, node.left, right);
}

function remove<T>(node: Node<T> | undefined, key: string): Node<T> | undefined {
  if (!node) return node;
  if (key < node.key) {
    const left = remove(node.left, key);
    return left === node.left ? node : balance(node, left, node.right);
  }
  if (key > node.key) {
    const right = remove(node.right, key);
    return right === node.right ? node : balance(node, node.left, right);
  }
  if (!node.left || !node.right) return node.left ?? node.right;
  let successor = node.right;
  while (successor.left) successor = successor.left;
  return balance(successor, node.left, remove(node.right, successor.key));
}

function replace<T>(node: Node<T> | undefined, edits: readonly (readonly [string, T])[], start: number, end: number): Node<T> | undefined {
  if (start === end) return node;
  if (!node) throw new RangeError('Cannot replace an absent tree key.');
  let low = start;
  let high = end;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (edits[middle][0] < node.key) low = middle + 1;
    else high = middle;
  }
  const found = low < end && edits[low][0] === node.key;
  const left = replace(node.left, edits, start, low);
  const right = replace(node.right, edits, found ? low + 1 : low, end);
  const value = found ? edits[low][1] : node.value;
  return value === node.value && left === node.left && right === node.right ? node :
    make(node.key, value, node.ownWeight, left, right);
}

export class PersistentStringTree<T> implements Iterable<string> {
  readonly #root: Node<T> | undefined;

  constructor(root?: Node<T>) { this.#root = root; }

  get size(): number { return this.#root?.size ?? 0; }
  get weight(): bigint { return this.#root?.weight ?? 0n; }

  #find(key: string): Node<T> | undefined {
    let node = this.#root;
    while (node && node.key !== key) node = key < node.key ? node.left : node.right;
    return node;
  }

  get(key: string): T | undefined { return this.#find(key)?.value; }
  has(key: string): boolean { return this.#find(key) !== undefined; }

  set(key: string, value: T, weight = 0n): PersistentStringTree<T> {
    const root = put(this.#root, key, value, weight);
    return root === this.#root ? this : new PersistentStringTree(root);
  }

  delete(key: string): PersistentStringTree<T> {
    const root = remove(this.#root, key);
    return root === this.#root ? this : new PersistentStringTree(root);
  }

  replaceValues(edits: readonly (readonly [string, T])[]): PersistentStringTree<T> {
    const sorted = [...edits].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    const root = replace(this.#root, sorted, 0, sorted.length);
    return root === this.#root ? this : new PersistentStringTree(root);
  }

  *[Symbol.iterator](): Iterator<string> {
    for (const node of this.#from('')) yield node.key;
  }

  hasAfter(key: string): boolean {
    let node = this.#root;
    if (!node) return false;
    while (node.right) node = node.right;
    return node.key > key;
  }

  *from(key: string): IterableIterator<T> {
    for (const node of this.#from(key)) yield node.value;
  }

  *#from(key: string): IterableIterator<Node<T>> {
    const stack: Node<T>[] = [];
    let node = this.#root;
    while (node || stack.length) {
      while (node) {
        if (node.key < key) node = node.right;
        else {
          stack.push(node);
          node = node.left;
        }
      }
      if (!stack.length) break;
      node = stack.pop()!;
      yield node;
      node = node.right;
    }
  }
}
