// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

export const exactIntegerProbe = 9007199254740991n;
export const utf16TextProbe = 'A😀B';

export function ordinalCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function bootstrapContractSummary(): string {
  return `Exact integer: ${exactIntegerProbe.toString()}, text: ${utf16TextProbe}`;
}
