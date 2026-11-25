# LLMContextLib TypeScript port

> **Experimental / work in progress. Not production-ready.**
> There is no stable release or compatibility guarantee. The `0.1.0` package
> version identifies local evaluation packages, not a stable public npm release.

One owning client stores immutable conversation sessions and scoped memory.
Applications read conversation, navigation, search, tool, and model-input views
of that context without maintaining a second writable transcript.

**Supported-contract and observable-behavior parity is qualified against .NET
commit `479d2612315cbd292da917bae6d8d3fec35fea24` on Node 22.23.5, Windows x64,
ESM.** This is not CLR runtime emulation, production certification, or a promise
that every host has been qualified. See [parity](parity.md).

## Run it now

Use Node 22 and npm. From the repository root in PowerShell:

```powershell
Set-Location .\ports\typescript
node --version
npm ci
npm run build:packages
npm run test:packages
```

The last command installs the built packages in temporary clean applications,
runs the [WriteOptimized smoke application](examples/write-optimized-smoke.mjs),
and checks worker and optional-adapter combinations. The smoke prints actual
write/conflict outcomes, old/current search results, compaction, and cleanup.
No model service, database, or .NET runtime is needed for these package checks.

For your own application, follow the [walkthrough](walkthrough.md). Start with
`LLMContextFactory.Create(LLMContextOptions.WriteOptimized).Initialize(sessions)`;
your application supplies exact search labels on entries and anchors. You do
not construct storage partitions.

## Packages

`npm run build:packages` emits these private local tarballs in `dist`:

| Package                                   | Purpose                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| `llmcontextlib-port-typescript`           | Owning client, public contracts, views, policies, native indexing, worker peer |
| `llmcontextlib-port-typescript-lucene`    | Optional ported term-collection variants                                       |
| `llmcontextlib-port-typescript-bitfaster` | Optional bounded owner-local LRU term memo                                     |

The core does not depend on either adapter. Adapters require the matching core
package. Install the tarballs, not an assumed public-registry release. Installed
packages contain compiled ESM and type declarations, including their worker
modules. The checkout's source exports are for development with TypeScript tooling.

## Documentation

| Guide                                                        | What it answers                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| [Walkthrough](walkthrough.md)                                | Install locally, publish a turn, retain a snapshot, search, assemble model input, clean up        |
| [Architecture and contracts](architecture.md)                | Ownership, revisions, identity, snapshots, search modes, memory, token-budget boundary            |
| [Configuration](configuration.md)                            | Ordinary defaults versus WriteOptimized, copying options, resource estimates, callbacks           |
| [Workers and adapters](worker-integration.md)                | Share one owner across worker callers, compose adapters, drain and dispose                        |
| [Parity](parity.md)                                          | What matched, exact reference/profile, generated API differences, extension and diagnostic limits |
| [Validation](validation.md)                                  | Development checks, pinned differentials, inventories, replay/ramp and evidence rules             |
| [Installed WriteOptimized smoke](examples/WriteOptimized.md) | Small existing integrator recipe and expected observations                                        |

The [bootstrap profile](bootstrap-target-profile.md) records resolved toolchain
choices; the [implementation ledger](implementation-work-packet.md) retains
engineering history and detailed qualification evidence. They are not setup
instructions or approval gates.

## Boundary and license

The caller owns tools, models, persistence, scheduling, and **token budgets as
context properties**. The library honors supplied selection constraints; it is
not a budget allocator, tokenizer, model runtime, or autonomous-agent framework.
`ReadRange` limits items, not tokens.

MIT licensed under the repository [LICENSE](../../LICENSE). Existing source and
dependency attribution is retained. See the [repository README](../../README.md)
for the .NET implementation.
