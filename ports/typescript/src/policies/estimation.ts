// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

export function estimateProjectionBytes(items: readonly unknown[], estimator: (item: unknown) => number = () => 1): number {
  return items.reduce<number>((total, item) => total + Number(estimator(item)), 0);
}

export function estimateActiveByteRange(sessionCount: number, segmentCount: number, entryCount: number): number {
  return Math.max(0, sessionCount * 1024 + segmentCount * 256 + entryCount * 64);
}
