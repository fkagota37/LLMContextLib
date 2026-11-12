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

public enum PreparationPolicy { Speculative, Serialized }

public sealed record RampOptions
{
    public bool ComparePreparationPolicies { get; init; }
    public int[] Rates { get; init; } = [100, 500, 1500];
    public int StageMilliseconds { get; init; } = 1500;
    public int Workers { get; init; } = 4;
    public int QueueCapacity { get; init; } = 64;
    public int TotalEntries { get; init; } = 2048;
    public int Repetitions { get; init; } = 2;
    public int Seed { get; init; } = 1729;
    public long MaximumManagedBytes { get; init; } = 256L * 1024 * 1024;
    public long MaximumPrivateBytes { get; init; } = 512L * 1024 * 1024;
    public int MaximumRequests { get; init; } = 20_000;
    public int DrainMilliseconds { get; init; } = 3000;
    public int PostReleaseMilliseconds { get; init; } = 250;

    internal void Validate()
    {
        if (Rates.Length is < 1 or > 5 || Rates.Any(rate => rate is < 1 or > 10_000) ||
            Rates.Zip(Rates.Skip(1)).Any(pair => pair.First >= pair.Second) ||
            StageMilliseconds is < 50 or > 5000 || Workers is < 1 or > 8 ||
            QueueCapacity is < 1 or > 1024 || TotalEntries is < 128 or > 16_384 || TotalEntries % 4 != 0 ||
            Repetitions is < 1 or > 3 || MaximumRequests is < 1 or > 20_000 ||
            MaximumManagedBytes is < 1 or > 512L * 1024 * 1024 ||
            MaximumPrivateBytes is < 1 or > 1024L * 1024 * 1024 ||
            DrainMilliseconds is < 100 or > 5000 || PostReleaseMilliseconds is < 0 or > 1000)
            throw new ArgumentOutOfRangeException(nameof(RampOptions));
        long planned = Rates.Sum(rate => (long)Math.Ceiling(rate * StageMilliseconds / 1000d));
        if (planned > MaximumRequests || planned / 80 + 1 > TotalEntries / 4 - 8)
            throw new ArgumentException("Request plan exceeds its cap or distinct initial deletion targets.");
    }
}

public sealed record RampCase(ParticipantKind Participant, bool Distributed, bool SlowReaders, int Repetition, RampOptions Options,
    PreparationPolicy Preparation = PreparationPolicy.Speculative, bool TraceMutations = false)
{
    public string Name => $"{Participant}-{(Distributed ? "distributed" : "hot")}-{(SlowReaders ? "slow" : "normal")}-r{Repetition}" +
        (TraceMutations ? $"-prep{Preparation}" : "");
}
public sealed record MutationPreparationSample(string Target, string Disposition, bool PreparationStarted, bool Prepared,
    double PreparationMs, long PreparationBytes, double WriterGateMs, double ResourceAdmissionMs, double StorageMs, long StorageBytes);
public sealed record RampRequest(
    int Id, int Stage, Guid Session, string Category, string Outcome, bool Admitted,
    double DueMs, double OfferedMs, double QueueMs, double ExecutionMs, long Revision,
    MutationPreparationSample? Mutation = null);
public sealed record RampLatency(
    int Stage, string Category, string Outcome, int Samples, double MeanQueueMs,
    double MeanExecutionMs, double P50EndToEndMs, double? P95EndToEndMs, double? P99EndToEndMs);
public sealed record RampStage(
    int Stage, int Rate, int Offered, int Admitted, int Completed, int Succeeded, int Applied, int Conflicted,
    int StorageRejected, int QueueRejected, int Cancelled, int QueueAtBoundary, int InFlightAtBoundary,
    int TerminalAtBoundary, double SchedulingLagP95Ms, double MaximumSchedulingLagMs);
public sealed record RampMemory(
    double ElapsedMs, string Phase, int Queue, int InFlight, int HeldLeases, int HeldGenerations,
    long ManagedBytes, long HeapBytes, long PrivateBytes, long AllocatedTotalBytes, double GCPauseTotalMs,
    long? EstimatedRetainedBytes, int? RetainedReads);
public sealed record RampLeaseEvent(double ElapsedMs, int Cycle, Guid Session, long Revision, string Outcome);
public sealed record RampResult(
    RampCase Case, string StopReason, string[] Limitations, double WorkloadMs, double DrainMs,
    long AllocatedBytes, double AllocationBytesPerSecond, double GCPauseMs, int Gen0, int Gen1, int Gen2,
    ImmutableArray<RampStage> Stages, ImmutableArray<RampRequest> Requests,
    ImmutableArray<RampLatency> Latencies, ImmutableArray<RampMemory> Memory, ImmutableArray<RampLeaseEvent> Leases);

/// <summary>
/// An open-arrival, bounded-queue mechanism experiment, NOT a free-running throughput loop.
/// One producer follows absolute deadlines independently of worker completion. A bounded FIFO
/// gives O(1) expected enqueue/dequeue, O(capacity) queued storage and explicit overflow. Raw
/// observations/accepted commands cost O(Q + returned values), bounded by the request cap.
/// This evidence overhead is included in process allocation/memory, not hidden as storage cost.
/// Full independent oracle validation and O(Q log Q) percentile aggregation follow measurement.
/// </summary>
public static class SustainedRamp
{
    private sealed record Work(int Id, int Stage, int Session, string Category, double DueMs, double OfferedMs);
    private sealed record ReadCheck(Guid Session, ContextReadRequest Request, ContextObservation Observation);
    private sealed record Commit(ContextChangeSet Change, long Revision);
    private sealed record MemoryCommit(MemoryChangeSet Change, long Revision);
    private sealed record Capture(Guid Session, long Revision, ContextEntry? First);
    private sealed record Held(IContextRetention Lease, Capture Capture, double ReleaseMs, int Cycle);

    public static IEnumerable<RampCase> Cases(RampOptions options)
    {
        options.Validate();
        var random = new Random(options.Seed);
        for (int repeat = 0; repeat < options.Repetitions; repeat++)
        {
            var cases = (from kind in options.ComparePreparationPolicies ? [ParticipantKind.LLMPolymorphic] : Enum.GetValues<ParticipantKind>()
                         from preparation in options.ComparePreparationPolicies ? Enum.GetValues<PreparationPolicy>() : [PreparationPolicy.Speculative]
                         from distributed in new[] { false, true }
                         from slow in new[] { false, true }
                         select new RampCase(kind, distributed, slow, repeat, options, preparation,
                             options.ComparePreparationPolicies)).ToArray();
            random.Shuffle(cases);
            foreach (var descriptor in cases) yield return descriptor;
        }
    }

    public static async Task<int> RunSuite(string? output, RampOptions options, string[] arguments)
    {
        options.Validate();
        if (output is null || Directory.Exists(output))
            throw new ArgumentException("--ramp requires a new --output directory.");
        Directory.CreateDirectory(output);
        var reports = new List<object>();
        foreach (var descriptor in Cases(options))
        {
            string path = Path.GetFullPath(Path.Combine(output, descriptor.Name + ".json"));
            var start = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            };
            foreach (string argument in new[] { Assembly.GetExecutingAssembly().Location, "--ramp-case",
                    JsonSerializer.Serialize(descriptor), "--output", path })
                start.ArgumentList.Add(argument);
            using var child = Process.Start(start) ?? throw new InvalidOperationException("Ramp child did not start.");
            var stdout = child.StandardOutput.ReadToEndAsync();
            var stderr = child.StandardError.ReadToEndAsync();
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(120));
            bool timedOut = false;
            try { await child.WaitForExitAsync(deadline.Token); }
            catch (OperationCanceledException)
            {
                timedOut = true;
                child.Kill(entireProcessTree: true);
                await child.WaitForExitAsync();
            }
            await File.WriteAllTextAsync(Path.ChangeExtension(path, ".log"), await stdout + Environment.NewLine + await stderr);
            if (timedOut || child.ExitCode != 0)
            {
                reports.Add(new { descriptor, timedOut, child.ExitCode });
                RunEvidence.Save(Path.Combine(output, "suite.json"), "Ramp failure; completed evidence retained", reports, arguments);
                return 1;
            }
            using var document = JsonDocument.Parse(await File.ReadAllTextAsync(path));
            reports.Add(document.RootElement.GetProperty("Reports").Clone());
            Console.WriteLine($"{descriptor.Name} PASS");
        }
        RunEvidence.Save(Path.Combine(output, "suite.json"), "Bounded mixed-load ramp; randomized repeated isolated cases; no forced GC", reports, arguments);
        return 0;
    }

    public static async Task<RampResult> Run(RampCase descriptor, CancellationToken cancellation = default)
    {
        var options = descriptor.Options;
        options.Validate();
        if (!Enum.IsDefined(descriptor.Preparation) || (descriptor.Participant != ParticipantKind.LLMPolymorphic &&
            (descriptor.TraceMutations || descriptor.Preparation != PreparationPolicy.Speculative)))
            throw new ArgumentException("Preparation experiments apply only to the segmented participant.");
        int sessions = descriptor.Distributed ? 4 : 1;
        var fixture = ContextFixture.Create("Interactive", options.TotalEntries / sessions, sessions);
        fixture = fixture with
        {
            Options = fixture.Options with
            {
                AdmissionTimeout = TimeSpan.FromMilliseconds(10),
                MaximumRetainedReads = options.Workers,
                EstimatedResidentByteBudget = 32L * 1024 * 1024,
                MaximumEstimatedRetainedBytes = 16L * 1024 * 1024,
                SerializeSessionPreparation = descriptor.Preparation == PreparationPolicy.Serialized
            }
        };
        // Warm separately: the measured owner's initial revision remains exactly the oracle's.
        using (var warm = BenchmarkParticipants.Create(descriptor.Participant, fixture))
            for (int i = 0; i < 3; i++)
                _ = warm.Read(fixture.Sessions[0].SessionId, new(ContextReadKind.Search, Query: "context"));
        using var participant = BenchmarkParticipants.Create(descriptor.Participant, fixture);
        using var queue = new BlockingCollection<Work>(options.QueueCapacity);
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        using var ready = new CountdownEvent(options.Workers + 2);
        using var start = new ManualResetEventSlim();
        var requests = new ConcurrentQueue<RampRequest>();
        var reads = new ConcurrentQueue<ReadCheck>();
        var commits = new ConcurrentQueue<Commit>();
        var memoryCommits = new ConcurrentQueue<MemoryCommit>();
        var captures = new ConcurrentQueue<Capture>();
        var leaseEvents = new ConcurrentQueue<RampLeaseEvent>();
        var memory = new ConcurrentQueue<RampMemory>();
        var boundaries = new ConcurrentDictionary<int, (int Queue, int Flight, int Terminal)>();
        var originals = fixture.Sessions.Select(session => ContextPolicies.Entries(session).ToArray()).ToArray();
        var held = new List<Held>(3);
        object leaseGate = new();
        int inFlight = 0, terminal = 0;
        string stopReason = "Duration";
        long began = 0;
        double Now() => began == 0 ? 0 : Stopwatch.GetElapsedTime(began).TotalMilliseconds;
        void Stop(string reason)
        {
            Interlocked.CompareExchange(ref stopReason, reason, "Duration");
            stop.Cancel();
        }
        void Sample(string phase)
        {
            using var process = Process.GetCurrentProcess();
            process.Refresh();
            int count, generations;
            lock (leaseGate)
            {
                count = held.Count;
                generations = held.Select(item => (item.Capture.Session, item.Capture.Revision)).Distinct().Count();
            }
            var stats = (participant as PolymorphicContextParticipant)?.Statistics;
            long managed = GC.GetTotalMemory(false);
            memory.Enqueue(new(Now(), phase, queue.Count, Volatile.Read(ref inFlight), count, generations,
                managed, GC.GetGCMemoryInfo().HeapSizeBytes, process.PrivateMemorySize64,
                GC.GetTotalAllocatedBytes(), GC.GetTotalPauseDuration().TotalMilliseconds,
                stats?.EstimatedRetainedBytes, stats?.RetainedReads));
            if (managed > options.MaximumManagedBytes) Stop("ManagedMemoryLimit");
            if (process.PrivateMemorySize64 > options.MaximumPrivateBytes) Stop("PrivateMemoryLimit");
        }
        bool Until(double due)
        {
            while (!stop.IsCancellationRequested)
            {
                double remaining = due - Now();
                if (remaining <= 0) return true;
                // Millisecond sleeps can release a late burst. Scheduling lag is recorded,
                // never silently charged to storage execution or described as a perfect clock.
                stop.Token.WaitHandle.WaitOne((int)Math.Clamp(Math.Ceiling(remaining), 1, 5));
            }
            return false;
        }
        void Cancel(Work work) => requests.Enqueue(new(work.Id, work.Stage, fixture.Sessions[work.Session].SessionId,
            work.Category, "Cancelled", true, work.DueMs, work.OfferedMs, Now() - work.OfferedMs, 0, -1));
        var workers = Enumerable.Range(0, options.Workers).Select(_ => Task.Factory.StartNew(() =>
        {
            ready.Signal();
            start.Wait();
            foreach (var work in queue.GetConsumingEnumerable())
            {
                if (stop.IsCancellationRequested) { Cancel(work); Interlocked.Increment(ref terminal); continue; }
                Interlocked.Increment(ref inFlight);
                double entered = Now();
                string outcome;
                long revision = -1;
                MutationPreparationSample? mutationSample = null;
                var session = fixture.Sessions[work.Session];
                try
                {
                    if (work.Category is "Correct" or "StaleCorrect" or "Append" or "Delete")
                    {
                        long expected = participant.Revision(session.SessionId);
                        if (work.Category == "StaleCorrect") expected--;
                        ContextChange change = work.Category switch
                        {
                            "Append" => new AppendEntries([new(ContextFixture.Id(70, 0, work.Id), ContextRole.User,
                                ContextFixture.Now, new TextContent($"append{work.Id} context " + new string('x', 512)))]),
                            "Delete" => new DeleteEntry(originals[work.Session][8 + work.Id / 20 / sessions].EntryId),
                            _ => new ReplaceEntry(originals[work.Session][0].EntryId, new TextContent($"correction{work.Id} context"))
                        };
                        var command = new ContextChangeSet(session.SessionId, expected, [change]);
                        var diagnostic = descriptor.TraceMutations ? new MutationDiagnostics() : null;
                        if (diagnostic is not null) MutationDiagnostics.Current = diagnostic;
                        IContextMutationResult result;
                        try { result = participant.Apply(command); }
                        finally
                        {
                            if (diagnostic is not null) MutationDiagnostics.Current = null;
                            mutationSample = PreparationSample(diagnostic, "Session");
                        }
                        outcome = result.Status.ToString();
                        revision = result.Revision;
                        if (result.Status == ContextMutationStatus.Applied) commits.Enqueue(new(command, revision));
                        if (work.Category == "StaleCorrect" && result.Status != ContextMutationStatus.RevisionConflict)
                            throw new InvalidOperationException("Intentionally stale write was not rejected.");
                        if (result.Status is not (ContextMutationStatus.Applied or ContextMutationStatus.RevisionConflict or ContextMutationStatus.AdmissionRejected))
                            throw new InvalidOperationException($"Unexpected mutation outcome: {result.Status}");
                    }
                    else if (work.Category == "MemoryWrite")
                    {
                        long expected = participant.Read(session.SessionId, new(ContextReadKind.Memory)).MemoryRevision;
                        var command = new MemoryChangeSet(expected,
                            [new(ContextFixture.Id(71, 0, work.Id), new(SessionId: session.SessionId),
                                $"memory{work.Id}", 0, MemoryStatus.Confirmed, null,
                                [new(session.SessionId, ContextFixture.Id(20, work.Session, 0))])], []);
                        var diagnostic = descriptor.TraceMutations ? new MutationDiagnostics() : null;
                        if (diagnostic is not null) MutationDiagnostics.Current = diagnostic;
                        IContextMutationResult result;
                        try { result = participant.ApplyMemory(command); }
                        finally
                        {
                            if (diagnostic is not null) MutationDiagnostics.Current = null;
                            mutationSample = PreparationSample(diagnostic, "Memory");
                        }
                        revision = result.Revision;
                        outcome = result.Status.ToString();
                        if (result.Status == ContextMutationStatus.Applied) memoryCommits.Enqueue(new(command, revision));
                        if (result.Status is not (ContextMutationStatus.Applied or ContextMutationStatus.RevisionConflict or ContextMutationStatus.AdmissionRejected))
                            throw new InvalidOperationException($"Unexpected memory outcome: {result.Status}");
                    }
                    else
                    {
                        var request = work.Category switch
                        {
                            "Search" => new ContextReadRequest(ContextReadKind.Search, Query: work.Id % 2 == 0 ? "context" : "entry0x7"),
                            "MemoryRead" => new(ContextReadKind.Memory, Scopes: [new(SessionId: session.SessionId)]),
                            _ => new(ContextReadKind.Range, Limit: work.Category == "FullRead" ? int.MaxValue : 16)
                        };
                        var result = participant.Read(session.SessionId, request);
                        if (result.Hits.Any(hit => hit.SessionRevision != result.SessionRevision))
                            throw new InvalidOperationException("Index/root generation mismatch.");
                        reads.Enqueue(new(session.SessionId, request, result));
                        revision = result.SessionRevision;
                        outcome = "Completed";
                    }
                }
                catch (InvalidOperationException error) when (error.Message.Contains("retention", StringComparison.OrdinalIgnoreCase))
                { outcome = "AdmissionRejected"; }
                catch { Stop("WorkerFailure"); throw; }
                finally { Interlocked.Decrement(ref inFlight); }
                requests.Enqueue(new(work.Id, work.Stage, session.SessionId, work.Category, outcome, true,
                    work.DueMs, work.OfferedMs, entered - work.OfferedMs, Now() - entered, revision, mutationSample));
                Interlocked.Increment(ref terminal);
            }
        }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default)).ToArray();

        var retainer = Task.Factory.StartNew(() =>
        {
            ready.Signal();
            start.Wait();
            int nextCapture = 0;
            try
            {
                while (!stop.IsCancellationRequested && Now() < options.Rates.Length * options.StageMilliseconds)
                {
                    double now = Now();
                    if (descriptor.SlowReaders && now >= nextCapture / 3 * 500 + nextCapture % 3 * 50)
                    {
                        int cycle = nextCapture / 3, slot = nextCapture % 3;
                        Guid session = fixture.Sessions[cycle % sessions].SessionId;
                        nextCapture++;
                        try
                        {
                            var lease = participant.Retain(session);
                            var capture = new Capture(session, lease.Revision, lease.FirstEntry);
                            captures.Enqueue(capture);
                            lock (leaseGate) held.Add(new(lease, capture, cycle * 500 + 200 + slot * 75, cycle));
                            leaseEvents.Enqueue(new(Now(), cycle, session, capture.Revision, "Captured"));
                        }
                        catch (InvalidOperationException error) when (error.Message.Contains("retention", StringComparison.OrdinalIgnoreCase))
                        { leaseEvents.Enqueue(new(Now(), cycle, session, -1, "AdmissionRejected")); }
                    }
                    lock (leaseGate)
                    {
                        for (int i = held.Count - 1; i >= 0; i--)
                        {
                            var item = held[i];
                            if (item.Lease.Revision != item.Capture.Revision || item.Lease.FirstEntry != item.Capture.First)
                                throw new InvalidOperationException("Retained reader changed.");
                            if (now < item.ReleaseMs) continue;
                            item.Lease.Dispose();
                            held.RemoveAt(i);
                            leaseEvents.Enqueue(new(Now(), item.Cycle, item.Capture.Session, item.Capture.Revision, "Released"));
                        }
                    }
                    stop.Token.WaitHandle.WaitOne(10);
                }
            }
            catch { Stop("RetainerFailure"); throw; }
            finally
            {
                lock (leaseGate)
                {
                    foreach (var item in held)
                    {
                        item.Lease.Dispose();
                        leaseEvents.Enqueue(new(Now(), item.Cycle, item.Capture.Session, item.Capture.Revision, "ReleasedAtStop"));
                    }
                    held.Clear();
                }
            }
        }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
        using var samplingDone = new CancellationTokenSource();
        var sampler = Task.Factory.StartNew(() =>
        {
            ready.Signal();
            start.Wait();
            while (!samplingDone.IsCancellationRequested)
            {
                Sample("workload");
                samplingDone.Token.WaitHandle.WaitOne(50);
            }
        }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);

        // All workers, lease manager and sampler exist before the clock begins. The initial
        // process sample is deliberately BEFORE release, unlike the older arrival driver.
        ready.Wait();
        Sample("initial");
        long allocated = GC.GetTotalAllocatedBytes();
        var pause = GC.GetTotalPauseDuration();
        int gen0 = GC.CollectionCount(0), gen1 = GC.CollectionCount(1), gen2 = GC.CollectionCount(2);
        began = Stopwatch.GetTimestamp();
        start.Set();
        int id = 0;
        double workloadMs;
        try
        {
            for (int stage = 0; stage < options.Rates.Length && !stop.IsCancellationRequested; stage++)
            {
                int count = (int)Math.Ceiling(options.Rates[stage] * options.StageMilliseconds / 1000d);
                for (int ordinal = 0; ordinal < count; ordinal++, id++)
                {
                    double due = stage * options.StageMilliseconds + ordinal * 1000d / options.Rates[stage];
                    if (!Until(due)) break;
                    string category = (id % 20) switch
                    {
                        < 8 => "BoundedRead",
                        8 => "FullRead",
                        < 12 => "Search",
                        12 => "MemoryRead",
                        13 when id % 100 == 13 => "StaleCorrect",
                        < 16 => "Correct",
                        < 18 => "Append",
                        18 => "Delete",
                        _ => "MemoryWrite"
                    };
                    var work = new Work(id, stage, (id / 20 + id) % sessions, category, due, Now());
                    if (!queue.TryAdd(work))
                    {
                        requests.Enqueue(new(id, stage, fixture.Sessions[work.Session].SessionId,
                            category, "QueueRejected", false, due, work.OfferedMs, 0, 0, -1));
                        Interlocked.Increment(ref terminal);
                    }
                }
                Until((stage + 1) * options.StageMilliseconds);
                boundaries[stage] = (queue.Count, Volatile.Read(ref inFlight), Volatile.Read(ref terminal));
                Sample($"stage-{stage}-boundary");
            }
            workloadMs = Now();
        }
        finally { queue.CompleteAdding(); }
        double drainStart = Now();
        try
        {
            try { await Task.WhenAll(workers.Append(retainer)).WaitAsync(TimeSpan.FromMilliseconds(options.DrainMilliseconds)); }
            catch (TimeoutException)
            {
                Stop("DrainLimit");
                // Cancellation drains queued work; it does not pretend to abort synchronous
                // storage calls. The isolated CLI child has an independent hard deadline.
                await Task.WhenAll(workers.Append(retainer)).WaitAsync(TimeSpan.FromSeconds(10));
            }
        }
        finally
        {
            samplingDone.Cancel();
            await sampler;
        }
        double drainMs = Now() - drainStart;
        Sample("released");
        if (options.PostReleaseMilliseconds > 0) await Task.Delay(options.PostReleaseMilliseconds);
        Sample("released-settled-no-forced-GC");
        allocated = GC.GetTotalAllocatedBytes() - allocated;
        var pauseDelta = GC.GetTotalPauseDuration() - pause;
        int g0 = GC.CollectionCount(0) - gen0, g1 = GC.CollectionCount(1) - gen1, g2 = GC.CollectionCount(2) - gen2;
        if (participant is PolymorphicContextParticipant segmented &&
            (segmented.Statistics.RetainedReads != 0 || segmented.Statistics.EstimatedRetainedBytes != 0))
            throw new InvalidOperationException("Retained accounting did not return to zero.");
        Validate(fixture, participant, reads.ToArray(), commits.ToArray(), memoryCommits.ToArray(), captures.ToArray());
        var samples = requests.OrderBy(request => request.Id).ToImmutableArray();
        if (samples.Select(request => request.Id).Distinct().Count() != samples.Length)
            throw new InvalidOperationException("A request has multiple terminal outcomes.");
        var stages = options.Rates.Select((rate, index) =>
        {
            var group = samples.Where(request => request.Stage == index).ToArray();
            double[] lag = group.Select(request => Math.Max(0, request.OfferedMs - request.DueMs)).Order().ToArray();
            var boundary = boundaries.GetValueOrDefault(index);
            return new RampStage(index, rate, group.Length, group.Count(request => request.Admitted),
                group.Count(request => request.Admitted && request.Outcome != "Cancelled"),
                group.Count(request => request.Outcome is "Completed" or "Applied"),
                group.Count(request => request.Outcome == "Applied"), group.Count(request => request.Outcome == "RevisionConflict"),
                group.Count(request => request.Outcome == "AdmissionRejected"), group.Count(request => request.Outcome == "QueueRejected"),
                group.Count(request => request.Outcome == "Cancelled"), boundary.Queue, boundary.Flight, boundary.Terminal,
                lag.Length == 0 ? 0 : lag[(int)Math.Ceiling(lag.Length * .95) - 1], lag.LastOrDefault());
        }).ToImmutableArray();
        if (cancellation.IsCancellationRequested && stopReason == "Duration") stopReason = "Cancelled";
        return new(descriptor, stopReason,
            ["Synchronous storage admission cannot be cancelled; cancellation stops production/queued work and drains in-flight calls.",
             "Conventional byte admission and concurrent-owner-disposal guarantees are absent; shutdown uses orderly drain.",
             "Oracle/full-value checks follow measurement; generation stamps and retained-reader stability are checked during load.",
             "Process allocation/GC/memory include bounded evidence, sampler and retainer overhead. No forced GC is performed.",
             "Optional mutation traces include current-thread preparation/storage allocation and timer overhead; policy comparison leaves memory-catalog preparation speculative.",
             "Fixed total initial entries; four distributed sessions versus one hot session. Not a proof of arbitrary-scale throughput.",
             "p95 requires 100 samples; p99 requires 1000 per stage/category/outcome. No confidence bounds or production SLA.",
             "Memory stop is sampled every 50ms, not a hard heap cap; child deadline bounds hung or non-cancellable work."],
            workloadMs, drainMs, allocated, allocated * 1000d / Math.Max(1, workloadMs + drainMs + options.PostReleaseMilliseconds),
            pauseDelta.TotalMilliseconds, g0, g1, g2, stages, samples, Summarize(samples), memory.ToImmutableArray(), leaseEvents.ToImmutableArray());
    }

    private static MutationPreparationSample? PreparationSample(MutationDiagnostics? diagnostic, string target)
    {
        if (diagnostic is null) return null;
        static double Ms(long ticks) => ticks * 1000d / Stopwatch.Frequency;
        return new(target, diagnostic.Disposition.ToString(), diagnostic.PreparationStarted, diagnostic.Prepared,
            Ms(diagnostic.PreparationTicks), diagnostic.PreparationBytes, Ms(diagnostic.GateTicks),
            Ms(diagnostic.ResourceTicks), Ms(diagnostic.StorageTicks), diagnostic.StorageBytes);
    }

    private static void Validate(ContextFixture fixture, IContextBenchmarkParticipant participant,
        ReadCheck[] reads, Commit[] commits, MemoryCommit[] memory, Capture[] captures)
    {
        // Replay each session's accepted commands in REVISION order, not notification order.
        // Readers may publish evidence before the winning writer logs its commit. Retaining
        // every full oracle revision would cost O(Q*N); stream one mutable oracle instead.
        // Session/memory captures are not jointly atomic, so validate those histories separately.
        using var oracle = new SemanticOracle(fixture);
        foreach (var session in fixture.Sessions)
        {
            var commands = commits.Where(commit => commit.Change.SessionId == session.SessionId).OrderBy(commit => commit.Revision).ToArray();
            var observations = reads.Where(read => read.Session == session.SessionId && read.Request.Kind != ContextReadKind.Memory)
                .GroupBy(read => read.Observation.SessionRevision).ToDictionary(group => group.Key, group => group.ToArray());
            var retained = captures.Where(capture => capture.Session == session.SessionId)
                .GroupBy(capture => capture.Revision).ToDictionary(group => group.Key, group => group.ToArray());
            for (int version = 0; version <= commands.Length; version++)
            {
                if (version > 0)
                {
                    var command = commands[version - 1];
                    if (command.Revision != version || oracle.Apply(command.Change).Status != ContextMutationStatus.Applied)
                        throw new InvalidOperationException("Accepted session history has a gap/conflict.");
                }
                foreach (var read in observations.GetValueOrDefault(version) ?? [])
                {
                    var expected = oracle.Read(session.SessionId, read.Request);
                    if (!expected.Entries.SequenceEqual(read.Observation.Entries) || !expected.Hits.SequenceEqual(read.Observation.Hits))
                        throw new InvalidOperationException("Read/index values do not match their committed root.");
                }
                foreach (var capture in retained.GetValueOrDefault(version) ?? [])
                    if (oracle.Read(session.SessionId, new(ContextReadKind.Range, Limit: 1)).Entries.FirstOrDefault() != capture.First)
                        throw new InvalidOperationException("Retained root is not in accepted history.");
            }
            if (observations.Keys.Concat(retained.Keys).Any(version => version < 0 || version > commands.Length) ||
                participant.Revision(session.SessionId) != commands.Length)
                throw new InvalidOperationException("Unexplained revision or lost accepted write.");
            if (!oracle.Read(session.SessionId, new(ContextReadKind.Range, Limit: int.MaxValue)).Entries
                .SequenceEqual(participant.Read(session.SessionId, new(ContextReadKind.Range, Limit: int.MaxValue)).Entries))
                throw new InvalidOperationException("Final session differs from accepted history.");
        }
        var memoryReads = reads.Where(read => read.Request.Kind == ContextReadKind.Memory)
            .GroupBy(read => read.Observation.MemoryRevision).ToDictionary(group => group.Key, group => group.ToArray());
        var updates = memory.OrderBy(commit => commit.Revision).ToArray();
        for (int version = 0; version <= updates.Length; version++)
        {
            if (version > 0 && (updates[version - 1].Revision != version ||
                oracle.ApplyMemory(updates[version - 1].Change).Status != ContextMutationStatus.Applied))
                throw new InvalidOperationException("Accepted memory history has a gap/conflict.");
            foreach (var read in memoryReads.GetValueOrDefault(version) ?? [])
                if (!oracle.Read(read.Session, read.Request).Memories.SequenceEqual(read.Observation.Memories))
                    throw new InvalidOperationException("Memory values do not match captured catalog.");
        }
        if (memoryReads.Keys.Any(version => version < 0 || version > updates.Length))
            throw new InvalidOperationException("Unexplained memory revision.");
        foreach (var session in fixture.Sessions)
        {
            var request = new ContextReadRequest(ContextReadKind.Memory, Scopes: [new(SessionId: session.SessionId)]);
            var actual = participant.Read(session.SessionId, request);
            if (actual.MemoryRevision != updates.Length || !oracle.Read(session.SessionId, request).Memories.SequenceEqual(actual.Memories))
                throw new InvalidOperationException("Lost accepted memory write.");
        }
    }

    private static ImmutableArray<RampLatency> Summarize(ImmutableArray<RampRequest> requests) =>
        requests.Where(request => request.Admitted && request.Outcome != "Cancelled")
            .GroupBy(request => (request.Stage, request.Category, request.Outcome)).Select(group =>
            {
                double[] total = group.Select(request => request.OfferedMs + request.QueueMs + request.ExecutionMs - request.DueMs).Order().ToArray();
                double Rank(double fraction) => total[(int)Math.Ceiling(total.Length * fraction) - 1];
                return new RampLatency(group.Key.Stage, group.Key.Category, group.Key.Outcome, total.Length,
                    group.Average(request => request.QueueMs), group.Average(request => request.ExecutionMs),
                    Rank(.5), total.Length >= 100 ? Rank(.95) : null, total.Length >= 1000 ? Rank(.99) : null);
            }).ToImmutableArray();
}
