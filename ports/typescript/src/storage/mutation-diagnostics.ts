// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

export type MutationDisposition =
  'Exception' | 'NotFound' | 'InitialRevisionConflict' | 'GatedRevisionConflict' |
  'InvalidPreparation' | 'GateRejected' | 'PreparedRevisionConflict' | 'ResourceRejected' | 'Applied' |
  'SynchronizationRejected';

export class MutationDiagnostics {
  Disposition: MutationDisposition = 'Exception';
  PreparationStarted = false;
  Prepared = false;
  GateAttempted = false;
  PreparationMs = 0;
  GateMs = 0;
  ResourceMs = 0;
  StorageMs = 0;
}
