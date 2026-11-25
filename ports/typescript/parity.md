# Parity statement and qualification boundaries

**All identified supported-contract gaps are closed for the qualified profile.**
The port remains experimental, without a stable release, production
qualification, performance guarantee, or capacity/SLA claim.

## Identity and scope

| Item                            | Qualified identity                                                               |
| ------------------------------- | -------------------------------------------------------------------------------- |
| .NET reference                  | `479d2612315cbd292da917bae6d8d3fec35fea24`, read-only reference                  |
| Qualified implementation commit | `b2d3dfa567be7e0a17227e026f0e4dc8db6ad1e7`                                       |
| Target runtime                  | Node 22.23.5, V8 `12.4.254.21-node.57`, Windows x64, ESM                         |
| Tooling                         | Lockfile-resolved TypeScript 5.9.3; oracle SDK 9.0.321 under existing SDK policy |

These identify the implementation qualification before this documentation
publication, not all future revisions. Historical reference bootstrap validation
used SDK 9.0.320. Other Node versions, operating systems, browsers, arbitrary
custom providers, and CLR runtime/binary equivalence are not inferred from this
profile.

## Behavioral evidence

The committed tests, source exporters, fixtures, independent oracle, and target
verifiers support rerunning this qualification. See [validation](validation.md).
The following are recorded completed runs, not tests rerun on every docs edit:

| Evidence                                        | Matched scope                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Build, ESLint, Vitest                           | 112 tests across 20 files                                                                                                            |
| Mutation/accounting differential                | 15 snapshots                                                                                                                         |
| Partitioned and unchanged WriteOptimized traces | 7 snapshots each                                                                                                                     |
| WriteOptimized mixed worker differential        | 5 snapshots                                                                                                                          |
| Supported-contract trace                        | 90 observations: construction/copy, callback identity, projection accounting, equal-ID scopes, overflow/errors, follow-on recovery   |
| Configuration trace                             | 79 observations: nested limits, selectors, recipe replacement/reset and compatibility                                                |
| View trace                                      | 46 observations: all nine recipes, model selection, errors, retained captures and cleanup                                            |
| Lifecycle trace                                 | 13 observations: cancellation/shared waiting, failure/recovery, native/maintained shutdown before memo teardown                      |
| Admission oracle and mailbox tests              | Admitted read retains revision 0 while another writer publishes revision 1                                                           |
| Numeric/timestamp differentials                 | 4,217 arithmetic cases; 10,014 observations at 100 ns                                                                                |
| Text and record checks                          | Both framework lexical classifications across all 65,536 UTF-16 code units; typed record fixtures and comparisons                    |
| Clean installed adapters/workers                | 12 provider/memo/deferred combinations; 384 worker writes + 24 retained-key probes; zero residual read/output/preparation/index work |
| Independent finite replay                       | 125 steps in seven scenarios at both 128 and 512 entries; fresh retention/release checks                                             |
| Bounded concurrent replay/ramp                  | 2,304 / 2,160 reconciled request terminals across 12 cases each                                                                      |
| Memo diagnostics                                | 320 LRU traces / 76,800 observations; 72 foreground LFU AVX-path traces / 147,456 observations                                       |

The offline BuildInvestigation application also matches its pinned C# example.
Native replay/ramp cases observed two in-flight preparations, not proven
CPU overlap or parallel composed-adapter service.

## API inventory is not a parity percentage

Both net8.0 and net9.0 inventories agree on **611 member rows**: 304 declaration
mappings, 268 explicit record-operation mappings with differential evidence,
and 39 individually classified generated-surface rows. One of those 39 is the
supported options-copy scenario, realized through object spread; 38 are
language-generated differences. A mapping or evidence link alone is not
behavioral certification, and these counts are not a completion percentage.

The port preserves the equality used by the library: independently constructed
equal-ID memory scopes match policy/storage, while publication and content/key
change detection retain required reference identity. Typed helpers cover
supported record operations. General CLR `Equals(object)`, numeric CLR hash
identity, delegate representation, generated options formatting, and JavaScript
operator substitution are not advertised as equivalent APIs.

## Explicit runtime extensions and diagnostic limits

| Item                                                   | Disposition                                                                                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Transferable owner endpoints and `WorkerContextPeer`   | Explicit Node extension preserving one owning client, strict revisions, captures and admission                                    |
| Authorized worker-local projection estimator           | Separately tested extension; owner-local actual-item estimation remains paired parity                                             |
| Arbitrary cross-isolate closures/worker-local identity | No .NET transfer contract; not silently supported through cloning                                                                 |
| Noncooperative custom-worker termination fallback      | Separate extension limit; strict join is qualified for supported native/maintained paths, not arbitrary custom workers            |
| Between-partition failure injection                    | Target-only diagnostic, not paired source evidence                                                                                |
| Foreground LFU scalar aging                            | Unqualified: pinned BitFaster.Caching scalar run crashes in `EvictFromMain` after six traces; verifier rejects truncated matrices |

The maintained BitFaster adapter is LRU. The LFU scalar diagnostic failure does
not represent an unresolved supported public-library contract or a changed preset.

## Reproducibility and measurement honesty

The [implementation ledger](implementation-work-packet.md) records commands,
fixture/source fingerprints, historical outputs, and detailed dispositions.
Raw qualification outputs/manifests were retained locally; they are **not
included in this Git tree or npm tarballs**. Their local paths do not constitute
public downloadable evidence. Rerun the committed tools to obtain your own raw
artifacts; retain exact source/worktree, build, runtime, fixture, and command identity.

Logical estimates, V8 allocation/heap samples, RSS, and observed release are
different metrics. The bounded oracle-checked replays are correctness evidence,
not load capacity or a universal speedup. Forward/reverse diagnostics used
matched sources and fresh caches on a shared host; other host workloads were
not excluded. No broad timing, allocation, or GC superiority claim follows.
External application benchmark reports are not automatically library
qualification evidence.
