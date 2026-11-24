// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using System.Text.Json;
using LLMContextLib;

internal static class ViewTrace
{
    private static Guid Id(int value) => Guid.Parse($"00000000-0000-0000-0000-{value:000000000000}");

    internal static void Run()
    {
        var rows = new List<object>();
        var contents = new ContextContent[] { new TextContent("system"), new TextContent("hello build"),
            new ToolCallContent("call", "build", "{}"), new ToolResultContent("call", "{\"ok\":true}", false),
            new SummaryContent("summary", 1), new TextContent("assistant build"), new TextContent("internal") };
        ContextRole[] roles = [ContextRole.System, ContextRole.User, ContextRole.Assistant, ContextRole.Tool,
            ContextRole.Internal, ContextRole.Assistant, ContextRole.Internal];
        var entries = contents.Select((content, index) => new ContextEntry(Id(index + 10), index, roles[index],
            DateTimeOffset.UnixEpoch, content)).ToImmutableArray();
        var anchor = new ConversationAnchor(Id(50), Id(11), Id(15), "build anchor", "build summary", ["build"],
            AnchorKind.Manual, 0, null);
        var session = new LLMSessionContext(Id(1), Id(2), null, 0, SessionStatus.Active,
            ImmutableSortedDictionary<long, ContextSegment>.Empty.Add(0, new(0, 0, entries)),
            ImmutableDictionary<Guid, ConversationAnchor>.Empty.Add(anchor.AnchorId, anchor));
        using var owner = LLMContextFactory.Create().Initialize([session]);
        var memory = owner.ApplyMemory(new(0, [new(Id(60), new(UserId: Id(2)), "memory", 0,
            MemoryStatus.Confirmed, null, [new(Id(1), Id(50))])], []));
        if (memory.Status != ContextMutationStatus.Applied) throw new Exception(memory.Error);
        void Observe<T>(string label, ILLMContextViewDefinition<T> definition)
        {
            using var view = owner.OpenView(definition);
            rows.Add(new { label, maximum = definition.MaximumResults, revision = view.SessionRevision,
                values = Enumerable.Range(0, view.Count).Select(index => Format(view[index]!)).ToArray() });
        }
        void Check(string label, Action action)
        {
            string outcome;
            try { action(); outcome = "ok"; }
            catch (Exception error) { outcome = error switch {
                ArgumentOutOfRangeException => "Range", ArgumentException => "Argument", ObjectDisposedException => "Disposed",
                ApplicationException => "Callback", _ => throw new Exception(label, error) }; }
            var stats = owner.GetStatistics();
            rows.Add(new { label, outcome, reads = stats.RetainedReads, view = stats.EstimatedViewBytes.ToString() });
        }
        Observe("timeline/default", ContextViews.Timeline(Id(1)));
        Observe("timeline/from", ContextViews.Timeline(Id(1), 3, 2));
        Observe("conversation/default", ContextViews.Conversation(Id(1)));
        Observe("tool/default", ContextViews.Tool(Id(1), "call"));
        Observe("tool/truncated", ContextViews.Tool(Id(1), "call", 1));
        Observe("navigation/default", ContextViews.Navigation(Id(1)));
        Observe("search/default", ContextViews.Search(Id(1), "build"));
        Observe("keys/default", ContextViews.SearchKeys(Id(1), new ContextIndexKeys(["build"])));
        Observe("memory/default", ContextViews.Memory(Id(1), [new(UserId: Id(2))]));
        Observe("memory/empty", ContextViews.Memory(Id(1), []));
        Observe("model/default", ContextViews.Model(Id(1), 100, _ => 1));
        Observe("model/memory", ContextViews.Model(Id(1), 100, _ => 1, [new(UserId: Id(2))]));
        Observe("model/pair-limit", ContextViews.Model(Id(1), 100, _ => 1, limit: 3));
        Observe("model/budget", ContextViews.Model(Id(1), 3, _ => 1));
        Observe("project/default", ContextViews.Project(Id(1), entry => entry.Role == ContextRole.Assistant,
            entry => $"{entry.Sequence}/{ContextPolicies.Text(entry.Content)}"));
        Check("project/null-predicate", () => ContextViews.Project<string>(Id(1), null!, _ => ""));
        Check("project/null-projection", () => ContextViews.Project<string>(Id(1), _ => true, null!));
        Check("project/callback", () => owner.OpenView(ContextViews.Project<string>(Id(1), _ => throw new ApplicationException(), _ => "")));
        Check("model/null-estimator", () => owner.OpenView(ContextViews.Model(Id(1), 1, null!)));
        Check("model/negative-estimator", () => owner.OpenView(ContextViews.Model(Id(1), 1, _ => -1)));
        Check("model/negative-budget", () => owner.OpenView(ContextViews.Model(Id(1), -1, _ => 1)));
        Check("memory/default-array", () => owner.OpenView(ContextViews.Memory(Id(1), default)));
        foreach (int limit in new[] { -1, 0, 1, 4097 })
        {
            Check($"timeline/limit/{limit}", () => owner.OpenView(ContextViews.Timeline(Id(1), limit: limit)).Dispose());
            Check($"model/limit/{limit}", () => owner.OpenView(ContextViews.Model(Id(1), 10, _ => 1, limit: limit)).Dispose());
        }
        var disposed = owner.OpenView(ContextViews.Conversation(Id(1)));
        disposed.Dispose();
        Check("disposed/view/index", () => _ = disposed[0]);
        Check("disposed/view/negative-index", () => _ = disposed[-1]);
        Check("disposed/view/count", () => _ = disposed.Count);
        Check("disposed/view/session-revision", () => _ = disposed.SessionRevision);
        Check("disposed/view/memory-revision", () => _ = disposed.MemoryRevision);
        Check("disposed/view/enumeration", () => disposed.ToArray());
        var disposedRead = owner.OpenRead(Id(1));
        disposedRead.Dispose();
        Check("disposed/read/range", () => disposedRead.ReadRange(-1, -1));
        Check("disposed/read/page", () => disposedRead.ReadPage(null, 0));
        Check("disposed/read/text", () => disposedRead.Search(null!, -1));
        Check("disposed/read/indexed", () => disposedRead.SearchIndexed(null!, -1));
        Check("disposed/read/null-keys", () => disposedRead.SearchKeys(null!, -1));
        Check("disposed/read/keys", () => disposedRead.SearchKeys(ContextIndexKeys.Empty, -1));
        Check("disposed/read/memory", () => disposedRead.GetApplicableMemory(default));
        var recipe = ContextViews.Conversation(Id(1));
        using var old = owner.OpenView(recipe);
        rows.Add(new { label = "reopen/mutation", status = owner.Apply(new(Id(1), 0,
            [new ReplaceEntry(Id(11), new TextContent("changed"))])).Status.ToString() });
        Observe("reopen/current", recipe);
        owner.RemoveSession(Id(1), 1);
        owner.Dispose();
        rows.Add(new { label = "reopen/retained", revision = old.SessionRevision,
            values = Enumerable.Range(0, old.Count).Select(index => Format(old[index])).ToArray() });
        Console.WriteLine(JsonSerializer.Serialize(new { reference = "479d2612315cbd292da917bae6d8d3fec35fea24", rows }));
    }

    private static string Format(object value) => value switch
    {
        ContextEntry item => $"entry/{item.Sequence}/{item.EntryId}/{item.Role}/{ContextPolicies.Text(item.Content)}",
        ContextSearchHit item => $"hit/{item.EntryId}/{item.AnchorId}/{item.Sequence}/{item.SessionRevision}/{item.Snippet}",
        AnchorResolution item => $"anchor/{item.Anchor.AnchorId}/{item.Status}/{item.Start?.EntryId}/{item.End?.EntryId}/{item.SessionRevision}",
        ContextMemory item => $"memory/{item.MemoryId}/{item.Content}/{item.Revision}/{item.Status}",
        ModelContextItem item => $"model/{item.EntryId}/{item.MemoryId}/{item.Role}/{item.Text}",
        string item => item,
        _ => throw new Exception("Unexpected view item.")
    };
}
