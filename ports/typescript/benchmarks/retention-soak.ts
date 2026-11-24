// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { ContextMutationStatus, ContextRole, TextContent, type ContextChangeSet, type ContextEntry } from '../src/domain/session.js';
import type { Int64 } from '../src/domain/int64.js';

export interface RetentionCapture {
  Revision: Int64;
  FirstEntry: ContextEntry | undefined;
  Release?(): void;
}

interface Participant {
  Apply(changes: ContextChangeSet): { Revision: Int64; Status: string };
  Capture(session: string): RetentionCapture;
}

export async function retentionSoak(participant: Participant, session: string, rounds = 32) {
  assert(Number.isInteger(rounds) && rounds > 0 && rounds <= 4096);
  const held: { lease: RetentionCapture; rev: Int64; first: ContextEntry | undefined }[] = [];
  const samples = [];
  let revision: Int64;
  const initial = participant.Capture(session);
  const target = initial.FirstEntry?.EntryId;
  revision = initial.Revision;
  initial.Release?.();
  assert(target, 'Retention soak needs a seeded entry.');
  const sample = (phase: 'grow' | 'released', round: number) => ({
    phase, round, held: held.length, revision, ...process.memoryUsage(),
  });
  try {
    for (let round = 0; round < rounds; round++) {
      const lease = participant.Capture(session);
      held.push({ lease, rev: lease.Revision, first: lease.FirstEntry });
      const update = participant.Apply({ SessionId: session, ExpectedRevision: revision, Changes: [
        { kind: 'ReplaceEntry', EntryId: target, Content: new TextContent(`soak revision ${round}`) },
        { kind: 'AppendEntries', Entries: [{
          EntryId: `${round.toString(16).padStart(8, '0')}-0000-000c-0000-000000000000`,
          Role: ContextRole.User,
          CreatedAt: new Date(Date.UTC(2026, 10, 11) + 1000 * round).toISOString(),
          Content: new TextContent('s'.repeat(1024)),
        }] },
      ] });
      assert.equal(update.Status, ContextMutationStatus.Applied);
      revision = update.Revision;
      for (const { lease, rev, first } of held) {
        assert.equal(lease.Revision, rev);
        assert.deepEqual(lease.FirstEntry, first, 'Retained content changed under mutation.');
      }
      if (held.length > 4) held.shift()!.lease.Release?.();
      samples.push(sample('grow', round));
    }
    while (held.length) held.shift()!.lease.Release?.();
    for (let round = 0; round < 8; round++) {
      await setTimeout(10);
      samples.push(sample('released', round));
    }
    return samples;
  } finally {
    while (held.length) held.shift()!.lease.Release?.();
  }
}
