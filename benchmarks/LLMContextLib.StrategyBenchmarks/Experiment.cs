// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using System.Diagnostics;
using System.Runtime.CompilerServices;

namespace LLMContextLib.StrategyBenchmarks;

internal sealed record Policy(string Name, int Collector = 0, int MemoMiB = 0,
    ContextIndexingStrategy Indexing = ContextIndexingStrategy.Synchronous, bool Original = false);
internal sealed record Mutation(long ApplyTicks, long CompleteTicks, long CallerBytes, long ProcessBytes);
internal sealed record Query(long Ticks, long Bytes, int Hits, int Pending);
internal sealed record SequentialRun(string Profile, string Reuse, string Operation, string Candidate,
    string Policy, int Position, int Characters, int Terms, long WallTicks, long ActiveBytes,
    ContextExecutionStatistics? Execution, Mutation[] Mutations, Query[] Queries);
internal sealed record Request(int Worker, int Index, string Kind, Guid Session, long Ticks, long QueueTicks,
    long EndToEndTicks, long CallerBytes,
    string Outcome, long Revision, int Pending, Guid Entry, int Variant);
internal sealed record HeapSample(long Ticks, long ManagedBytes, long PrivateBytes, int Pending, long ActiveBytes);
internal sealed record LoadRun(string Profile, string Policy, bool Serialized, bool Distributed,
    int Calls, long ForegroundTicks, long ThroughCompletionTicks, long ProcessBytes,
    long BaselineManagedBytes, long GCPauseTicks, int[] Collections, LLMContextStatistics Final,
    Request[] Requests, HeapSample[] Heap);
internal sealed record MemoryRun(string Profile, string Policy, int Sample, long ActiveHeap,
    long TwoGenerationHeap, long AfterDeleteHeap, long AfterDisposeHeap,
    long EstimatedActiveBytes, long EstimatedRetainedBytes, long EstimatedAfterDeleteBytes, int MemoEntries);

internal static class Experiment
{
    internal static readonly Policy[] Policies =
    [
        new("Native", Original: true), new("PinnedNative"),
        new("LuceneRange", Collector: 1), new("LuceneChar", Collector: 2),
        new("MemoNative1M", MemoMiB: 1), new("MemoRange1M", Collector: 1, MemoMiB: 1),
        new("Deferred", Indexing: ContextIndexingStrategy.Configured),
        new("AppendRouter", Indexing: ContextIndexingStrategy.AppendOptimized),
        new("ComposedNative1M", MemoMiB: 1, Indexing: ContextIndexingStrategy.AppendOptimized),
        new("ComposedRange1M", Collector: 1, MemoMiB: 1, Indexing: ContextIndexingStrategy.AppendOptimized),
        new("ComposedNative4M", MemoMiB: 4, Indexing: ContextIndexingStrategy.AppendOptimized),
        new("ComposedRange4M", Collector: 1, MemoMiB: 4, Indexing: ContextIndexingStrategy.AppendOptimized)
    ];
    private static readonly string[] Profiles = ["Repeated", "Unique"];
    private static readonly string Repeated = string.Join(' ', Enumerable.Repeat("alpha beta", 256));
    private static readonly string Unique = string.Join(' ', Enumerable.Range(0, 512).Select(i => $"word{i:D5}"));
    private static int _sink;
    private static Guid Id(int value) => new(value, 0, 0, new byte[8]);
    private static string Text(string profile, int variant) => (profile == "Repeated" ? Repeated : Unique) + $" tail{variant:D6}";
    private static string Tail(int variant) => $"tail{variant:D6}";

    internal static LLMContextFactoryBuilder Builder(Policy policy, bool serialized = false, bool validation = false)
    {
        var builder = LLMContextFactory.Create(new()
        {
            MaximumEntriesPerSegment = 32,
            MaximumEstimatedBytesPerSegment = 1024 * 1024,
            EstimatedResidentByteBudget = 128L * 1024 * 1024,
            MaximumEstimatedRetainedBytes = 128L * 1024 * 1024,
            MaximumRetainedReads = 64,
            AdmissionTimeout = validation ? TimeSpan.FromSeconds(5) : TimeSpan.Zero,
            DeferredIndexing = policy.Indexing != ContextIndexingStrategy.Synchronous ? new()
            {
                ForegroundWords = 16,
                ForegroundCharacters = 1024,
                MaximumPendingEntries = validation ? 256 : 32,
                MaximumEstimatedWorkBytes = 16 * 1024 * 1024
            } : null
        });
        if (!policy.Original || serialized)
            builder = builder.WithExecutionStrategies(new()
            {
                Indexing = policy.Indexing,
                MinimumDeferredCharacters = 1024,
                Preparation = serialized ? ContextPreparationStrategy.Serialized : ContextPreparationStrategy.Speculative
            });
        if (policy.Collector != 0)
            builder = builder.WithLuceneTermCollection(policy.Collector == 1
                ? LuceneTermCollection.RangeBuffer : LuceneTermCollection.CharTerm);
        if (policy.MemoMiB != 0)
            builder = builder.WithBitFasterTermMemoization(new()
            {
                Capacity = 64,
                MaximumTextCharacters = 8192,
                MaximumEstimatedBytes = policy.MemoMiB * 1024L * 1024
            });
        return builder;
    }

    private static LLMSessionContext Session(int id, string profile, bool empty = false)
    {
        var entries = Enumerable.Range(0, empty ? 0 : 8).Select(i =>
            new ContextEntry(Id(id * 1000 + i), i, ContextRole.User,
                DateTimeOffset.UnixEpoch, new TextContent(Text(profile, i)))).ToImmutableArray();
        return new(Id(id), Id(900), null, 0, SessionStatus.Active,
            empty ? ImmutableSortedDictionary<long, ContextSegment>.Empty :
                ImmutableSortedDictionary<long, ContextSegment>.Empty.Add(0, new(0, 0, entries)),
            ImmutableDictionary<Guid, ConversationAnchor>.Empty);
    }

    private static void Complete(ILLMContextPolymorphicArray owner, Guid session, long revision) =>
        owner.WaitForIndexingAsync(session, revision).WaitAsync(TimeSpan.FromSeconds(30)).GetAwaiter().GetResult();

    private static int Variant(string reuse, int i) =>
        reuse == "Cold" || (reuse == "Mixed" && i % 5 == 4) ? 1000 + i : (i / 8 + i % 8) % 8;

    private static ContextChange Change(bool append, Guid entry, string text) => append
        ? new AppendEntries([new(entry, ContextRole.User, DateTimeOffset.UnixEpoch, new TextContent(text))])
        : new ReplaceEntry(entry, new TextContent(text));

    internal static List<SequentialRun> Sequential(int calls, bool reverse)
    {
        var results = new List<SequentialRun>();
        var candidates = reverse ? Policies.Skip(1).Reverse().ToArray() : Policies.Skip(1).ToArray();
        foreach (string profile in Profiles)
            foreach (string reuse in new[] { "Hot", "Cold", "Mixed" })
                foreach (string operation in new[] { "Append", "Replace" })
                {
                    foreach (var policy in Policies)
                        _ = MeasureSequential(profile, reuse, operation, policy, policy.Name, 0, 32);
                    foreach (var candidate in candidates)
                    {
                        var pair = reverse ? new[] { candidate, Policies[0] } : [Policies[0], candidate];
                        for (int position = 0; position < pair.Length; position++)
                            results.Add(MeasureSequential(profile, reuse, operation, pair[position],
                                candidate.Name, position, calls));
                    }
                    Console.WriteLine($"PASS sequential {profile}/{reuse}/{operation}");
                }
        return results;
    }

    private static SequentialRun MeasureSequential(string profile, string reuse, string operation,
        Policy policy, string candidate, int position, int calls)
    {
        using var owner = Builder(policy).Initialize([Session(1, profile)]);
        Complete(owner, Id(1), 0);
        var requests = Enumerable.Range(0, calls).Select(i => new ContextChangeSet(Id(1), i,
            [Change(operation == "Append", Id(operation == "Append" ? 2000 + i : 1000 + i % 8),
                Text(profile, Variant(reuse, i)))])).ToArray();
        var queries = Enumerable.Range(0, calls).Select(i => Tail(Variant(reuse, i))).ToArray();
        var mutations = new Mutation[calls];
        var reads = new Query[calls];
        long wall = Stopwatch.GetTimestamp();
        for (int i = 0; i < calls; i++)
        {
            long process = GC.GetTotalAllocatedBytes(precise: true);
            long allocation = GC.GetAllocatedBytesForCurrentThread();
            long start = Stopwatch.GetTimestamp();
            var result = owner.Apply(requests[i]);
            long returned = Stopwatch.GetTimestamp();
            long caller = GC.GetAllocatedBytesForCurrentThread() - allocation;
            if (result.Status != ContextMutationStatus.Applied) throw new InvalidOperationException(result.Error);
            Complete(owner, Id(1), result.Revision);
            long complete = Stopwatch.GetTimestamp();
            long total = GC.GetTotalAllocatedBytes(precise: true) - process;
            mutations[i] = new(returned - start, complete - start, caller, total);
            using var read = owner.OpenRead(Id(1));
            reads[i] = Search(read, queries[i]);
            if (!read.IndexStatus.IsComplete) throw new InvalidOperationException("Completion returned a partial current index.");
        }
        wall = Stopwatch.GetTimestamp() - wall;
        var stats = owner.GetStatistics();
        CheckDrained(stats);
        string text = Text(profile, 0);
        return new(profile, reuse, operation, candidate, policy.Name, position, text.Length,
            ContextPolicies.Terms(text).Length, wall, stats.EstimatedActiveBytes, stats.Execution, mutations, reads);
    }

    private static Query Search(ILLMContextReadLease read, string query)
    {
        long allocation = GC.GetAllocatedBytesForCurrentThread();
        long start = Stopwatch.GetTimestamp();
        var hits = read.Search(query, 16);
        long elapsed = Stopwatch.GetTimestamp() - start;
        long bytes = GC.GetAllocatedBytesForCurrentThread() - allocation;
        ValidateSearch(read.Session, query, hits);
        _sink = hits.Length;
        return new(elapsed, bytes, hits.Length, read.IndexStatus.PendingEntries);
    }

    private static void ValidateSearch(LLMSessionContext session, string query, ImmutableArray<ContextSearchHit> hits)
    {
        int count = 0;
        string suffix = " " + query;
        foreach (var segment in session.Segments.Values)
            foreach (var entry in segment.Entries)
                if (((TextContent)entry.Content).Text.EndsWith(suffix, StringComparison.Ordinal))
                {
                    if (count < 16 && (count >= hits.Length || hits[count].EntryId != entry.EntryId))
                        throw new InvalidOperationException("Exact search differs from full captured-content scan.");
                    count++;
                }
        if (hits.Length != Math.Min(count, 16)) throw new InvalidOperationException("Exact hit count differs.");
    }

    internal static List<LoadRun> Load(int calls, bool reverse)
    {
        string[] names = ["PinnedNative", "Deferred", "AppendRouter", "ComposedNative1M", "ComposedRange1M", "ComposedNative4M"];
        var policies = Policies.Where(policy => names.Contains(policy.Name, StringComparer.Ordinal)).ToArray();
        if (reverse) Array.Reverse(policies);
        var result = new List<LoadRun>();
        foreach (string profile in Profiles)
            foreach (bool distributed in new[] { false, true })
                foreach (var policy in policies)
                    foreach (bool serialized in reverse ? new[] { true, false } : [false, true])
                    {
                        _ = MeasureSequential(profile, "Mixed", "Replace", policy, policy.Name, 0, 16);
                        result.Add(MeasureLoad(profile, policy, serialized, distributed, calls));
                        Console.WriteLine($"PASS load {profile}/{policy.Name}/serial={serialized}/distributed={distributed}");
                    }
        return result;
    }

    private static LoadRun MeasureLoad(string profile, Policy policy, bool serialized, bool distributed, int calls)
    {
        var sessions = Enumerable.Range(1, distributed ? 2 : 1).Select(i => Session(i, profile)).ToArray();
        using var owner = Builder(policy, serialized).Initialize(sessions);
        foreach (var session in sessions) Complete(owner, session.SessionId, 0);
        string[] texts = Enumerable.Range(0, calls).Select(i => Text(profile, Variant("Mixed", i))).ToArray();
        var records = new Request[calls * 4];
        var heap = new List<HeapSample>();
        using var start = new ManualResetEventSlim();
        using var ready = new CountdownEvent(5);
        using var stop = new CancellationTokenSource();
        long baseline = GC.GetTotalMemory(forceFullCollection: true);
        long began = 0;
        var sampler = Task.Run(() =>
        {
            ready.Signal();
            start.Wait();
            using var process = Process.GetCurrentProcess();
            while (!stop.IsCancellationRequested)
            {
                process.Refresh();
                var stats = owner.GetStatistics();
                heap.Add(new(Stopwatch.GetTimestamp() - began, GC.GetTotalMemory(false),
                    process.PrivateMemorySize64, stats.PendingIndexWork, stats.EstimatedActiveBytes));
                stop.Token.WaitHandle.WaitOne(10);
            }
        });
        var workers = Enumerable.Range(0, 4).Select(worker => Task.Factory.StartNew(() =>
        {
            ready.Signal();
            start.Wait();
            for (int i = 0; i < calls; i++)
            {
                long due = began + i * Stopwatch.Frequency / 1000;
                WaitUntil(due);
                int session = distributed ? worker % 2 + 1 : 1;
                int variant = Variant("Mixed", i);
                Guid entry = Id(i % 4 == 0 ? 100_000 + worker * 1000 + i : session * 1000 + i % 8);
                if (worker < 2)
                {
                    if (!owner.TryFind(Id(session), out var root)) throw new InvalidOperationException("Lost session.");
                    var request = new ContextChangeSet(Id(session), root.Revision,
                        [Change(i % 4 == 0, entry, texts[i])]);
                    long bytes = GC.GetAllocatedBytesForCurrentThread();
                    long before = Stopwatch.GetTimestamp();
                    var result = owner.Apply(request);
                    long returned = Stopwatch.GetTimestamp();
                    bytes = GC.GetAllocatedBytesForCurrentThread() - bytes;
                    records[worker * calls + i] = new(worker, i, i % 4 == 0 ? "Append" : "Replace",
                        Id(session), returned - before, before - due, returned - due, bytes,
                        result.Status.ToString(), result.Revision, 0, entry, variant);
                }
                else
                {
                    string query = Tail(variant);
                    long bytes = GC.GetAllocatedBytesForCurrentThread();
                    long before = Stopwatch.GetTimestamp();
                    using var read = owner.OpenRead(Id(session));
                    var hits = read.Search(query, 16);
                    long returned = Stopwatch.GetTimestamp();
                    bytes = GC.GetAllocatedBytesForCurrentThread() - bytes;
                    ValidateSearch(read.Session, query, hits);
                    records[worker * calls + i] = new(worker, i, "Search", Id(session),
                        returned - before, before - due, returned - due, bytes, "Succeeded",
                        read.Session.Revision, read.IndexStatus.PendingEntries, Guid.Empty, variant);
                }
            }
        }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default)).ToArray();
        if (!ready.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException("Load workers did not become ready.");
        long allocated = GC.GetTotalAllocatedBytes(precise: true);
        long pause = GC.GetTotalPauseDuration().Ticks;
        int[] collections = Enumerable.Range(0, 3).Select(GC.CollectionCount).ToArray();
        began = Stopwatch.GetTimestamp();
        start.Set();
        try
        {
            Task.WhenAll(workers).WaitAsync(TimeSpan.FromSeconds(60)).GetAwaiter().GetResult();
            long foreground = Stopwatch.GetTimestamp() - began;
            foreach (var session in sessions)
            {
                if (!owner.TryFind(session.SessionId, out var current)) throw new InvalidOperationException("Lost session.");
                Complete(owner, session.SessionId, current.Revision);
            }
            long complete = Stopwatch.GetTimestamp() - began;
            stop.Cancel();
            sampler.GetAwaiter().GetResult();
            long processBytes = GC.GetTotalAllocatedBytes(precise: true) - allocated;
            long pauses = GC.GetTotalPauseDuration().Ticks - pause;
            int[] counts = Enumerable.Range(0, 3).Select(i => GC.CollectionCount(i) - collections[i]).ToArray();
            var final = owner.GetStatistics();
            CheckDrained(final);
            CheckAcceptedHistory(owner, sessions, records);
            return new(profile, policy.Name, serialized, distributed, calls, foreground, complete,
                processBytes, baseline, pauses, counts, final, records, heap.ToArray());
        }
        finally
        {
            stop.Cancel();
            sampler.GetAwaiter().GetResult();
        }
    }

    private static void WaitUntil(long due)
    {
        while (true)
        {
            long remaining = due - Stopwatch.GetTimestamp();
            if (remaining <= 0) return;
            if (remaining > Stopwatch.Frequency / 500) Thread.Sleep(1);
            else Thread.SpinWait(32);
        }
    }

    private static void CheckAcceptedHistory(ILLMContextPolymorphicArray owner, LLMSessionContext[] sessions, Request[] records)
    {
        foreach (var session in sessions)
        {
            var expected = session.Segments.Values.SelectMany(segment => segment.Entries)
                .ToDictionary(entry => entry.EntryId, entry => ((TextContent)entry.Content).Text);
            long revision = 0;
            foreach (var request in records.Where(request =>
                request.Session == session.SessionId && request.Outcome == "Applied").OrderBy(request => request.Revision))
            {
                if (request.Revision != ++revision) throw new InvalidOperationException("Accepted revisions are not contiguous.");
                expected[request.Entry] = Text(((TextContent)session.Segments[0].Entries[0].Content).Text
                    .StartsWith("alpha", StringComparison.Ordinal) ? "Repeated" : "Unique", request.Variant);
            }
            using var read = owner.OpenRead(session.SessionId);
            if (read.Session.Revision != revision) throw new InvalidOperationException("Lost accepted mutation.");
            var entries = read.Session.Segments.Values.SelectMany(segment => segment.Entries).ToArray();
            if (entries.Length != expected.Count || entries.Any(entry =>
                !expected.TryGetValue(entry.EntryId, out string? text) || ((TextContent)entry.Content).Text != text))
                throw new InvalidOperationException("Final content differs from replay of accepted writes.");
        }
    }

    internal static List<MemoryRun> Memory(bool reverse)
    {
        var result = new List<MemoryRun>();
        var policies = reverse ? Policies.Reverse().ToArray() : Policies;
        foreach (string profile in Profiles)
            foreach (var policy in policies)
                for (int sample = 0; sample < 3; sample++)
                {
                    result.Add(MeasureMemory(profile, policy, sample));
                    Console.WriteLine($"PASS memory {profile}/{policy.Name}/{sample}");
                }
        return result;
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static MemoryRun MeasureMemory(string profile, Policy policy, int sample)
    {
        long baseline = GC.GetTotalMemory(forceFullCollection: true);
        using var owner = Builder(policy).Initialize([Session(1, profile, empty: true)]);
        Populate(owner, profile, replace: false);
        long active = GC.GetTotalMemory(forceFullCollection: true) - baseline;
        var retained = CaptureAndReplace(owner, profile, baseline);
        Delete(owner);
        long deleted = GC.GetTotalMemory(forceFullCollection: true) - baseline;
        var afterDelete = owner.GetStatistics();
        owner.Dispose();
        long disposed = GC.GetTotalMemory(forceFullCollection: true) - baseline;
        GC.KeepAlive(owner);
        return new(profile, policy.Name, sample, active, retained.Heap, deleted, disposed,
            retained.Active, retained.Retained, afterDelete.EstimatedActiveBytes, afterDelete.Execution?.MemoEntries ?? 0);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static (long Heap, long Active, long Retained) CaptureAndReplace(
        ILLMContextPolymorphicArray owner, string profile, long baseline)
    {
        using var read = owner.OpenRead(Id(1));
        Populate(owner, profile, replace: true);
        long heap = GC.GetTotalMemory(forceFullCollection: true) - baseline;
        var stats = owner.GetStatistics();
        return (heap, stats.EstimatedActiveBytes, stats.EstimatedRetainedBytes);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Populate(ILLMContextPolymorphicArray owner, string profile, bool replace)
    {
        for (int i = 0; i < 64; i++)
        {
            long revision = (replace ? 64 : 0) + i;
            var request = new ContextChangeSet(Id(1), revision,
                [Change(!replace, Id(2000 + i), Text(profile, (replace ? 1000 : 0) + i))]);
            var result = owner.Apply(request);
            if (result.Status != ContextMutationStatus.Applied) throw new InvalidOperationException(result.Error);
            Complete(owner, Id(1), revision + 1);
        }
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void Delete(ILLMContextPolymorphicArray owner)
    {
        var result = owner.Apply(new(Id(1), 128, Enumerable.Range(0, 64)
            .Select(i => (ContextChange)new DeleteEntry(Id(2000 + i))).ToImmutableArray()));
        if (result.Status != ContextMutationStatus.Applied) throw new InvalidOperationException(result.Error);
        Complete(owner, Id(1), 129);
    }

    private static void CheckDrained(LLMContextStatistics stats)
    {
        if (stats.PendingIndexWork != 0 || stats.EstimatedIndexWorkBytes != 0 || stats.RetainedReads != 0)
            throw new InvalidOperationException("Leaked work or read reservation.");
    }
}
