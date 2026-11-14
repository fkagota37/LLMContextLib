# Lucene-backed term collection diagnostic

Experimental, isolated comparison of the current `ContextPolicies.Terms` policy,
an output-sorting control, the earlier normalized-range prototype, and two
Lucene-backed collectors. This is **not** a Lucene search backend or a proposed
production dependency. This project is deliberately outside `LLMContextLib.sln`
and is not referenced by the library, main benchmark project, tests, or example.

The package is pinned to `Lucene.Net.Analysis.Common` **4.8.0-beta00018**; the
generated lock file also fixes transitive dependencies. Do not silently substitute
another version. The library's UTF-16 `char.IsLetterOrDigit` boundaries,
`char.ToLowerInvariant` casing, distinctness, ordinal ordering, and immutable
string-array output must all remain unchanged.

## What is actually compared?

| Method | Collection and materialization |
|---|---|
| Current | Real production method; strings created for every word occurrence |
| DirectSort | Same collection, exact-capacity sorted immutable output |
| NormalizedRanges | Whole-text normalized copy, deduplicated ranges, distinct strings |
| LuceneCharTerm | `CharTermAttribute` scratch buffer and `CharArraySet` |
| LuceneRangeBuffer | Range-scanned/lowercased scratch buffer and `CharArraySet` |

Both Lucene methods use the **slice** `Add(buffer, offset, length)` overload.
It checks membership before copying a new character-array key. This avoids
per-occurrence strings and keeps subsequent scratch-buffer reuse safe. Do not
change it to `Add(buffer)`: that overload can retain the caller's mutable array.
String output is created once per distinct set member, after collection.
All collectors are call-local; no interning, shared mutable state, reusable
cross-request buffers, or cache warm-state advantage participates.

## Restore, build, and verify

Run from the repository root with its pinned SDK:

```powershell
$project = 'benchmarks\LLMContextLib.TokenizationBenchmarks\LLMContextLib.TokenizationBenchmarks.csproj'
dotnet restore $project --source https://api.nuget.org/v3/index.json --locked-mode
dotnet build $project -c Release --no-restore
foreach ($framework in @('net8.0', 'net9.0')) {
    dotnet "benchmarks\LLMContextLib.TokenizationBenchmarks\bin\Release\$framework\LLMContextLib.TokenizationBenchmarks.dll" --verify-only
}
```

Verification covers the eight measurement fixtures, all 65,536 UTF-16 code units
separated by boundaries, adversarial buffer reuse, two long words, and 2,000
deterministic random strings. It additionally checks null handling, Turkish
culture, stable returned arrays, and concurrent calls. Every measurement run
repeats verification before collecting samples.

Some package mirrors lack beta00018. On the measurement machine the official
NuGet v3 endpoint also failed its TLS handshake, while the official v2 package
download route worked without relaxing TLS validation. If needed, download the
two exact official packages into an ignored local source and restore transitive
dependencies from the configured mirror:

```powershell
$packages = Join-Path $PWD 'TestResults\LuceneTerms\packages'
New-Item -ItemType Directory -Force -Path $packages | Out-Null
foreach ($id in @('Lucene.Net', 'Lucene.Net.Analysis.Common')) {
    curl.exe --location --fail --output "$packages\$id.4.8.0-beta00018.nupkg" `
        "https://www.nuget.org/api/v2/package/$id/4.8.0-beta00018"
    if ($LASTEXITCODE -ne 0) { throw "Download failed: $id" }
}
dotnet restore $project --locked-mode `
    --configfile benchmarks\LLMContextLib.TokenizationBenchmarks\NuGet.Fallback.Config
```

## Collect bounded evidence

```powershell
foreach ($framework in @('net8.0', 'net9.0')) {
    $probe = "benchmarks\LLMContextLib.TokenizationBenchmarks\bin\Release\$framework\LLMContextLib.TokenizationBenchmarks.dll"
    dotnet $probe "TestResults\LuceneTerms\$framework-forward.json"
    dotnet $probe "TestResults\LuceneTerms\$framework-reverse.json" --reverse
}
& benchmarks\LLMContextLib.TokenizationBenchmarks\Analyze.ps1
```

Each process warms every method/fixture, then records seven rounds with rotating
and reversed method order. Inputs are prebuilt. Per-call measurements include
all collection, casing, deduplication, sorting, and output allocations. Report
medians over all fourteen samples per fixture/method, retaining both raw reports.
This is an in-process diagnostic, **not BenchmarkDotNet isolation or application
throughput evidence**; tiered JIT, GC, and shared-machine noise still affect timing.

Separate heap samples retain 256 output arrays and use full managed collections.
They measure incremental live **returned output**, not process working set or
the cost of loading/JIT-compiling Lucene. No forced collections occur in the
timed loops. Scratch buffers, key arrays, and sets must not escape with results.
Reports retain SDK/runtime/GC metadata, dependency metadata, raw samples, and
SHA-256 hashes of the actual binaries, policy, probe sources, project, and lock file.
`Analyze.ps1` verifies source/assembly hashes and report completeness, then writes
`summary.json` and `tokenization.csv` beside the raw reports.

## Measured result

Measured with SDK 9.0.320 on Windows x64, workstation GC, and default tiering:
.NET 8.0.34 and .NET 9.0.22, two processes per runtime, fourteen timed samples per
fixture/method and six retained-output samples per applicable fixture/method.
All runs passed the 2,013 parity inputs and the additional lifetime/concurrency
checks. Raw evidence is under ignored `TestResults\LuceneTerms`; the runnable
implementation, exact package lock, and analyzer are maintained in this project.

Median **allocated bytes per call on .NET 9**:

| Fixture | Current | DirectSort | NormalizedRanges | LuceneCharTerm | LuceneRangeBuffer |
|---|---:|---:|---:|---:|---:|
| Empty | 256 | 168 | 88 | 440 | 272 |
| Query | 712 | 528 | 472 | 776 | 688 |
| Repeated: 512 occurrences, 2 distinct | 19,032 | 18,848 | 7,600 | 776 | 688 |
| Repeated tool JSON | 16,472 | 16,176 | 8,456 | 1,824 | 1,816 |
| Unique: 512 distinct | 65,584 | 59,280 | 69,464 | 82,608 | 82,488 |
| Repeated Unicode | 26,240 | 25,992 | 8,696 | 1,144 | 1,016 |
| One 16,384-character word | 121,680 | 121,624 | 33,056 | 372,896 | 98,760 |
| Punctuation only | 256 | 168 | 8,304 | 440 | 272 |

.NET 8 showed the same allocation tradeoffs: the repeated fixture fell from
19,000 to 688 bytes with the range-buffer collector, while the unique fixture
increased from 65,552 to 82,488 bytes.

The Lucene set avoids occurrence-by-occurrence strings and wins substantially
when many words repeat. Its distinct-key character-array copies become extra
temporary storage when most words are unique. Incremental `CharTermAttribute`
growth also allocated over three times the current policy on the single-long-word
fixture; range-sizing the scratch buffer avoided that particular growth cost.

Timing is directional, not a general speed claim. The following values are
**microseconds per call**, lower is better. Each value is the median of fourteen
batch-average timings across two processes, NOT the p50 of individually timed
calls. Per-request p95/p99 and end-to-end application latency were not measured.

| Runtime | Fixture | Current | LuceneCharTerm | LuceneRangeBuffer |
|---|---|---:|---:|---:|
| .NET 8.0.34 | Repeated words | 23.52 | 13.62 | 17.54 |
| .NET 8.0.34 | Repeated tool JSON | 29.02 | 20.73 | 21.95 |
| .NET 8.0.34 | 512 distinct words | 62.77 | 113.57 | 114.10 |
| .NET 8.0.34 | One long word | 35.61 | 63.12 | 40.37 |
| .NET 9.0.22 | Repeated words | 24.93 | 15.07 | 19.94 |
| .NET 9.0.22 | Repeated tool JSON | 15.52 | 9.33 | 9.88 |
| .NET 9.0.22 | 512 distinct words | 49.35 | 92.38 | 88.57 |
| .NET 9.0.22 | One long word | 34.68 | 78.27 | 47.27 |

Individual process results varied substantially; these measurements do not
establish end-to-end session throughput or GC behavior. In particular, the range
buffer reduced long-word allocation but did not reduce its measured time per call.

Retaining 256 results for the repeated fixture used 28,672 incremental live bytes
for every method; the 512-distinct fixture used 6,297,600 bytes for every method.
Long-word retained output was also approximately the same. Therefore this
experiment **does not reduce the per-entry term-cache footprint**: the output is
still the same distinct strings and immutable array. Temporary sets/key arrays
do not survive, but the cost of loaded assemblies and runtime infrastructure is
outside those output-only deltas.

The deployed package DLLs totaled about 7.25 MiB, excluding the library and probe:
Lucene.Net.Analysis.Common, Lucene.Net, J2N, and the two Microsoft.Extensions
dependencies. This is deployment-file size, **not** measured resident heap.
Actual assembly sizes/hashes and selected dependency versions are in every report.

Production promotion would additionally require realistic mutation/query workloads
and capacity measurements. A smaller temporary allocation on repeated words does
not prove lower GC pauses, cheaper unique-word input, or better session throughput.
The result justifies continued workload-specific evaluation, not a blanket
replacement of `ContextPolicies.Terms`. Production remains unchanged by this
experiment, and a full Lucene search backend has not been evaluated.
