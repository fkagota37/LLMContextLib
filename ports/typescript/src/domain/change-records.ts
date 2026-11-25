// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { ContextCompoundRecords } from './compound-records.js';
import { ContextEntryRecords } from './entry-records.js';
import { ContextScalarRecords } from './scalar-records.js';
import type { ContextChange } from './session.js';

type Kind = ContextChange['kind'];
type Changes = { [K in Kind]: Extract<ContextChange, { kind: K }> };
type Change<K extends Kind = Kind> = Changes[K];
interface RecordOperations<T> {
  equals(left: T, right: T): boolean;
  hash(value: T): number;
  format(value: T): string;
  clone(value: T): T;
}

const operations: { [K in Kind]: RecordOperations<Changes[K]> } = {
  AppendEntries: ContextCompoundRecords.AppendEntries,
  ReplaceEntry: ContextEntryRecords.ReplaceEntry,
  DeleteEntry: ContextScalarRecords.DeleteEntry,
  ReplaceSegment: ContextCompoundRecords.ReplaceSegment,
  PutAnchor: ContextCompoundRecords.PutAnchor,
  RemoveAnchor: ContextScalarRecords.RemoveAnchor,
  SetSessionStatus: ContextScalarRecords.SetSessionStatus,
};

function schema<K extends Kind>(value: Change<K>): RecordOperations<Change<K>> {
  return operations[value.kind as K];
}

/** Explicit operations dispatched by the discriminator of a ContextChange. */
export const ContextChangeRecords = Object.freeze({
  equals(left: ContextChange | null, right: ContextChange | null): boolean {
    if (left === null || right === null) return left === right;
    return left.kind === right.kind && schema(left).equals(left, right);
  },
  hash(value: ContextChange): number { return schema(value).hash(value); },
  format(value: ContextChange): string { return schema(value).format(value); },
  clone<T extends ContextChange>(value: T): T { return schema(value).clone(value) as T; },
});
