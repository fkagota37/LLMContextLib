// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using System.Diagnostics;

namespace LLMContextLib.Benchmarks;

/// <summary>
/// Bounded public-API diagnostic, not a capacity/SLA claim. Mutation samples let the worker
/// run naturally; separate query samples deliberately hold it before tokenization to measure
/// actual pending coverage. Never interpret that artificial query barrier as completion latency.
/// </summary>
internal static class DeferredIndexingExperiment
{
    private static readonly Guid SessionId = new(1, 0, 0, new byte[8]);
    private static readonly Guid EntryId = new(1000, 0, 0, new byte[8]);
    private static readonly DateTimeOffset Now = DateTimeOffset.UnixEpoch;
    private const int Rounds = 7, Calls = 8, QueryCalls = 32;
    private static int _sink;

    internal static async Task<object> Run(bool reverse)
    {
        var profiles = new[]
        {
            (Name: "Repeated", Text: string.Join(' ', Enumerable.Repeat("alpha beta", 2048))),
            (Name: "Unique", Text: string.Join(' ', Enumerable.Range(0, 2048).Select(i => $"word{i:D5}")))
        };
        string[] policies = reverse ? ["Deferred512", "Deferred128", "Synchronous"] :
            ["Synchronous", "Deferred128", "Deferred512"];
        var mutations = new List<MutationSample>();
        var queries = new List<QuerySample>();
        foreach (var profile in profiles)
        {
            foreach (string operation in new[] { "Append", "Replace" })
            {
                foreach (string policy in policies)
                    for (int warmup = 0; warmup < 4; warmup++)
                        await MeasureMutation(profile.Name, profile.Text, operation, policy, -1, warmup).ConfigureAwait(false);
                for (int round = 0; round < Rounds; round++)
                    for (int rotation = 0; rotation < policies.Length; rotation++)
                    {
                        string policy = policies[(round + rotation) % policies.Length];
                        for (int call = 0; call < Calls; call++)
                            mutations.Add(await MeasureMutation(profile.Name, profile.Text,
                                operation, policy, round, call).ConfigureAwait(false));
                    }
            }
            foreach (string policy in policies)
                for (int round = 0; round < 3; round++)
                    queries.AddRange(await MeasureQueries(profile.Name, profile.Text, policy, round).ConfigureAwait(false));
        }
        return new
        {
            Reverse = reverse,
            Rounds,
            Calls,
            QueryCalls,
            Assemblies = new[] { typeof(ILLMContextPolymorphicArray).Assembly, typeof(DeferredIndexingExperiment).Assembly }
                .Select(assembly => new
                {
                    Name = Path.GetFileName(assembly.Location),
                    Sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(assembly.Location)))
                }),
            Profiles = profiles.Select(profile => new
            {
                profile.Name,
                Characters = profile.Text.Length + " needlefinal".Length,
                FullTerms = ContextPolicies.Terms(profile.Text + " needlefinal").Length
            }),
            TimerBracket = Calibrate(),
            Mutations = mutations,
            Queries = queries,
            Sink = _sink
        };
    }

    private static LLMContextOptions Options(string policy, Action<CancellationToken>? before = null) => new()
    {
        AdmissionTimeout = TimeSpan.FromSeconds(5),
        DeferredIndexing = policy == "Synchronous" ? null : new()
        {
            ForegroundWords = policy == "Deferred128" ? 128 : 512,
            ForegroundCharacters = 8192
        },
        BeforeDeferredIndexing = before
    };

    private static LLMSessionContext Session(string? text)
    {
        var segments = ImmutableSortedDictionary<long, ContextSegment>.Empty;
        if (text is not null)
            segments = segments.Add(0, new(0, 0, [new(EntryId, 0, ContextRole.User, Now, new TextContent(text))]));
        return new(SessionId, new(2, 0, 0, new byte[8]), new(3, 0, 0, new byte[8]),
            0, SessionStatus.Active, segments, ImmutableDictionary<Guid, ConversationAnchor>.Empty);
    }

    private static async Task<MutationSample> MeasureMutation(string profile, string text,
        string operation, string policy, int round, int call)
    {
        using var owner = LLMContextFactory.Create(Options(policy))
            .Initialize([Session(operation == "Replace" ? text + " oldtail" : null)]);
        await owner.WaitForIndexingAsync(SessionId, 0).ConfigureAwait(false);
        var content = new TextContent(text + " needlefinal");
        ContextChange change = operation == "Replace" ? new ReplaceEntry(EntryId, content) :
            new AppendEntries([new(EntryId, ContextRole.User, Now, content)]);
        var request = new ContextChangeSet(SessionId, 0, [change]);
        // The measured synchronous call cannot migrate threads. The process-wide counter
        // additionally observes worker/runtime allocation through completion, not just Apply.
        long processBefore = GC.GetTotalAllocatedBytes(precise: true);
        long threadBefore = GC.GetAllocatedBytesForCurrentThread();
        long started = Stopwatch.GetTimestamp();
        var result = owner.Apply(request);
        long returned = Stopwatch.GetTimestamp();
        long callerBytes = GC.GetAllocatedBytesForCurrentThread() - threadBefore;
        if (result.Status != ContextMutationStatus.Applied) throw new InvalidOperationException(result.Error);
        var observed = owner.GetStatistics();
        await owner.WaitForIndexingAsync(SessionId, result.Revision).ConfigureAwait(false);
        long complete = Stopwatch.GetTimestamp();
        long totalBytes = GC.GetTotalAllocatedBytes(precise: true) - processBefore;
        var final = owner.GetStatistics();
        using var read = owner.OpenRead(SessionId);
        if (!read.IndexStatus.IsComplete || read.SearchIndexed("needlefinal", 10).Hits.Length != 1 ||
            final.PendingIndexWork != 0 || final.EstimatedIndexWorkBytes != 0)
            throw new InvalidOperationException("Incomplete/incorrect final index or leaked work reservation.");
        _sink += read.Search("needlefinal", 10).Length;
        return new(profile, operation, policy, round, call, returned - started, complete - started,
            callerBytes, totalBytes, observed.PendingIndexWork, observed.EstimatedIndexWorkBytes,
            observed.EstimatedActiveBytes, final.EstimatedActiveBytes);
    }

    private static async Task<IReadOnlyList<QuerySample>> MeasureQueries(string profile, string text, string policy, int round)
    {
        using var release = new ManualResetEventSlim();
        using var owner = LLMContextFactory.Create(Options(policy, token => release.Wait(token)))
            .Initialize([Session(text + " needlefinal")]);
        using var captured = owner.OpenRead(SessionId);
        var blocked = owner.GetStatistics();
        var samples = new List<QuerySample>
        {
            Query("CapturedExact", () => captured.Search("needlefinal", 10).Length, 1, captured.IndexStatus),
            Query("CapturedIndexed", () => captured.SearchIndexed("needlefinal", 10).Hits.Length,
                policy == "Synchronous" ? 1 : 0, captured.IndexStatus)
        };
        release.Set();
        await owner.WaitForIndexingAsync(SessionId, 0).ConfigureAwait(false);
        using var fresh = owner.OpenRead(SessionId);
        samples.Add(Query("FreshIndexed", () => fresh.SearchIndexed("needlefinal", 10).Hits.Length, 1, fresh.IndexStatus));
        return samples;

        QuerySample Query(string stage, Func<int> search, int expected, ContextIndexStatus status)
        {
            for (int warmup = 0; warmup < 8; warmup++) _sink += search();
            var ticks = new long[QueryCalls];
            var bytes = new long[QueryCalls];
            for (int i = 0; i < QueryCalls; i++)
            {
                long allocation = GC.GetAllocatedBytesForCurrentThread();
                long started = Stopwatch.GetTimestamp();
                int count = search();
                ticks[i] = Stopwatch.GetTimestamp() - started;
                bytes[i] = GC.GetAllocatedBytesForCurrentThread() - allocation;
                if (count != expected) throw new InvalidOperationException("Query result violates declared coverage.");
                _sink += count;
            }
            return new(profile, policy, stage, round, status.PendingEntries, expected,
                blocked.EstimatedIndexWorkBytes, blocked.EstimatedActiveBytes,
                owner.GetStatistics().EstimatedRetainedBytes, ticks, bytes);
        }
    }

    private static long[] Calibrate()
    {
        var ticks = new long[4096];
        for (int i = 0; i < ticks.Length; i++)
        {
            long start = Stopwatch.GetTimestamp();
            ticks[i] = Stopwatch.GetTimestamp() - start;
        }
        return ticks;
    }

    private sealed record MutationSample(string Profile, string Operation, string Policy, int Round, int Call,
        long ApplyTicks, long CompleteTicks, long CallerBytes, long ProcessBytesThroughCompletion,
        int ObservedPendingWork, long ObservedWorkBytes, long ObservedActiveBytes, long FinalActiveBytes);

    private sealed record QuerySample(string Profile, string Policy, string Stage, int Round,
        int PendingEntries, int ExpectedHits, long ReservedWorkBytes, long ObservedActiveBytes,
        long ObservedRetainedBytes, long[] RawTicks, long[] RawBytes);
}
