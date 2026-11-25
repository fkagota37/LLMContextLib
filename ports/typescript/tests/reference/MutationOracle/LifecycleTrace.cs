// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using System.Reflection;
using System.Text.Json;
using LLMContextLib;

internal static class LifecycleTrace
{
    internal static async Task Run()
    {
        var rows = new List<object>();
        Guid sessionId = Id(1), entryId = Id(3);
        foreach (bool fail in new[] { false, true })
        {
            using var entered = new ManualResetEventSlim();
            using var release = new ManualResetEventSlim();
            bool inject = fail;
            var options = LLMContextOptions.WriteOptimized with { };
            Hook(options, "BeforePartitionSynchronization", token =>
            {
                entered.Set();
                release.Wait(token);
                if (inject) throw new ApplicationException("injected synchronization failure");
            });
            using var owner = LLMContextFactory.Create(options).Initialize([Session(true)]);
            var mutation = owner.Apply(new(sessionId, 0,
                [new ReplaceEntry(entryId, new TextContent("working")) { IndexKeys = new(["working"]) }]));
            using var old = owner.OpenRead(sessionId);
            using var cancel = new CancellationTokenSource();
            var waiting = owner.SynchronizeIndexAsync(sessionId, cancel.Token);
            if (!entered.Wait(TimeSpan.FromSeconds(5))) throw new Exception("Synchronization did not start.");
            var durable = owner.SynchronizeIndexAsync(sessionId);
            cancel.Cancel();
            string cancelled;
            try { await waiting; cancelled = "ok"; }
            catch (OperationCanceledException) { cancelled = "Cancelled"; }
            var blocked = owner.Apply(new(sessionId, 1, [new SetSessionStatus(SessionStatus.Active)]));
            release.Set();
            var completed = await durable;
            rows.Add(new { label = $"synchronization/{fail}", applied = mutation.Status.ToString(), cancelled,
                blocked = blocked.Status.ToString(), completed.Generation, completed.ContentRevision,
                completed.PartitionsCompacted, completed.Succeeded, hasError = completed.Error is not null,
                oldGeneration = old.IndexStatus.IndexGeneration, oldHits = old.SearchKeys(new(["working"]), 1).Select(x => x.EntryId),
                pending = owner.GetStatistics().PendingSynchronizations,
                preparation = owner.GetStatistics().EstimatedPreparationBytes.ToString() });
            inject = false;
            var followOn = owner.Apply(new(sessionId, 1, [new SetSessionStatus(SessionStatus.Active)]));
            var recovered = await owner.SynchronizeIndexAsync(sessionId);
            using var current = owner.OpenRead(sessionId);
            rows.Add(new { label = $"synchronization/recovery/{fail}", status = followOn.Status.ToString(),
                recovered.Generation, recovered.ContentRevision, recovered.PartitionsCompacted, recovered.Succeeded,
                revision = current.Session.Revision, indexGeneration = current.IndexStatus.IndexGeneration,
                hits = current.SearchKeys(new(["working"]), 1).Select(x => x.EntryId),
                pending = owner.GetStatistics().PendingSynchronizations });
        }
        foreach (string provider in new[] { "Native", "LuceneRangeBuffer", "LuceneCharTerm" })
        {
            foreach (bool memo in new[] { false, true })
            {
                var options = new LLMContextOptions { DeferredIndexing = new() { ForegroundWords = 1 } };
                var builder = LLMContextFactory.Create(options).WithExecutionStrategies(new());
                if (provider != "Native") builder = builder.WithLuceneTermCollection(
                    provider == "LuceneRangeBuffer" ? LuceneTermCollection.RangeBuffer : LuceneTermCollection.CharTerm);
                if (memo) builder = builder.WithBitFasterTermMemoization();
                using var owner = builder.Initialize([Session(false)]);
                await owner.WaitForIndexingAsync(sessionId, 0);
                using var old = owner.OpenRead(sessionId);
                var replace = owner.Apply(new(sessionId, 0, [new ReplaceEntry(entryId, new TextContent("changed suffix"))]));
                await owner.WaitForIndexingAsync(sessionId, 1);
                using var current = owner.OpenRead(sessionId);
                var stats = owner.GetStatistics();
                owner.RemoveSession(sessionId, 1);
                owner.Dispose();
                rows.Add(new { label = $"shutdown/{provider}/{memo}", status = replace.Status.ToString(),
                    oldRevision = old.Session.Revision, currentRevision = current.Session.Revision,
                    oldHits = old.Search("base", 1).Select(x => x.EntryId),
                    currentHits = current.SearchIndexed("changed", 1).Hits.Select(x => x.EntryId),
                    stats.PendingIndexWork, work = stats.EstimatedIndexWorkBytes.ToString(),
                    collector = stats.Execution!.TermCollector, termMemo = stats.Execution.TermMemo,
                    memoEntries = stats.Execution.MemoEntries });
            }
        }
        // The internal hook holds actual supported deferred work until owner cancellation.
        foreach (string provider in new[] { "Native", "LuceneRangeBuffer", "LuceneCharTerm" })
        {
            using var entered = new ManualResetEventSlim();
            bool stoppedBeforeReturn = false;
            var options = new LLMContextOptions { DeferredIndexing = new() { ForegroundWords = 1 } };
            Hook(options, "BeforeDeferredIndexing", token =>
            {
                entered.Set();
                try { token.WaitHandle.WaitOne(); token.ThrowIfCancellationRequested(); }
                finally { stoppedBeforeReturn = true; }
            });
            var builder = LLMContextFactory.Create(options).WithExecutionStrategies(new()).WithBitFasterTermMemoization();
            if (provider != "Native") builder = builder.WithLuceneTermCollection(
                provider == "LuceneRangeBuffer" ? LuceneTermCollection.RangeBuffer : LuceneTermCollection.CharTerm);
            using var owner = builder.Initialize([Session(false)]);
            if (!entered.Wait(TimeSpan.FromSeconds(5))) throw new Exception("Deferred worker did not start.");
            using var old = owner.OpenRead(sessionId);
            var waiting = owner.WaitForIndexingAsync(sessionId, 0);
            owner.Dispose();
            string outcome;
            try { await waiting; outcome = "ok"; }
            catch (ObjectDisposedException) { outcome = "Disposed"; }
            rows.Add(new { label = $"shutdown/pending/{provider}", outcome, stoppedBeforeReturn,
                revision = old.Session.Revision, complete = old.IndexStatus.IsComplete,
                exact = old.Search("suffix", 1).Select(x => x.EntryId),
                indexed = old.SearchIndexed("suffix", 1).Hits.Select(x => x.EntryId) });
        }
        Console.WriteLine(JsonSerializer.Serialize(new { reference = "479d2612315cbd292da917bae6d8d3fec35fea24", rows }));
    }

    private static void Hook(LLMContextOptions options, string name, Action<CancellationToken> callback) =>
        typeof(LLMContextOptions).GetProperty(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(options, callback);
    private static LLMSessionContext Session(bool keys) => new(Id(1), Id(2), null, 0, SessionStatus.Active,
        ImmutableSortedDictionary<long, ContextSegment>.Empty.Add(0, new(0, 0,
            [new ContextEntry(Id(3), 0, ContextRole.User, DateTimeOffset.UnixEpoch, new TextContent("base suffix"))
            { IndexKeys = keys ? new(["base"]) : null }])), ImmutableDictionary<Guid, ConversationAnchor>.Empty);
    private static Guid Id(int value) => new($"00000000-0000-0000-0000-{value:000000000000}");
}
