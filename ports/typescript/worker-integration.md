# Worker callers and optional adapters

This is experimental Node 22 integration, not a remote service protocol or an
arbitrary cross-isolate closure executor. One client owns publication and
admission even when callers use separate worker threads.

## Share an endpoint, not the owner

The owner calls `LLMContextFactory.CreateWorkerEndpoint(client)`. Transfer the
returned endpoint's `port` to a worker, which creates `WorkerContextPeer`.
The peer has explicit lower-camel methods such as `apply`, `withCurrent`,
`openReadLease`, `openView`, `synchronizeIndexAsync`, and `dispose`.
Read-lease methods retain the ordinary public contract names.

In the [installed walkthrough consumer](walkthrough.md), save `main.mjs`:

```javascript
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import {
  LLMContextFactory,
  LLMContextOptions,
  SessionStatus,
} from "llmcontextlib-port-typescript";

const SessionId = randomUUID();
const owner = LLMContextFactory.Create(
  LLMContextOptions.WriteOptimized,
).Initialize([
  {
    SessionId,
    UserId: randomUUID(),
    RepositoryId: null,
    Revision: 0,
    Status: SessionStatus.Active,
    Segments: new Map(),
    Anchors: new Map(),
  },
]);
const endpoint = LLMContextFactory.CreateWorkerEndpoint(owner);
const worker = new Worker(new URL("./worker.mjs", import.meta.url), {
  workerData: { endpoint, SessionId },
  transferList: [endpoint.port],
});
try {
  const [[output], [exitCode]] = await Promise.all([
    once(worker, "message"),
    once(worker, "exit"),
  ]);
  assert.equal(exitCode, 0);
  assert.equal(output.status, "Applied");
  assert.equal(output.hits, 1);
  assert.equal(owner.GetStatistics().RetainedReads, 0);
  console.log(output);
} finally {
  await worker.terminate();
  owner.dispose();
}
```

Save the worker as `worker.mjs`:

```javascript
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import {
  ContextRole,
  TextContent,
  WorkerContextPeer,
} from "llmcontextlib-port-typescript";

const peer = new WorkerContextPeer(workerData.endpoint);
try {
  const result = peer.apply({
    SessionId: workerData.SessionId,
    ExpectedRevision: 0,
    Changes: [
      {
        kind: "AppendEntries",
        Entries: [
          {
            EntryId: randomUUID(),
            Role: ContextRole.User,
            CreatedAt: new Date().toISOString(),
            Content: new TextContent("A worker published this turn."),
            IndexKeys: ["origin:worker"],
          },
        ],
      },
    ],
  });
  assert.equal(result.Status, "Applied", result.Error);
  const synchronization = await peer.synchronizeIndexAsync(
    workerData.SessionId,
  );
  assert.equal(synchronization.Succeeded, true, synchronization.Error);
  const hits = peer.withCurrent(
    workerData.SessionId,
    (read) => read.SearchKeys(["origin:worker"], 16).length,
  );
  parentPort.postMessage({
    status: result.Status,
    revision: result.Revision,
    hits,
  });
} finally {
  peer.dispose();
}
```

Run `node .\main.mjs`. Expect `Applied`, revision `1`, one hit, worker exit, and
no retained read. Keep the owner event loop responsive while peers issue calls.
Do not await work in a borrowed `withCurrent` callback.

## Preparation, projection, and shutdown

Default-estimator native writes can use bounded offloaded preparation, including
WriteOptimized and unpartitioned text/deferred/producer-owned paths.
The owner rechecks admission, captured revision, and synchronization fences,
then publishes content/indexes atomically. A conflict is never transparently
rebased. Direct same-isolate calls, custom entry estimators, composed strategies,
and unsafe-to-transfer work can prepare inline.

Composed collectors and memos remain owner-local. Native/maintained deferred
collection and partition rebuilding have worker computation, but publication
remains owner-serialized. Two in-flight preparations do not establish
CPU-parallel service, throughput, or capacity.

Worker views use the default estimator when the owner uses it. A trusted endpoint
can authorize `{ AllowWorkerProjectionEstimator: true }`; the worker passes
`{ ProjectionSizeEstimator: estimate }` to `WorkerContextPeer`. This callback is
created in that worker and receives its actual local items. The owner still
admits the reported bytes. It does not replace the owner-local estimator or
transport arbitrary owner callbacks. This authorization is a TypeScript extension.

Stop issuing calls, release retained peer reads/views, dispose peers, and join
your workers before disposing the owner. Supported native/Lucene maintenance
quiesces before owner memo teardown. The bounded termination fallback for a
noncooperative custom worker is tracked separately from supported .NET parity.
Cancellation of partition waiting does not cancel shared maintenance.

## Optional text-mode adapters

Install the matching local adapter tarballs alongside core:

```powershell
npm install --no-audit --no-fund "$Port\dist\llmcontextlib-port-typescript-lucene-0.1.0.tgz" "$Port\dist\llmcontextlib-port-typescript-bitfaster-0.1.0.tgz"
```

These Node packages port collector/memo behavior; they do not load CLR libraries
or introduce a model tokenizer. In `adapters.mjs`:

```javascript
import { LLMContextFactory } from "llmcontextlib-port-typescript";
import {
  LuceneTermCollection,
  WithLuceneTermCollection,
} from "llmcontextlib-port-typescript-lucene";
import { WithBitFasterTermMemoization } from "llmcontextlib-port-typescript-bitfaster";

const builder = WithBitFasterTermMemoization(
  WithLuceneTermCollection(
    LLMContextFactory.Create(),
    LuceneTermCollection.RangeBuffer,
  ),
);
const owner = builder.Initialize([]);
try {
  console.log(owner.GetStatistics().Execution);
} finally {
  owner.dispose();
}
```

Run `node .\adapters.mjs`. `CharTerm` is the other maintained Lucene variant;
`WithoutTermMemoization()` removes the memo recipe. Reusing a builder creates
fresh owner-local state. Memo reservation counts toward active estimates
independently of retained roots. Producer-owned WriteOptimized does not use these
text strategies. The foreground LFU benchmark is **diagnostic-only**, not an
exported maintained adapter or a preset replacement.
