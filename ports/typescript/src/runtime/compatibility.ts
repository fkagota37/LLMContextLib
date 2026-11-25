// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

export interface RuntimeCompatibilityProfile {
  readonly RequiresBigInt: boolean;
  readonly RequiresTextEncoder: boolean;
  readonly RequiresMapSet: boolean;
  readonly MinNodeMajorVersion: number;
}

export const defaultRuntimeCompatibilityProfile: RuntimeCompatibilityProfile = {
  RequiresBigInt: true,
  RequiresTextEncoder: true,
  RequiresMapSet: true,
  MinNodeMajorVersion: 18,
};

export function validateRuntimeCompatibility(profile: Partial<RuntimeCompatibilityProfile> = {}): void {
  const resolved: RuntimeCompatibilityProfile = {
    ...defaultRuntimeCompatibilityProfile,
    ...profile,
  };

  if (resolved.RequiresBigInt && typeof globalThis.BigInt === 'undefined') {
    throw new Error('This runtime does not support BigInt required by the port contract.');
  }

  if (resolved.RequiresTextEncoder && typeof globalThis.TextEncoder === 'undefined') {
    throw new Error('This runtime does not provide TextEncoder required for UTF-8 estimates.');
  }

  if (resolved.RequiresMapSet && (typeof globalThis.Map === 'undefined' || typeof globalThis.Set === 'undefined')) {
    throw new Error('This runtime does not provide Map/Set support required by the port state model.');
  }

  const nodeVersion = typeof process !== 'undefined' ? process.versions?.node : undefined;
  if (nodeVersion) {
    const major = Number(nodeVersion.split('.')[0]);
    if (!Number.isFinite(major) || major < resolved.MinNodeMajorVersion) {
      throw new Error(`The Node runtime version ${nodeVersion} is below the minimum supported version ${resolved.MinNodeMajorVersion}.`);
    }
  }
}
