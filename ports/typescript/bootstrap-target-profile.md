# TypeScript port bootstrap profile

This is the resolved bootstrap/history record, not the current setup guide.
Start with the [port README](README.md), [walkthrough](walkthrough.md), and
[parity statement](parity.md). The library remains experimental.

## Source and authority
- Source repo: `D:\source\LLMContextLib`
- Source baseline commit: `479d2612315cbd292da917bae6d8d3fec35fea24`
- Canonical planning files: `D:\source\polymorhic\llmcontextlibport\porting.md`, `D:\source\polymorhic\llmcontextlibport\scaffold.md`
- Read-only reference checkout: `D:\source\LLMContextLib`

## Destination
- Implementation repository: same Git repository as the source, with an additive port layout
- Worktree: `D:\source\LLMContextLib-Ts`
- Branch: `port/typescript`
- Port root: `D:\source\LLMContextLib-Ts\ports\typescript`
- Output/evidence: worktree-local `ports/typescript` and node_modules from npm install

## Selected language/runtime
- Language: TypeScript / Node.js
- Runtime: Node.js 22 LTS
- Compiler: strict TypeScript; the manifest's `^5.7.3` range currently resolves through the existing lockfile to 5.9.3. No dependency upgrade was performed for qualification.
- Module system: ESM (`type: "module"`)
- Supported target profile: Node.js 22 LTS, not browsers. Validation uses the existing Node.js v22.23.5 executable at `C:\Users\felixlu\AppData\Local\npm-cache\_npx\52027bd8fc0022aa\node_modules\node\bin\node.exe`, prepended to PATH for npm. The original shell's Node 26 results are bootstrap history, not Node 22 evidence.

## Build and package
- Build system: a standalone npm package under the additive port directory; package builds emit the core and two optional adapter tarballs
- Package layout: `ports/typescript/{src,tests}` with additive `ports/conformance` only as required
- Dependency pins: `package-lock.json` records resolved versions; `package.json` declares compatible ranges.
- Commands: `npm ci`, `npm run build`, `npm test`

## API and runtime contract decisions
- Public surface is modeled as interface-driven modules, immutable value objects, and explicit error objects; no silent coercion of user-supplied values
- Revisions, sequences, cursors, segment IDs, index generations, public byte limits/estimators, aggregate reservations and long statistics support signed `Int64`. Values beyond the safe integer range use `bigint`. Pinned traces cover 4,217 arithmetic observations, cursor overflow, wide reservations, nested limits, and admission/release; this is a finite contract matrix, not exhaustive enumeration of all inputs.
- Native lexical classification and lowercase mapping matched the pinned .NET 8 and 9 Windows binaries for all 65,536 UTF-16 code units (49,335 admitted code units) on Node 22.23.5. This is not a full search differential.
- Offset timestamps use ISO text with an explicit UTC offset and up to seven fractional digits; expiry and precise injected clocks compare signed 100 ns ticks. Numeric clocks still accept epoch milliseconds.
- On Node 22.23.5, `tests/reference/admission-runtime.ts` showed that same-isolate `Atomics.wait` prevented a scheduled release, a worker isolate could wake the wait, and posting the release closure failed structured cloning. The pinned C# `AdmissionOracle` admitted a waiting read after another thread published revision 1 and released its lease; the admitted read still held captured revision 0. No asynchronous-only replacement is approved.
- A trusted `MessagePort` bridge pumps worker commands and offloaded write completions while synchronous resource admission is waiting. `LLMContextFactory.CreateWorkerEndpoint(client)` issues a transferable endpoint for `WorkerContextPeer`, without exporting the owner or storage. The installed package exercises session lookup, creation, removal, lazy `withCurrent` scopes, deferred indexing waits, and partition synchronization. Maintenance requests use separate reply ports so a pending wait does not consume synchronous replies; worker cancellation ends the caller's wait without cancelling shared partition maintenance. Bounded overlapping worker preparation covers partitioned `WriteOptimized` and unpartitioned text, deferred text, and producer-owned paths with the default entry estimator. Worker-local projections retain original values, with owner-side admission; a custom estimator requires explicit endpoint authorization and a callback created in the worker.
- Native and maintained Lucene deferred collection and producer-owned partition compaction compute on an owner-scoped worker. The owner alone owns the optional memo, publishes immutable results, releases reservations, and joins the maintenance protocol at disposal. A custom collector without a worker module still runs on the owner event loop.
- Canonical dashed GUIDs are case-insensitive throughout publication and lookup and are returned in lowercase. The port rejects malformed strings; canonical fixtures use deterministic GUIDs instead of aliases. This is the representation of an already-typed C# `Guid`, not a port of `Guid.Parse`.

## Testing and differential evidence
- Bootstrap test framework: Vitest + tsx
- Reference verified with SDK 9.0.320: Release build, both test frameworks (207 tests each), whitespace check, smoke with 128 entries, and all 12 bounded ramp cases. Evidence: `TestResults\port-reference-smoke-fd94e27b80ec40a19d144bd1a9137018.json` and `TestResults\port-reference-ramp-fd94e27b80ec40a19d144bd1a9137018\suite.json` in the reference checkout.
- Independent source oracle remains the read-only C# implementation in `D:\source\LLMContextLib`
- Current oracle builds resolve SDK 9.0.321 under the existing SDK policy. The 9.0.320 reference-build evidence above is historical; source and dependency pins are unchanged.
- Current Node 22 validation passes type checking, ESLint and 112 Vitest tests. Pinned supported-contract, configuration, lifecycle and view traces match 90, 79, 13 and 46 observations respectively. Both framework API inventories agree on 611 rows; generated CLR surface differences are explicitly classified, not counted as behavioral failures or a parity percentage.

## Bootstrap gate status
- Gate result: PASS for toolchain/bootstrap readiness
- Current qualification: all identified supported-contract gaps are closed for the stated profile. Keep the inventory current when changing session/index ownership, immutable publication, indexing, strategies, or adapters; see the parity statement and implementation ledger.
- Staging remains internal validation only; it does not authorize a partial completion claim or a deferred scope reduction
