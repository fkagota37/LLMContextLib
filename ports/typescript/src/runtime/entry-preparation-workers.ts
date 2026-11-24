// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import type { EntryPreparationInput, EntryPreparationOutput } from '../storage/session-store.js';
import { IndexMaintenanceThread } from './index-maintenance-thread.js';
import type { OwnerMailbox } from './owner-mailbox.js';

interface Pending {
  resolve(output: EntryPreparationOutput): void;
  reject(error: Error): void;
}
interface Slot {
  thread: IndexMaintenanceThread<EntryPreparationInput, EntryPreparationOutput>;
  pending?: Pending;
}

export class EntryPreparationWorkers {
  private readonly slots = new Set<Slot>();

  constructor(private readonly mailbox: OwnerMailbox) {}

  public trySubmit(input: EntryPreparationInput, pending: Pending): boolean {
    let slot = [...this.slots].find((candidate) => !candidate.pending);
    if (!slot) {
      if (this.slots.size >= 2) return false;
      const thread = new IndexMaintenanceThread<EntryPreparationInput, EntryPreparationOutput>(this.mailbox,
        (output) => {
          const task = slot!.pending;
          slot!.pending = undefined;
          task?.resolve(output);
        }, (error) => {
          this.slots.delete(slot!);
          const task = slot!.pending;
          slot!.pending = undefined;
          slot!.thread.dispose();
          task?.reject(error);
        });
      slot = { thread };
      this.slots.add(slot);
    }
    slot.pending = pending;
    try { slot.thread.submit(input); }
    catch (error) {
      this.slots.delete(slot);
      slot.pending = undefined;
      slot.thread.dispose();
      throw error;
    }
    return true;
  }

  public dispose(): void {
    for (const slot of this.slots) {
      slot.pending?.reject(new Error('Context owner disposed during entry preparation.'));
      slot.pending = undefined;
      slot.thread.dispose();
    }
    this.slots.clear();
  }
}
