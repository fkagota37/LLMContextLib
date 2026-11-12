// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Diagnostics;
using LLMContextLib;

namespace LLMContextLib.Benchmarks;

public sealed record RequestSample(
    int Worker, int Operation, long StartedTicks, string Category, Guid SessionId, long Revision, ContextMutationStatus? Status,
    double QueueWaitMs, double ServiceMs, double EndToEndMs);
public sealed record MemorySample(
    double ElapsedMs, long ManagedBytes, long HeapBytes, long PrivateBytes, long WorkingSet);
public sealed record LatencySummary(
    string Category, ContextMutationStatus? Status, int Samples,
    double ServiceP50Ms, double ServiceP95Ms, double ServiceP99Ms,
    double EndToEndP50Ms, double EndToEndP95Ms, double EndToEndP99Ms, double QueueWaitP95Ms);
public sealed record ConcurrentReplayResult(
    string Participant, bool IndependentSessions, int Readers, int Writers, int OperationsPerWorker,
    int? TargetArrivalsPerSecond, double ElapsedMs, int Attempts, int Commits, int Conflicts, int Rejections,
    long AllocatedBytes, int Gen0, int Gen1, int Gen2,
    ImmutableArray<RequestSample> Requests, ImmutableArray<MemorySample> Memory, ImmutableArray<LatencySummary> Latencies)
{
    public double CompletedAttemptsPerSecond => Requests.Length * 1000d / ElapsedMs;
    public double SuccessfulRequestsPerSecond => Requests.Count(request =>
        request.Status is null or ContextMutationStatus.Applied) * 1000d / ElapsedMs;
}

/// <summary>
/// New bounded driver with dedicated workers; no prior progress-worker machinery is reused.
/// A hot-session test replaces one known entry so accepted revision/value pairs form an
/// independently checkable history. Reads must match that history, not merely avoid exceptions.
/// Worker creation/fixture seeding are outside requests. Queue lateness is included for a
/// scheduled-arrival run; this is a bounded-worker arrival model, not an unlimited open queue.
/// </summary>
public static class ConcurrentReplay
{
    public static async Task<ConcurrentReplayResult> Run(
        ParticipantKind kind, bool independentSessions, int readers = 8, int writers = 4,
        int operationsPerWorker = 64, int? arrivalsPerSecond = null)
    {
        if (readers < 0 || writers <= 0 || operationsPerWorker <= 0 || arrivalsPerSecond is <= 0)
            throw new ArgumentOutOfRangeException(nameof(readers));
        int workers = checked(readers + writers);
        var fixture = ContextFixture.Create("Interactive", sessionCount: independentSessions ? writers : 1);
        using var participant = BenchmarkParticipants.Create(kind, fixture);
        var requests = new ConcurrentBag<RequestSample>();
        var commits = new ConcurrentBag<(Guid Session, long Revision, string Text)>();
        var pointReads = new ConcurrentBag<(Guid Session, long Revision, string Text)>();
        var memory = new List<MemorySample>();
        using var ready = new CountdownEvent(workers);
        using var start = new ManualResetEventSlim();
        using var stopSampling = new CancellationTokenSource();
        long began = 0;
        var tasks = Enumerable.Range(0, workers).Select(worker => Task.Factory.StartNew(() =>
        {
            bool writer = worker >= readers;
            int sessionIndex = independentSessions ? (writer ? worker - readers : worker % writers) : 0;
            var session = fixture.Sessions[sessionIndex];
            var target = ContextPolicies.Entries(session).ElementAt(4);
            ready.Signal();
            start.Wait();
            for (int op = 0; op < operationsPerWorker; op++)
            {
                double dueMs = arrivalsPerSecond.HasValue ? 1000d * (op * workers + worker) / arrivalsPerSecond.Value : 0;
                if (arrivalsPerSecond.HasValue)
                {
                    var remaining = TimeSpan.FromMilliseconds(dueMs) - Stopwatch.GetElapsedTime(began);
                    if (remaining > TimeSpan.Zero) Thread.Sleep(remaining);
                }
                long entered = Stopwatch.GetTimestamp();
                double queue = arrivalsPerSecond.HasValue ? Math.Max(0, Stopwatch.GetElapsedTime(began, entered).TotalMilliseconds - dueMs) : 0;
                long revision;
                ContextMutationStatus? status = null;
                string category;
                if (writer)
                {
                    string text = $"writer{worker}operation{op}";
                    long expected = participant.Revision(session.SessionId);
                    var result = participant.Apply(new(session.SessionId, expected, [new ReplaceEntry(target.EntryId, new TextContent(text))]));
                    revision = result.Revision;
                    status = result.Status;
                    category = "PointWrite";
                    if (status == ContextMutationStatus.Applied) commits.Add((session.SessionId, revision, text));
                }
                else
                {
                    var request = (op % 4) switch
                    {
                        0 => new ContextReadRequest(ContextReadKind.Range, target.Sequence, 1),
                        1 => new ContextReadRequest(ContextReadKind.Model, Limit: 128),
                        2 => new ContextReadRequest(ContextReadKind.Search, Query: "topic3"),
                        _ => new ContextReadRequest(ContextReadKind.Anchor, AnchorId: session.Anchors.Keys.First())
                    };
                    var result = participant.Read(session.SessionId, request);
                    revision = result.SessionRevision;
                    category = request.Kind.ToString();
                    if (request.Kind == ContextReadKind.Range)
                        pointReads.Add((session.SessionId, revision, ((TextContent)result.Entries.Single().Content).Text));
                    if (result.Hits.Any(hit => hit.SessionRevision != revision))
                        throw new InvalidOperationException("Search returned a different index generation.");
                }
                double service = Stopwatch.GetElapsedTime(entered).TotalMilliseconds;
                requests.Add(new(worker, op, entered, category, session.SessionId, revision, status, queue, service, queue + service));
            }
        }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default)).ToArray();

        ready.Wait();
        long allocated = GC.GetTotalAllocatedBytes();
        int gen0 = GC.CollectionCount(0), gen1 = GC.CollectionCount(1), gen2 = GC.CollectionCount(2);
        began = Stopwatch.GetTimestamp();
        var sampler = SampleMemory();
        start.Set();
        try { await Task.WhenAll(tasks); }
        finally { stopSampling.Cancel(); await sampler; }
        double elapsed = Stopwatch.GetElapsedTime(began).TotalMilliseconds;
        allocated = GC.GetTotalAllocatedBytes() - allocated;

        // Sort committed versions independently of completion/notification order. Publication
        // happens before the writer records its result, so arrival order in ConcurrentBag is
        // not an execution order. Every point read must be explainable by an accepted root.
        var history = new Dictionary<(Guid, long), string>();
        foreach (var session in fixture.Sessions)
        {
            string initial = ((TextContent)ContextPolicies.Entries(session).ElementAt(4).Content).Text;
            history.Add((session.SessionId, 0), initial);
            long expected = 0;
            foreach (var commit in commits.Where(commit => commit.Session == session.SessionId).OrderBy(commit => commit.Revision))
            {
                if (commit.Revision != ++expected) throw new InvalidOperationException("Missing/duplicate committed revision.");
                history.Add((commit.Session, commit.Revision), commit.Text);
            }
            if (participant.Revision(session.SessionId) != expected) throw new InvalidOperationException("Lost accepted mutation.");
        }
        foreach (var read in pointReads)
            if (!history.TryGetValue((read.Session, read.Revision), out string? text) || text != read.Text)
                throw new InvalidOperationException("Point read cannot be explained by the committed history.");
        var samples = requests.OrderBy(request => request.Worker).ThenBy(request => request.Operation).ToImmutableArray();
        if (samples.Any(sample => sample.Status is not (null or ContextMutationStatus.Applied or
                ContextMutationStatus.RevisionConflict or ContextMutationStatus.AdmissionRejected)))
            throw new InvalidOperationException("Unexpected mutation failure.");
        return new(kind.ToString(), independentSessions, readers, writers, operationsPerWorker, arrivalsPerSecond,
            elapsed, writers * operationsPerWorker, commits.Count,
            samples.Count(sample => sample.Status == ContextMutationStatus.RevisionConflict),
            samples.Count(sample => sample.Status == ContextMutationStatus.AdmissionRejected),
            allocated, GC.CollectionCount(0) - gen0, GC.CollectionCount(1) - gen1, GC.CollectionCount(2) - gen2,
            samples, memory.ToImmutableArray(), Summarize(samples));

        async Task SampleMemory()
        {
            using var process = Process.GetCurrentProcess();
            do
            {
                process.Refresh();
                memory.Add(new(Stopwatch.GetElapsedTime(began).TotalMilliseconds, GC.GetTotalMemory(false),
                    GC.GetGCMemoryInfo().HeapSizeBytes, process.PrivateMemorySize64, process.WorkingSet64));
                try { await Task.Delay(50, stopSampling.Token); }
                catch (OperationCanceledException) { break; }
            } while (!stopSampling.IsCancellationRequested);
        }
    }

    // O(R log R) aggregation is deliberately AFTER the measured interval. Separate accepted
    // writes from conflicts: a faster rejection is not a faster useful mutation. These are
    // empirical nearest-rank percentiles with an explicit N, not confidence bounds or SLAs.
    private static ImmutableArray<LatencySummary> Summarize(ImmutableArray<RequestSample> requests)
    {
        return requests.GroupBy(request => (request.Category, request.Status))
            .OrderBy(group => group.Key.Category, StringComparer.Ordinal).ThenBy(group => group.Key.Status)
            .Select(group =>
            {
                var service = group.Select(request => request.ServiceMs).Order().ToArray();
                var total = group.Select(request => request.EndToEndMs).Order().ToArray();
                var queue = group.Select(request => request.QueueWaitMs).Order().ToArray();
                return new LatencySummary(group.Key.Category, group.Key.Status, service.Length,
                    Rank(service, .50), Rank(service, .95), Rank(service, .99),
                    Rank(total, .50), Rank(total, .95), Rank(total, .99), Rank(queue, .95));
            }).ToImmutableArray();
        static double Rank(double[] values, double percentile) =>
            values[Math.Clamp((int)Math.Ceiling(values.Length * percentile) - 1, 0, values.Length - 1)];
    }
}
