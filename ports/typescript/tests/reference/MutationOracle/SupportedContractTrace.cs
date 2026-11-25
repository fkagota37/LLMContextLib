// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using System.Text.Json;
using LLMContextLib;

internal static class SupportedContractTrace
{
    private static readonly Guid SessionId = Id(1);
    private static readonly Guid UserId = Id(2);
    private static readonly Guid EntryId = Id(3);

    internal static async Task Run()
    {
        var rows = new List<object>();
        void Check(string label, Action action) => rows.Add(new { label, outcome = Outcome(action) });
        var defaults = new LLMContextOptions();
        foreach (string field in new[] { "MaximumEntriesPerSegment", "MaximumEstimatedBytesPerSegment",
            "EstimatedResidentByteBudget", "MaximumEstimatedRetainedBytes", "MaximumRetainedReads", "MaximumViewResults" })
        {
            foreach (long value in new long[] { -1, 0, 1, int.MaxValue })
            {
                var options = defaults with { };
                typeof(LLMContextOptions).GetProperty(field)!.SetValue(options,
                    typeof(LLMContextOptions).GetProperty(field)!.PropertyType == typeof(int) ? (object)(int)value : value);
                Check($"options/{field}/{value}", () => LLMContextFactory.Create(options).Initialize([]).Dispose());
            }
        }
        foreach (double value in new[] { -1d, 0d, 0.0001, 2147483647d, 2147483648d })
            Check($"options/timeout/{value.ToString(System.Globalization.CultureInfo.InvariantCulture)}",
                () => LLMContextFactory.Create(defaults with { AdmissionTimeout = TimeSpan.FromMilliseconds(value) }).Initialize([]).Dispose());
        foreach (string field in new[] { "TimeProvider", "EntrySizeEstimator", "ProjectionSizeEstimator" })
        {
            var options = defaults with { };
            typeof(LLMContextOptions).GetProperty(field)!.SetValue(options, null);
            Check($"options/null/{field}", () => LLMContextFactory.Create(options));
        }
        Check("options/unknown-mode", () => LLMContextFactory.Create(defaults with { IndexingMode = (ContextIndexingMode)99 }));
        Check("options/producer-deferred", () => LLMContextFactory.Create(defaults with
        { IndexingMode = ContextIndexingMode.ProducerOwned, DeferredIndexing = new() }));
        Check("options/text-partitions", () => LLMContextFactory.Create(defaults with { PartitionedIndex = new() }));
        Check("options/partition-headroom", () => LLMContextFactory.Create(LLMContextOptions.WriteOptimized with
        { EstimatedResidentByteBudget = 1 }));

        var token = new object();
        int estimatorCalls = 0;
        long estimate = 37;
        var callbackFailure = new ApplicationException("configured estimator failed");
        var configured = defaults with
        {
            MaximumViewResults = 2,
            ProjectionSizeEstimator = item =>
            {
                if (!ReferenceEquals(item, token)) throw new Exception("Estimator did not receive materialized object.");
                estimatorCalls++;
                if (estimate == -2) throw callbackFailure;
                return estimate;
            }
        };
        var copied = configured with { MaximumRetainedReads = 1 };
        rows.Add(new { label = "options/copy", originalReads = configured.MaximumRetainedReads,
            copiedReads = copied.MaximumRetainedReads,
            sameCallback = ReferenceEquals(configured.ProjectionSizeEstimator, copied.ProjectionSizeEstimator),
            sameClock = ReferenceEquals(configured.TimeProvider, copied.TimeProvider),
            defaultsUnchanged = defaults.MaximumViewResults == 4096 });
        var builder = LLMContextFactory.Create(copied);
        using var owner = builder.Initialize([Session()]);
        using var independent = builder.Initialize([Session()]);
        rows.Add(new { label = "options/reusable-builder", first = owner.GetStatistics().Sessions,
            second = independent.GetStatistics().Sessions });
        foreach (long next in new long[] { 37, 0, -1, -2, long.MaxValue })
        {
            estimate = next;
            Check($"projection/{next}", () =>
            {
                using var view = owner.OpenView(new Projection(SessionId, 1, () => [token]));
                rows.Add(new { label = $"projection/live/{next}", identity = ReferenceEquals(view[0], token),
                    bytes = owner.GetStatistics().EstimatedViewBytes.ToString(),
                    reads = owner.GetStatistics().RetainedReads });
            });
            rows.Add(Recovery(owner, $"projection/recovered/{next}"));
        }
        estimate = 37;
        Check("projection/evaluation-failure", () => owner.OpenView(new Projection(SessionId, 1,
            () => throw new ApplicationException("evaluation failed"))));
        Check("projection/zero-limit", () => owner.OpenView(new Projection(SessionId, 0, () => ThrowOnEnumeration())).Dispose());
        Check("projection/invalid-limit", () => owner.OpenView(new Projection(SessionId, 3, () => [token])).Dispose());
        rows.Add(new { label = "projection/callback-count", estimatorCalls });
        rows.Add(Recovery(owner, "projection/final-recovery"));
        using (var held = owner.OpenRead(SessionId))
            Check("read/admission-rejected", () => owner.OpenRead(SessionId).Dispose());
        using (var read = owner.OpenRead(SessionId))
        {
            Check("read/range-negative", () => read.ReadRange(-1, 1));
            Check("read/count-negative", () => read.ReadRange(0, -1));
            Check("read/range-zero", () => read.ReadRange(0, 0));
            Check("read/range-max", () => read.ReadRange(long.MaxValue, int.MaxValue));
            Check("read/page-zero", () => read.ReadPage(null, 0));
            Check("read/page-wrong-session", () => read.ReadPage(new(Id(9), 0, 0), 1));
            Check("read/page-wrong-revision", () => read.ReadPage(new(SessionId, 1, 0), 1));
            Check("read/page-negative-cursor", () => read.ReadPage(new(SessionId, 0, -1), 1));
            Check("read/page-max-cursor", () => read.ReadPage(new(SessionId, 0, long.MaxValue), 1));
            Check("read/search-negative", () => read.Search("word", -1));
            Check("read/search-null", () => read.Search(null!, 1));
            Check("read/search-empty", () => read.Search("", int.MaxValue));
            Check("read/keys-null", () => read.SearchKeys(null!, 1));
            Check("read/anchor-missing", () => read.ResolveAnchor(Id(9)));
        }
        rows.Add(Recovery(owner, "read/recovered"));
        Check("read/missing", () => owner.OpenRead(Id(9)));
        Check("initialize/duplicates", () => builder.Initialize([Session(), Session()]));
        Check("initialize/selector", () => LLMContextFactory.Create(null, _ => Id(9)).Initialize([Session()]));
        Check("initialize/enumerator-failure", () => builder.Initialize(FailedSessions()));
        await AsyncCheck("wait/missing", () => owner.WaitForIndexingAsync(Id(9), 0));
        await AsyncCheck("wait/revision", () => owner.WaitForIndexingAsync(SessionId, 1));
        await AsyncCheck("wait/complete", () => owner.WaitForIndexingAsync(SessionId, 0));
        await AsyncCheck("synchronize/not-supported", () => owner.SynchronizeIndexAsync(SessionId));
        using (var cancelled = new CancellationTokenSource())
        {
            cancelled.Cancel();
            await AsyncCheck("wait/cancelled", () => owner.WaitForIndexingAsync(SessionId, 0, cancelled.Token));
            await AsyncCheck("synchronize/cancelled", () => owner.SynchronizeIndexAsync(SessionId, cancelled.Token));
        }
        ScopeTrace(rows);
        ResourceTrace(rows);
        owner.Dispose();
        Check("owner/disposed", () => owner.GetStatistics());
        await AsyncCheck("wait/disposed", () => owner.WaitForIndexingAsync(SessionId, 0));
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            reference = "479d2612315cbd292da917bae6d8d3fec35fea24", rows
        }));

        async Task AsyncCheck(string label, Func<Task> action)
        {
            string outcome;
            try { await action(); outcome = "ok"; }
            catch (Exception error) { outcome = Category(error); }
            rows.Add(new { label, outcome });
        }
    }

    private static void ScopeTrace(List<object> rows)
    {
        var session = Session();
        var anchorId = Id(4);
        session = session with
        {
            Segments = session.Segments.Add(0, new(0, 0, [new(EntryId, 0, ContextRole.User,
                DateTimeOffset.UnixEpoch, new TextContent("source"))])),
            Anchors = session.Anchors.Add(anchorId,
                new(anchorId, EntryId, EntryId, "source", "", [], AnchorKind.Manual, 0, null))
        };
        using var owner = LLMContextFactory.Create(new LLMContextOptions { TimeProvider = new EpochClock() }).Initialize([session]);
        var scopes = new[] { new MemoryScope(UserId: UserId), new MemoryScope(SessionId: SessionId),
            new MemoryScope(UserId: UserId, SessionId: SessionId) };
        var memories = scopes.Select((scope, index) => new ContextMemory(Id(10 + index), scope, $"memory{index}", 0,
            MemoryStatus.Confirmed, null, [new(SessionId, anchorId)])).ToImmutableArray();
        var result = owner.ApplyMemory(new(0, memories, []));
        using var captured = owner.OpenRead(SessionId);
        for (int index = 0; index < scopes.Length; index++)
        {
            var scope = scopes[index] with { };
            rows.Add(new { label = $"scope/{index}", status = result.Status.ToString(),
                policy = ContextPolicies.ApplicableMemory(memories, session, [scope], DateTimeOffset.UnixEpoch).Select(x => x.MemoryId),
                storage = captured.GetApplicableMemory([scope]).Select(x => x.MemoryId) });
        }
        owner.ApplyMemory(new(1, [], [Id(10)]));
        owner.RemoveSession(SessionId, 0);
        owner.Dispose();
        rows.Add(new { label = "scope/retained", revision = captured.MemoryRevision,
            memory = captured.GetApplicableMemory([new(UserId: UserId)]).Select(x => x.MemoryId) });
    }

    private static void ResourceTrace(List<object> rows)
    {
        const long budget = 8192;
        long outputBytes = 1;
        using var owner = LLMContextFactory.Create(new LLMContextOptions
        {
            EstimatedResidentByteBudget = budget,
            ProjectionSizeEstimator = _ => outputBytes
        }).Initialize([Session()]);
        using var old = owner.OpenRead(SessionId);
        var stats = owner.GetStatistics();
        outputBytes = budget - stats.EstimatedActiveBytes - stats.EstimatedRetainedBytes;
        using var view = owner.OpenView(new Projection(SessionId, 1, () => [new object()]));
        var other = Session() with { SessionId = Id(20) };
        var changes = new ContextChangeSet(SessionId, 0,
            [new AppendEntries([new(EntryId, ContextRole.User, DateTimeOffset.UnixEpoch, new TextContent("admitted"))])]);
        var memory = new MemoryChangeSet(0,
            [new(Id(21), new(UserId: UserId), "proposed", 0, MemoryStatus.Proposed, null, [])], []);
        rows.Add(new { label = "resource/rejected", create = owner.CreateSession(other).Status.ToString(),
            session = owner.Apply(changes).Status.ToString(), memory = owner.ApplyMemory(memory).Status.ToString(),
            revision = owner.TryFind(SessionId, out var before) ? before.Revision : -1,
            memoryRevision = owner.GetStatistics().MemoryRevision, oldRevision = old.Session.Revision,
            view = owner.GetStatistics().EstimatedViewBytes.ToString() });
        view.Dispose();
        rows.Add(new { label = "resource/admitted", create = owner.CreateSession(other).Status.ToString(),
            session = owner.Apply(changes).Status.ToString(), memory = owner.ApplyMemory(memory).Status.ToString(),
            revision = owner.TryFind(SessionId, out var after) ? after.Revision : -1,
            memoryRevision = owner.GetStatistics().MemoryRevision, oldRevision = old.Session.Revision,
            oldMemoryRevision = old.MemoryRevision, oldEntries = old.ReadRange(0, 8).Length });
        old.Dispose();
        rows.Add(Recovery(owner, "resource/released"));
        using var current = owner.OpenRead(SessionId);
        rows.Add(new { label = "resource/current", revision = current.Session.Revision,
            memoryRevision = current.MemoryRevision, entries = current.ReadRange(0, 8).Select(x => x.EntryId) });
    }

    private static object Recovery(ILLMContextPolymorphicArray owner, string label)
    {
        var stats = owner.GetStatistics();
        return new { label, reads = stats.RetainedReads, retained = stats.EstimatedRetainedBytes.ToString(),
            view = stats.EstimatedViewBytes.ToString(), revision = owner.TryFind(SessionId, out var session) ? session.Revision : -1 };
    }
    private static string Outcome(Action action)
    {
        try { action(); return "ok"; }
        catch (Exception error) { return Category(error); }
    }
    private static string Category(Exception error) => error switch
    {
        ObjectDisposedException => "Disposed",
        ArgumentOutOfRangeException => "Range",
        ArgumentException => "Argument",
        KeyNotFoundException => "NotFound",
        NotSupportedException => "NotSupported",
        OverflowException => "Overflow",
        OperationCanceledException => "Cancelled",
        InvalidOperationException => "InvalidOperation",
        ApplicationException => "Callback",
        _ => throw new Exception($"Unexpected failure {error.GetType()}: {error.Message}", error)
    };
    private static IEnumerable<object> ThrowOnEnumeration()
    {
        yield return new object();
        throw new Exception("Zero-limit projection was enumerated.");
    }
    private static IEnumerable<LLMSessionContext> FailedSessions()
    {
        yield return Session();
        throw new ApplicationException("enumerator failed");
    }
    private static LLMSessionContext Session() => new(SessionId, UserId, null, 0, SessionStatus.Active,
        ImmutableSortedDictionary<long, ContextSegment>.Empty, ImmutableDictionary<Guid, ConversationAnchor>.Empty);
    private static Guid Id(int value) => new($"00000000-0000-0000-0000-{value:000000000000}");
    private sealed class EpochClock : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => DateTimeOffset.UnixEpoch;
    }
    private sealed record Projection(Guid SessionId, int MaximumResults, Func<IEnumerable<object>> Values) : ILLMContextViewDefinition<object>
    {
        public IEnumerable<object> Evaluate(ILLMContextReadLease read) => Values();
    }
}
