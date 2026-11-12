// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using LLMContextLib;

namespace LLMContextLib.Benchmarks;

public enum PressurePoint { Contention, Snapshots, Deletion, IndexPayoff, Admission }
public sealed record PressureCase(
    PressurePoint Point, ParticipantKind Participant, int Entries, string Position = "begin",
    int ChangedCharacters = 512, int SearchPercent = 50, int Iterations = 20, int Warmups = 5)
{
    public string Name => $"{Point}-{Participant}-n{Entries}-{Position}-c{ChangedCharacters}-s{SearchPercent}";
}
public sealed record PressureRequest(
    string Category, int Iteration, string Status, long StartedTicks, double ElapsedMs,
    long AllocatedBytes, double? ReadLockWaitMs, double? WriteLockWaitMs, double? ReadAdmissionMs,
    int? AdmissionWaits, int? CompactedEntries, int? RebuiltLocations, int? SnapshotReferences);
public sealed record PressureLatency(
    string Category, string Status, int Samples, double MeanMs, double P50Ms, double P95Ms, double P99Ms);
public sealed record PressureMemory(
    string Phase, int Held, long ManagedBytes, long HeapBytes, long PrivateBytes, long WorkingSet,
    long AllocatedTotalBytes, long? EstimatedRetainedBytes);
public sealed record PressureResult(
    PressureCase Case, string Participant, string[] Notes, double ElapsedMs,
    ImmutableArray<PressureRequest> Requests, ImmutableArray<PressureLatency> Latencies,
    ImmutableArray<PressureMemory> Memory, int Gen0, int Gen1, int Gen2);

/// <summary>
/// Bounded mechanism experiments, not a saturation benchmark. Each CLI case is isolated in a
/// fresh process. Timed finite operations exclude fixture/setup and full-value validation;
/// setup costs are separately sampled. O(Q log Q) percentile aggregation is outside timing.
/// Nearest-rank tails retain raw samples/N and are not confidence bounds or production SLAs.
/// </summary>
public static class PressureBenchmarks
{
    public static IEnumerable<PressureCase> Cases()
    {
        foreach (var kind in Enum.GetValues<ParticipantKind>())
        {
            foreach (int n in new[] { 2048, 16384 })
                yield return new(PressurePoint.Contention, kind, n, Iterations: 32);
            foreach (int n in new[] { 512, 4096, 16384 })
            {
                yield return new(PressurePoint.Snapshots, kind, n, Iterations: 8);
                foreach (string position in new[] { "begin", "middle", "end" })
                    yield return new(PressurePoint.Deletion, kind, n, position);
            }
            foreach (int size in new[] { 128, 8192, 32768 })
                foreach (int search in new[] { 0, 50, 90 })
                    yield return new(PressurePoint.IndexPayoff, kind, 1024, ChangedCharacters: size, SearchPercent: search);
            yield return new(PressurePoint.Admission, kind, 512, Iterations: 8);
        }
    }

    public static async Task<int> RunSuite(string? output, string[] arguments)
    {
        if (output is null) throw new ArgumentException("--pressure requires a new --output directory.");
        string directory = Path.GetFullPath(output);
        if (Directory.Exists(directory)) throw new ArgumentException("Pressure output directory already exists.");
        Directory.CreateDirectory(directory);
        var reports = new List<object>();
        foreach (var descriptor in Cases())
        {
            string json = Path.Combine(directory, descriptor.Name + ".json");
            var start = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            };
            foreach (string argument in new[] { Assembly.GetExecutingAssembly().Location, "--pressure-case",
                JsonSerializer.Serialize(descriptor), "--output", json })
                start.ArgumentList.Add(argument);
            using var process = Process.Start(start) ?? throw new InvalidOperationException("Child start failed.");
            var stdout = process.StandardOutput.ReadToEndAsync();
            var stderr = process.StandardError.ReadToEndAsync();
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(120));
            bool timedOut = false;
            try { await process.WaitForExitAsync(deadline.Token); }
            catch (OperationCanceledException)
            {
                timedOut = true;
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync();
            }
            await File.WriteAllTextAsync(Path.Combine(directory, descriptor.Name + ".log"),
                await stdout + Environment.NewLine + await stderr);
            if (timedOut || process.ExitCode != 0)
            {
                reports.Add(new { descriptor, timedOut, process.ExitCode });
                RunEvidence.Save(Path.Combine(directory, "suite.json"), "Pressure suite failed; completed evidence retained", reports, arguments);
                return 1;
            }
            using var document = JsonDocument.Parse(await File.ReadAllTextAsync(json));
            reports.Add(document.RootElement.GetProperty("Reports").Clone());
            Console.WriteLine($"{descriptor.Name} PASS");
        }
        RunEvidence.Save(Path.Combine(directory, "suite.json"),
            "72 bounded isolated pressure cases; per-request instrumentation; no saturation/SLA claim", reports, arguments);
        return 0;
    }

    public static async Task<PressureResult> RunCase(PressureCase descriptor)
    {
        if (descriptor.Entries < 32 || descriptor.Iterations is < 1 or > 128 ||
            descriptor.Warmups is < 0 or > 10 || descriptor.ChangedCharacters is < 1 or > 32768 ||
            descriptor.SearchPercent is < 0 or > 100)
            throw new ArgumentOutOfRangeException(nameof(descriptor));
        var requests = new List<PressureRequest>();
        var memory = new List<PressureMemory>();
        var notes = new List<string>
        {
            "Synthetic 512-character base entries; fixed seed 1729; fixture/seeding and oracle work excluded from operation timings.",
            "Managed allocation is current-thread operation allocation, including common replay consumption; not a process/resident byte measurement.",
            "Conventional lock/admission/copy counters are opt-in observations; segmented internal waits/compaction counters are unavailable (null).",
            "Per-operation timer/instrumentation overhead is included; short samples are descriptive, not tail SLAs.",
            "GC collection counts cover the entire case, including setup, validation and explicitly forced collections; they are not operation-only counts.",
            "Opt-in conventional instrumentation also leaves disabled branches in ordinary calls; this source snapshot is not the unchanged correction baseline.",
            "Single child per case; fixed participant order between children; no machine-wide settings changed."
        };
        int gen0 = GC.CollectionCount(0), gen1 = GC.CollectionCount(1), gen2 = GC.CollectionCount(2);
        double elapsed;
        switch (descriptor.Point)
        {
            case PressurePoint.Contention:
                elapsed = await Contention(descriptor, requests, memory);
                notes.Add("Two full-history range readers and one point writer, barrier-coordinated each round; throughput includes coordination, not maximum capacity.");
                break;
            case PressurePoint.Snapshots:
                elapsed = Snapshots(descriptor, requests, memory);
                notes.Add("All snapshots are held through growth. Explicit forced-GC phases are separate diagnostics, never normal operation timings.");
                break;
            case PressurePoint.Deletion:
            case PressurePoint.IndexPayoff:
                elapsed = Finite(descriptor, requests, memory);
                notes.Add("Fresh participant per replay; five warmups/twenty measured by default. Initialization sampled separately; no forced GC in finite replay.");
                break;
            case PressurePoint.Admission:
                elapsed = await Admission(descriptor, requests, memory);
                notes.Add("Read-count limits/timeouts exist in all participants. Resident/retained byte admission and finite write commit-gate timeout are ABSENT from conventional participants.");
                notes.Add("Byte-pressure outcomes are guarantee gaps, NOT equivalent-performance comparisons. Segmented byte accounting is conservative estimation, not a hard heap cap.");
                notes.Add("Admission is a lifecycle diagnostic, not a warmed finite replay. Release is requested after a 10ms delay against a 100ms timeout; scheduling can still cause rejection.");
                break;
            default: throw new ArgumentOutOfRangeException(nameof(descriptor));
        }
        var array = requests.ToImmutableArray();
        return new(descriptor, descriptor.Participant.ToString(), notes.ToArray(), elapsed, array, Summarize(array),
            memory.ToImmutableArray(), GC.CollectionCount(0) - gen0, GC.CollectionCount(1) - gen1, GC.CollectionCount(2) - gen2);
    }

    private static ContextFixture Fixture(PressureCase descriptor) =>
        ContextFixture.Create("Interactive", entryCount: descriptor.Entries);

    private static PressureRequest Measure(
        ParticipantKind kind, string category, int iteration, Func<string> action)
    {
        var counters = kind == ParticipantKind.LLMPolymorphic ? null : new PressureInstrumentation();
        PressureInstrumentation.Current = counters;
        long allocated = GC.GetAllocatedBytesForCurrentThread();
        long started = Stopwatch.GetTimestamp();
        string status;
        double elapsed;
        try { status = action(); }
        finally
        {
            elapsed = Stopwatch.GetElapsedTime(started).TotalMilliseconds;
            allocated = GC.GetAllocatedBytesForCurrentThread() - allocated;
            PressureInstrumentation.Current = null;
        }
        static double Ms(long ticks) => ticks * 1000d / Stopwatch.Frequency;
        return new(category, iteration, status, started, elapsed, allocated,
            counters is null ? null : Ms(counters.ReadWaitTicks),
            counters is null ? null : Ms(counters.WriteWaitTicks),
            counters is null ? null : Ms(counters.AdmissionTicks), counters?.AdmissionWaits,
            counters?.CompactedEntries, counters?.RebuiltLocations, counters?.SnapshotReferences);
    }

    private static void Sample(List<PressureMemory> samples, string phase, int held, IContextBenchmarkParticipant participant)
    {
        using var process = Process.GetCurrentProcess();
        process.Refresh();
        samples.Add(new(phase, held, GC.GetTotalMemory(false), GC.GetGCMemoryInfo().HeapSizeBytes,
            process.PrivateMemorySize64, process.WorkingSet64, GC.GetTotalAllocatedBytes(),
            (participant as PolymorphicContextParticipant)?.Statistics.EstimatedRetainedBytes));
    }

    private static ImmutableArray<PressureLatency> Summarize(ImmutableArray<PressureRequest> samples) =>
        samples.GroupBy(sample => (sample.Category, sample.Status)).Select(group =>
        {
            double[] values = group.Select(sample => sample.ElapsedMs).Order().ToArray();
            double Rank(double fraction) => values[(int)Math.Ceiling(values.Length * fraction) - 1];
            return new PressureLatency(group.Key.Category, group.Key.Status, values.Length,
                values.Average(), Rank(.50), Rank(.95), Rank(.99));
        }).ToImmutableArray();

    private static double Finite(PressureCase descriptor, List<PressureRequest> requests, List<PressureMemory> memory)
    {
        // Setup is deliberately independent of the measured replay: rebuilding an index is
        // O(total seeded characters/postings), not part of a steady-state point correction.
        // A deletion still exposes the conventional O(N) compaction/location rebuild even
        // at the last position. Twenty-action payoff traces vary changed-text work without
        // conflating it with seeding. Oracle/full-value comparisons run outside the timer.
        var fixture = Fixture(descriptor);
        var entries = ContextPolicies.Entries(fixture.Sessions[0]).ToImmutableArray();
        Guid session = fixture.Sessions[0].SessionId;
        var trace = ImmutableArray.CreateBuilder<ReplayAction>();
        if (descriptor.Point == PressurePoint.Deletion)
        {
            int position = descriptor.Position switch
            {
                "begin" => 0,
                "middle" => entries.Length / 2,
                "end" => entries.Length - 1,
                _ => throw new ArgumentException("Unknown deletion position.")
            };
            trace.Add(new(ReplayActionKind.Change, session, 0, Changes: [new DeleteEntry(entries[position].EntryId)]));
        }
        else
        {
            long revision = 0;
            int writes = 20 * (100 - descriptor.SearchPercent) / 100;
            for (int i = 0; i < 20; i++)
            {
                // Spread writes across a replay instead of placing all searches after a write burst.
                bool write = (i + 1) * writes / 20 > i * writes / 20;
                if (write)
                    trace.Add(new(ReplayActionKind.Change, session, revision++,
                        Changes: [new ReplaceEntry(entries[4].EntryId,
                            new TextContent(Payload(descriptor.ChangedCharacters, $"changed{i}")))]));
                else
                    trace.Add(new(ReplayActionKind.Read, session,
                        Request: new(ContextReadKind.Search, Query: i % 2 == 0 ? "context" : "entry0x7")));
            }
        }
        var actions = trace.ToImmutable();
        using var oracle = new SemanticOracle(fixture);
        var expected = ReplayEngine.Execute(oracle, actions);
        var expectedEntries = oracle.Read(session, new(ContextReadKind.Range, Limit: int.MaxValue)).Entries;
        using (var check = BenchmarkParticipants.Create(descriptor.Participant, fixture))
        {
            ReplayChecks.AssertEquivalent(expected, ReplayEngine.Execute(check, actions), descriptor.Name);
            CheckEntries(expectedEntries, check.Read(session, new(ContextReadKind.Range, Limit: int.MaxValue)).Entries);
        }
        double elapsed = 0;
        for (int iteration = -descriptor.Warmups; iteration < descriptor.Iterations; iteration++)
        {
            IContextBenchmarkParticipant participant = null!;
            var setup = Measure(descriptor.Participant, "Initialization", iteration, () =>
            {
                participant = BenchmarkParticipants.Create(descriptor.Participant, fixture);
                return "Completed";
            });
            using (participant)
            {
                var sample = Measure(descriptor.Participant, "Replay", iteration, () =>
                {
                    var actual = ReplayEngine.Execute(participant, actions);
                    if (actual.Digest != expected.Digest) throw new InvalidOperationException("Replay digest changed.");
                    return "Completed";
                });
                if (iteration >= 0)
                {
                    requests.Add(setup);
                    requests.Add(sample);
                    elapsed += sample.ElapsedMs;
                }
                // Full values, not just digests, were compared before timing. Validate every
                // resulting entry after timing too; no read/copy cost is charged to deletion.
                CheckEntries(expectedEntries, participant.Read(session, new(ContextReadKind.Range, Limit: int.MaxValue)).Entries);
                if (iteration == descriptor.Iterations - 1) Sample(memory, "final", 0, participant);
            }
        }
        return elapsed;
    }

    private static void CheckEntries(ImmutableArray<ContextEntry> expected, ImmutableArray<ContextEntry> actual)
    {
        if (!expected.SequenceEqual(actual)) throw new InvalidOperationException("Final full-value entry comparison failed.");
    }

    private static string Payload(int length, string marker)
    {
        string text = marker + " context ";
        return (text + string.Concat(Enumerable.Repeat("payload ", length / 8 + 1)))[..length];
    }

    private static async Task<double> Contention(
        PressureCase descriptor, List<PressureRequest> requests, List<PressureMemory> memory)
    {
        // Dedicated workers avoid thread-pool starvation from the deliberately blocking
        // readers/barrier. The O(N) result materialization remains inside each read timer;
        // the immutable order tree additionally pays its per-entry addressing cost.
        // Coordination, O(N) full-value checks and history validation are outside request
        // timing but inside wall-clock throughput. No free-running capacity is inferred.
        var fixture = Fixture(descriptor);
        Guid session = fixture.Sessions[0].SessionId;
        var originals = ContextPolicies.Entries(fixture.Sessions[0]).ToImmutableArray();
        var original = originals[4];
        var range = new ContextReadRequest(ContextReadKind.Range, Limit: descriptor.Entries);
        using (var warm = BenchmarkParticipants.Create(descriptor.Participant, fixture))
            for (int i = 0; i < descriptor.Warmups; i++)
            {
                _ = warm.Read(session, range);
                if (warm.Apply(new(session, i, [new ReplaceEntry(original.EntryId, new TextContent($"warm{i}"))])).Status != ContextMutationStatus.Applied)
                    throw new InvalidOperationException("Warmup failed.");
            }
        using var participant = BenchmarkParticipants.Create(descriptor.Participant, fixture);
        Sample(memory, "initial", 0, participant);
        var observations = new ConcurrentBag<(long Revision, string Text)>();
        var samples = new ConcurrentBag<PressureRequest>();
        using var ready = new CountdownEvent(3);
        using var start = new ManualResetEventSlim();
        using var round = new Barrier(3);
        var tasks = Enumerable.Range(0, 3).Select(worker => Task.Factory.StartNew(() =>
        {
            ready.Signal();
            start.Wait();
            for (int i = 0; i < descriptor.Iterations; i++)
            {
                if (!round.SignalAndWait(TimeSpan.FromSeconds(30))) throw new TimeoutException("Pressure round timed out.");
                ContextObservation? read = null;
                var change = new ContextChangeSet(session, i, [new ReplaceEntry(original.EntryId, new TextContent($"version{i + 1}"))]);
                var sample = Measure(descriptor.Participant, worker == 2 ? "Writer" : "LongReader", i, () =>
                {
                    if (worker == 2)
                    {
                        // Revision lookup is intentionally included: it too can wait for a read lock.
                        long current = participant.Revision(session);
                        var result = participant.Apply(change with { ExpectedRevision = current });
                        if (result.Status != ContextMutationStatus.Applied) throw new InvalidOperationException("Single writer failed.");
                        return result.Status.ToString();
                    }
                    read = participant.Read(session, range);
                    return "Completed";
                });
                if (read is not null)
                {
                    if (read.Entries.Length != descriptor.Entries ||
                        read.Entries.Where((entry, index) => index != 4 && entry != originals[index]).Any())
                        throw new InvalidOperationException("Long read has incoherent membership/order.");
                    observations.Add((read.SessionRevision, ((TextContent)read.Entries[4].Content).Text));
                }
                samples.Add(sample);
            }
        }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default)).ToArray();
        ready.Wait();
        long began = Stopwatch.GetTimestamp();
        start.Set();
        await Task.WhenAll(tasks);
        double elapsed = Stopwatch.GetElapsedTime(began).TotalMilliseconds;
        if (participant.Revision(session) != descriptor.Iterations) throw new InvalidOperationException("Writer completion mismatch.");
        foreach (var read in observations)
            if (read.Text != (read.Revision == 0 ? ((TextContent)original.Content).Text : $"version{read.Revision}"))
                throw new InvalidOperationException("Read cannot be explained by accepted history.");
        requests.AddRange(samples.OrderBy(sample => sample.StartedTicks));
        Sample(memory, "final", 0, participant);
        return elapsed;
    }

    private static double Snapshots(
        PressureCase descriptor, List<PressureRequest> requests, List<PressureMemory> memory)
    {
        // Holding G different revisions makes reference-copying snapshots cost O(G*N)
        // slots (plus anchors), even though payload strings are shared. Root capture is
        // O(1), but subsequent immutable rewrites retain changed paths/segment arrays.
        // The fixture intentionally keeps original payloads alive in both designs: these
        // phases measure incremental retention, not eviction of the original conversation.
        // Forced GC distinguishes reachability from the runtime's collection schedule;
        // it cannot turn estimates or process-private bytes into precise retained sizes.
        var fixture = Fixture(descriptor);
        Guid session = fixture.Sessions[0].SessionId;
        var first = ContextPolicies.Entries(fixture.Sessions[0]).First();
        using (var warm = BenchmarkParticipants.Create(descriptor.Participant, fixture))
            for (int i = 0; i < descriptor.Warmups; i++)
            {
                using var lease = warm.Retain(session);
                if (warm.Apply(new(session, i, [new ReplaceEntry(first.EntryId, new TextContent($"warm{i}"))])).Status != ContextMutationStatus.Applied)
                    throw new InvalidOperationException("Snapshot warmup failed.");
            }
        using var participant = BenchmarkParticipants.Create(descriptor.Participant, fixture);
        using var oracle = new SemanticOracle(fixture);
        var held = new List<(IContextRetention Lease, long Revision, ContextEntry? First)>();
        Sample(memory, "initial-before-forced-GC", 0, participant);
        Collect();
        Sample(memory, "initial-after-forced-GC", 0, participant);
        double elapsed = 0;
        try
        {
            for (int i = 0; i < descriptor.Iterations; i++)
            {
                IContextRetention lease = null!;
                var retain = Measure(descriptor.Participant, "Retain", i, () =>
                {
                    lease = participant.Retain(session);
                    return "Completed";
                });
                held.Add((lease, lease.Revision, lease.FirstEntry));
                requests.Add(retain);
                var changes = new ContextChangeSet(session, i,
                    [new ReplaceEntry(first.EntryId, new TextContent($"snapshot{i}")),
                     new AppendEntries([new(ContextFixture.Id(40, 0, i), ContextRole.User,
                         ContextFixture.Now, new TextContent(Payload(1024, $"growth{i}")))])]);
                var mutation = Measure(descriptor.Participant, "Mutation", i, () =>
                {
                    var result = participant.Apply(changes);
                    if (result.Status != ContextMutationStatus.Applied) throw new InvalidOperationException(result.Error);
                    return result.Status.ToString();
                });
                requests.Add(mutation);
                elapsed += retain.ElapsedMs + mutation.ElapsedMs;
                if (oracle.Apply(changes).Status != ContextMutationStatus.Applied)
                    throw new InvalidOperationException("Snapshot oracle mutation failed.");
                foreach (var snapshot in held)
                    if (snapshot.Lease.Revision != snapshot.Revision || snapshot.Lease.FirstEntry != snapshot.First)
                        throw new InvalidOperationException("Retained snapshot changed.");
                Sample(memory, $"held-{i + 1}", held.Count, participant);
            }
            Collect();
            Sample(memory, "held-after-forced-GC", held.Count, participant);
        }
        finally
        {
            foreach (var snapshot in held) snapshot.Lease.Dispose();
            held.Clear();
        }
        Sample(memory, "released-before-GC", 0, participant);
        Thread.Sleep(100);
        Sample(memory, "released-after-100ms", 0, participant);
        Collect();
        Sample(memory, "released-after-forced-GC", 0, participant);
        CheckEntries(oracle.Read(session, new(ContextReadKind.Range, Limit: int.MaxValue)).Entries,
            participant.Read(session, new(ContextReadKind.Range, Limit: int.MaxValue)).Entries);
        return elapsed;
    }

    private static void Collect()
    {
        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();
    }

    private static async Task<double> Admission(
        PressureCase descriptor, List<PressureRequest> requests, List<PressureMemory> memory)
    {
        // Isolate three policies: count exhaustion at one revision; retained-byte pressure
        // across two distinct roots; resident growth while one old root remains captured.
        // Calibrate the nominal byte limits with the segmented estimator, not a purported
        // universal object-size formula. Conventional adapters do not enforce those byte
        // limits, so their successful work is evidence of a guarantee gap, never a win.
        var fixture = Fixture(descriptor);
        Guid session = fixture.Sessions[0].SessionId;
        fixture = fixture with
        {
            Options = fixture.Options with
            {
                MaximumRetainedReads = 2,
                AdmissionTimeout = TimeSpan.FromMilliseconds(100)
            }
        };
        using (var participant = BenchmarkParticipants.Create(descriptor.Participant, fixture))
        {
            using var first = participant.Retain(session);
            using var second = participant.Retain(session);
            var rejected = await Task.Factory.StartNew(() => Measure(descriptor.Participant, "ReadCountTimeout", 0, () =>
                ReadOrReject(participant, session)), CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
            if (rejected.Status != "Rejected") throw new InvalidOperationException("Read-count admission was not enforced.");
            requests.Add(rejected);
            using var entered = new ManualResetEventSlim();
            var waiting = Task.Factory.StartNew(() =>
            {
                entered.Set();
                return Measure(descriptor.Participant, "ReadCountRelease", 0, () => ReadOrReject(participant, session));
            }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
            entered.Wait();
            await Task.Delay(10);
            first.Dispose();
            var resumed = await waiting;
            requests.Add(resumed);
        }

        long active;
        using (var calibration = new PolymorphicContextParticipant(fixture)) active = calibration.Statistics.EstimatedActiveBytes;
        var retainedBudget = fixture with { Options = fixture.Options with { MaximumEstimatedRetainedBytes = active + active / 2 } };
        using (var participant = BenchmarkParticipants.Create(descriptor.Participant, retainedBudget))
        {
            using var retained = participant.Retain(session);
            var first = ContextPolicies.Entries(fixture.Sessions[0]).First();
            if (participant.Apply(new(session, 0, [new ReplaceEntry(first.EntryId, new TextContent("newroot"))])).Status != ContextMutationStatus.Applied)
                throw new InvalidOperationException("Retained-byte setup mutation failed.");
            requests.Add(Measure(descriptor.Participant, "RetainedByteRead", 0, () => ReadOrReject(participant, session)));
            Sample(memory, $"retained-byte-limit-{retainedBudget.Options.MaximumEstimatedRetainedBytes}", 1, participant);
        }
        fixture = fixture with { Options = fixture.Options with { EstimatedResidentByteBudget = checked(2 * active + 96 * 1024) } };
        using (var participant = BenchmarkParticipants.Create(descriptor.Participant, fixture))
        {
            var retained = participant.Retain(session);
            try
            {
                Sample(memory, $"byte-limit-{fixture.Options.EstimatedResidentByteBudget}", 1, participant);
                for (int i = 0; i < descriptor.Iterations; i++)
                {
                    var changes = new ContextChangeSet(session, participant.Revision(session),
                        [new AppendEntries([new(ContextFixture.Id(41, 0, i), ContextRole.User, ContextFixture.Now,
                            new TextContent(Payload(32768, $"pressure{i}")))])]);
                    requests.Add(Measure(descriptor.Participant, "BytePressureWrite", i,
                        () => participant.Apply(changes).Status.ToString()));
                    Sample(memory, $"byte-growth-{i}", 1, participant);
                }
            }
            finally { retained.Dispose(); }
            Sample(memory, "byte-reader-released", 0, participant);
            var retry = new ContextChangeSet(session, participant.Revision(session),
                [new AppendEntries([new(ContextFixture.Id(42, 0, 0), ContextRole.User, ContextFixture.Now,
                    new TextContent(Payload(32768, "retry")))])]);
            requests.Add(Measure(descriptor.Participant, "WriteAfterRelease", 0,
                () => participant.Apply(retry).Status.ToString()));
            Collect();
            Sample(memory, "byte-released-after-forced-GC", 0, participant);
        }
        return requests.Sum(request => request.ElapsedMs);
    }

    private static string ReadOrReject(IContextBenchmarkParticipant participant, Guid session)
    {
        try { _ = participant.Read(session, new(ContextReadKind.Range, Limit: 1)); return "Completed"; }
        catch (InvalidOperationException error) when (error.Message.Contains("retention", StringComparison.OrdinalIgnoreCase))
        { return "Rejected"; }
    }
}
