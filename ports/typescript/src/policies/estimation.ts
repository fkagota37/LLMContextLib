// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

export function estimateProjectionBytes(items: readonly unknown[], estimator: (item: unknown) => number = () => 1): number {
  return items.reduce<number>((total, item) => {
    const next = Number(estimator(item));
    if (!Number.isFinite(next)) {
      return total;
    }
    return total + Math.max(0, Math.trunc(next));
  }, 0);
}

export function estimateActiveByteRange(sessionCount: number, segmentCount: number, entryCount: number): number {
  const sessionBytes = Math.max(0, Math.trunc(sessionCount)) * 1024;
  const segmentBytes = Math.max(0, Math.trunc(segmentCount)) * 256;
  const entryBytes = Math.max(0, Math.trunc(entryCount)) * 64;
  return Math.max(0, sessionBytes + segmentBytes + entryBytes);
}
