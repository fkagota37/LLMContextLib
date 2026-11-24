// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

export type Int64 = bigint | number;

const maximum = (1n << 63n) - 1n;
const minimum = -(1n << 63n);
const safe = BigInt(Number.MAX_SAFE_INTEGER);

export function isInt64(value: unknown): value is Int64 {
  return typeof value === 'bigint' ? value >= minimum && value <= maximum :
    typeof value === 'number' && Number.isSafeInteger(value);
}

export function isPositiveInt64(value: unknown): value is Int64 {
  return isInt64(value) && value > 0;
}

export function checkedInt64(value: bigint): bigint {
  if (value < minimum || value > maximum) throw new RangeError('Signed 64-bit arithmetic overflow.');
  return value;
}

export function incrementCounter(value: Int64): Int64 {
  if (typeof value === 'number' && value < Number.MAX_SAFE_INTEGER) return value + 1;
  return canonicalInt64(BigInt.asIntN(64, BigInt(value) + 1n));
}

export function canonicalInt64(value: Int64): Int64 {
  if (!isInt64(value)) throw new RangeError('Value is outside the exact signed 64-bit range.');
  return typeof value === 'bigint' && value >= -safe && value <= safe ? Number(value) : value;
}

export function compareInt64(left: Int64, right: Int64): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function advanceInt64(value: Int64, amount = 1n): Int64 {
  if (!isInt64(value)) throw new RangeError('Value is outside the exact signed 64-bit range.');
  return canonicalInt64(checkedInt64(BigInt(value) + amount));
}
