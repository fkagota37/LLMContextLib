# Verify `WriteOptimized` from an installed package

This TypeScript port is experimental and has no stable release or compatibility
guarantee. This smoke check needs Node 22 and npm. It uses no adapters, external
services, or unpublished storage APIs.

From `ports\typescript`, build the local tarballs and run the installed-package
checks:

```powershell
npm run build:packages
npm run test:packages
```

Look for this sequence in the program's JSON output:

| Observation | Expected |
| --- | --- |
| First write against revision `0` | `Applied`, revision `1` |
| Second write against revision `0` | `RevisionConflict`, revision `1` |
| Index synchronization | One partition compacted; content stays at revision `1` |
| Search on the old capture | `started` at revision `0` |
| Search on the current capture | `completed` at revision `1`; neither old nor rejected key matches |
| Cleanup | No retained reads, view bytes, or pending synchronizations |

To run only the smoke program in your own application, install the core
`dist\llmcontextlib-port-typescript-0.1.0.tgz` tarball in the application, copy
`write-optimized-smoke.mjs` into it, then run `node write-optimized-smoke.mjs`.

The application creates one owner with
`LLMContextFactory.Create(LLMContextOptions.WriteOptimized).Initialize(sessions)`.
Provide explicit `IndexKeys` on entries and anchors, including imports and
replacements, and query with `SearchKeys`, not text `Search`. Use `WithCurrent`
for short synchronous lookups and dispose explicit captures when done. If
multiple workers share the owner, drain them before disposing it.

The installed-package suite also checks two overlapping preparations for
competing replacement-only batches. After compaction it checks a segment
replacement and an atomic transaction that replaces and deletes an old entry
and appends a new one. A bounded worker pool prepares these requests; the owner
still admits and publishes each candidate. Calls using custom estimators or
composed strategies can still prepare on the owner. This is not a capacity or
production-readiness check.

Worker views can use the built-in size estimator when the owner uses that default.
For a trusted worker that needs its own estimator, create the endpoint with
`LLMContextFactory.CreateWorkerEndpoint(client, { AllowWorkerProjectionEstimator: true })`
and pass `{ ProjectionSizeEstimator: estimate }` to `new WorkerContextPeer(endpoint, options)`
in the worker. `estimate` receives the original items, including values that
cannot be sent between threads. The owner checks the reported byte total against
its budgets. The worker does not inherit or replace the estimator for owner-local views.
