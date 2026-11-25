# TypeScript walkthrough

This experimental walkthrough uses one installed core package, Node 22, and
PowerShell. It needs no adapters or external services. The example is an
application, not an import of internal storage.

## 1. Build and install the local package

From `ports\typescript`, after the [README setup](README.md#run-it-now):

```powershell
$Port = (Get-Location).Path
npm run build:packages
New-Item -ItemType Directory -Force "$Port\dist\walkthrough-consumer" | Out-Null
Set-Location "$Port\dist\walkthrough-consumer"
npm init -y
npm install --no-audit --no-fund "$Port\dist\llmcontextlib-port-typescript-0.1.0.tgz"
```

The versioned filename is the current local build output, not a compatibility
promise. Use the generated filename if the package version changes.

## 2. Publish, capture, search, and assemble

Save this as `app.mjs` in the consumer directory:

```javascript
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  ContextMutationStatus,
  ContextRole,
  ContextViews,
  LLMContextFactory,
  LLMContextOptions,
  SessionStatus,
  TextContent,
} from "llmcontextlib-port-typescript";

const SessionId = randomUUID();
const EntryId = randomUUID();
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
let snapshot;
let model;
try {
  const first = owner.Apply({
    SessionId,
    ExpectedRevision: 0,
    Changes: [
      {
        kind: "AppendEntries",
        Entries: [
          {
            EntryId,
            Role: ContextRole.User,
            CreatedAt: new Date().toISOString(),
            Content: new TextContent("The build investigation started."),
            IndexKeys: ["topic:build", "state:started"],
          },
        ],
      },
    ],
  });
  assert.equal(first.Status, ContextMutationStatus.Applied, first.Error);
  snapshot = owner.OpenRead(SessionId);

  const replacement = {
    SessionId,
    ExpectedRevision: first.Revision,
    Changes: [
      {
        kind: "ReplaceEntry",
        EntryId,
        Content: new TextContent("The build investigation completed."),
        IndexKeys: ["topic:build", "state:completed"],
      },
    ],
  };
  const second = owner.Apply(replacement);
  const stale = owner.Apply(replacement);
  assert.equal(second.Status, ContextMutationStatus.Applied, second.Error);
  assert.equal(stale.Status, ContextMutationStatus.RevisionConflict);
  const synchronized = await owner.SynchronizeIndexAsync(
    SessionId,
    AbortSignal.timeout(8000),
  );
  assert.equal(synchronized.Succeeded, true, synchronized.Error);
  assert.equal(synchronized.ContentRevision, second.Revision);

  const current = owner.WithCurrent(SessionId, (read) => {
    assert.equal(read.SearchKeys(["state:started"], 16).length, 0);
    return read.SearchKeys(["state:completed"], 16);
  });
  assert.equal(current.length, 1);
  assert.equal(snapshot.Session.Revision, first.Revision);
  assert.equal(snapshot.SearchKeys(["state:started"], 16).length, 1);
  assert.equal(snapshot.SearchKeys(["state:completed"], 16).length, 0);

  const contextRequest = {
    TokenBudget: 512,
    EstimateTokens: (text) => Math.ceil(text.length / 4),
  };
  model = owner.OpenView(
    ContextViews.Model(
      SessionId,
      contextRequest.TokenBudget,
      contextRequest.EstimateTokens,
    ),
  );
  assert.equal(model.length, 1);
  console.log(
    JSON.stringify(
      {
        writes: [first.Status, second.Status, stale.Status],
        capturedRevision: snapshot.Session.Revision,
        currentRevision: model.SessionRevision,
        search: current.map((hit) => hit.Snippet),
        modelInput: [...model].map((item) => item.Text),
      },
      null,
      2,
    ),
  );

  model.dispose();
  snapshot.dispose();
  const stats = owner.GetStatistics();
  assert.equal(stats.RetainedReads, 0);
  assert.equal(stats.EstimatedViewBytes, 0);
  assert.equal(stats.PendingSynchronizations, 0);
  console.log(
    "Cleanup: no retained reads, view bytes, or pending synchronizations.",
  );
} finally {
  model?.dispose();
  snapshot?.dispose();
  owner.dispose();
}
```

Run it:

```powershell
node .\app.mjs
```

Expected: `Applied`, `Applied`, `RevisionConflict`; captured revision `1`,
current revision `2`; completed text in both the current search and model input;
then the verified cleanup message. The old snapshot still sees the started text.

## 3. Interpret the boundaries

`ExpectedRevision` prevents stale writes. A conflict is a result to handle,
not an instruction for the library to retry. Every producer-owned replacement
supplies its complete keys; obsolete keys disappear from current search.
Synchronization changes index maintenance state, not the content revision.

`WithCurrent` borrows a synchronous read and releases it on callback exit.
Do not return the handle, make the callback async, or retain it for later use.
`OpenRead` and `OpenView` are explicit retained captures; dispose them yourself.
Caller-owned returned data is different from a live library handle.

`contextRequest` belongs to the application. Its budget is a context property,
not a new stored library field or a library-managed allocation. The character
heuristic above only makes the example offline; replace it with your model's
estimator. Account separately for provider framing, tool schemas, and output
headroom. Assembly selects fitting context and preserves whole tool pairs; it
does not call a model, summarize, prune storage, or renegotiate a budget.

Continue with [architecture](architecture.md), [configuration](configuration.md),
or [worker integration](worker-integration.md).
