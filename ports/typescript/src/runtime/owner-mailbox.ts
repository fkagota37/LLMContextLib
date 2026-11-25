// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

import { MessageChannel, receiveMessageOnPort, type MessagePort } from 'node:worker_threads';

/**
 * Dispatches trusted owner requests both during normal event-loop turns and
 * while a synchronous admission call is waiting on independently running callers.
 */
export class OwnerMailbox {
  private readonly wake = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  private readonly peers = new Map<MessagePort, {
    dispatch(value: unknown): void;
    close(): void;
    preserveOnOwnerDispose?: () => boolean;
  }>();

  attach(receive: (value: unknown, reply: (value: unknown) => void) => void, onClose?: () => void,
    preserveOnOwnerDispose?: () => boolean): {
    port: MessagePort;
    wake: Int32Array;
  } {
    return this.attachDuplex(receive, onClose, preserveOnOwnerDispose).endpoint;
  }

  attachDuplex(receive: (value: unknown, reply: (value: unknown) => void) => void, onClose?: () => void,
    preserveOnOwnerDispose?: () => boolean) {
    const { port1, port2 } = new MessageChannel();
    const reply = (value: unknown) => port1.postMessage(value);
    const dispatch = (value: unknown) => receive(value, reply);
    const closed = () => { if (this.peers.delete(port1)) onClose?.(); };
    const close = () => { closed(); port1.close(); };
    this.peers.set(port1, { dispatch, close, preserveOnOwnerDispose });
    port1.on('message', dispatch);
    port1.on('close', closed);
    port1.unref();
    return { endpoint: { port: port2, wake: this.wake }, post: reply, close };
  }

  wait(deadline: number): boolean {
    if (!this.peers.size || performance.now() >= deadline) return false;
    const observed = Atomics.load(this.wake, 0);
    for (const [port, peer] of this.peers) {
      const request = receiveMessageOnPort(port);
      if (request) {
        peer.dispatch(request.message);
        return true;
      }
    }
    const remaining = deadline - performance.now();
    return remaining > 0 && Atomics.wait(this.wake, 0, observed, remaining) !== 'timed-out';
  }

  dispose(): void {
    for (const peer of this.peers.values()) {
      if (peer.preserveOnOwnerDispose?.()) continue;
      peer.close();
    }
  }
}
