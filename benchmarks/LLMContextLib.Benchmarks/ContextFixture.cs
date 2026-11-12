// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using LLMContextLib;

namespace LLMContextLib.Benchmarks;

public sealed record ContextFixture(string Profile, int Seed, ImmutableArray<LLMSessionContext> Sessions, LLMContextOptions Options)
{
    public static DateTimeOffset Now { get; } = new(2026, 11, 10, 0, 0, 0, TimeSpan.Zero);
    public static Guid Id(int kind, int session, int ordinal) => new(ordinal, (short)session, (short)kind, new byte[8]);
    public static int EstimateTokens(string text) => (text.Length + 3) / 4;

    public static ContextFixture Create(string profile, int? entryCount = null, int? sessionCount = null)
    {
        var (sessions, entries, bytes) = profile switch
        {
            "Interactive" => (1, 256, 512),
            "LongHistory" => (1, 16_384, 1024),
            "MultipleSessions" => (32, 2048, 512),
            "LargeEntries" => (1, 1024, 16_384),
            _ => throw new ArgumentException("Unknown profile.", nameof(profile))
        };
        sessions = sessionCount ?? sessions;
        entries = entryCount ?? entries;
        if (sessions <= 0 || entries < 32) throw new ArgumentOutOfRangeException(nameof(entryCount));
        var options = new LLMContextOptions
        {
            EstimatedResidentByteBudget = 2L * 1024 * 1024 * 1024,
            MaximumEstimatedRetainedBytes = 1024L * 1024 * 1024,
            AdmissionTimeout = TimeSpan.FromSeconds(5),
            TimeProvider = new FixedClock()
        };
        var result = ImmutableArray.CreateBuilder<LLMSessionContext>(sessions);
        var random = new Random(1729);
        for (int s = 0; s < sessions; s++)
        {
            var directory = ImmutableSortedDictionary.CreateBuilder<long, ContextSegment>();
            var anchors = ImmutableDictionary.CreateBuilder<Guid, ConversationAnchor>();
            var segment = ImmutableArray.CreateBuilder<ContextEntry>();
            long segmentBytes = 0, segmentId = 0;
            for (int e = 0; e < entries; e++)
            {
                string prefix = $"entry{s}x{e} topic{e % 17} sample{random.Next(100)} ";
                string text = prefix + string.Concat(Enumerable.Repeat("context ", Math.Max(0, (bytes - prefix.Length) / 8)));
                ContextRole role = e == 0 ? ContextRole.System : (e % 8) switch
                {
                    1 => ContextRole.Assistant,
                    2 => ContextRole.Tool,
                    3 or 6 => ContextRole.Assistant,
                    4 => ContextRole.Internal,
                    _ => ContextRole.User
                };
                ContextContent content = e % 64 == 63 ? new SummaryContent(text, e - 8) : (e % 8) switch
                {
                    1 => new ToolCallContent($"call{s}x{e}", "lookup", $"{{\"query\":\"{text}\"}}"),
                    2 => new ToolResultContent($"call{s}x{e - 1}", $"{{\"result\":\"{text}\"}}", false),
                    _ => new TextContent(text)
                };
                var entry = new ContextEntry(Id(10, s, e), e, role, Now.AddSeconds(e), content);
                long estimate = ContextPolicies.EstimateEntryBytes(entry);
                if (segment.Count > 0 && (segment.Count == options.MaximumEntriesPerSegment ||
                    segmentBytes + estimate > options.MaximumEstimatedBytesPerSegment))
                    Flush();
                segment.Add(entry);
                segmentBytes += estimate;
                if (e % 64 == 0)
                {
                    var anchor = new ConversationAnchor(Id(20, s, e), Id(10, s, e), Id(10, s, Math.Min(e + 3, entries - 1)),
                        $"Topic {e % 17}", $"Conversation passage {e}", [$"topic{e % 17}", "context"],
                        AnchorKind.Topic, 0, null);
                    anchors.Add(anchor.AnchorId, anchor);
                }
            }
            if (segment.Count > 0) Flush();
            result.Add(new(Id(1, s, 0), Id(2, 0, 0), Id(3, 0, s / 2), 0, SessionStatus.Active,
                directory.ToImmutable(), anchors.ToImmutable()));

            void Flush()
            {
                directory.Add(segmentId, new(segmentId, 0, segment.ToImmutable()));
                segmentId++;
                segment.Clear();
                segmentBytes = 0;
            }
        }
        return new(profile, 1729, result.MoveToImmutable(), options);
    }

    private sealed class FixedClock : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => Now;
    }
}

public enum ReplayActionKind { Read, Change, Memory, Retain, CheckRetained, Release }
public sealed record ReplayAction(
    ReplayActionKind Kind, Guid SessionId, long ExpectedRevision = 0,
    ContextReadRequest? Request = null, ImmutableArray<ContextChange> Changes = default,
    MemoryChangeSet? Memory = null, int RetentionId = 0);

/// <summary>
/// Trace generation is outside timing. Stable operation inputs and explicit expected revisions
/// make serial comparisons equivalent; the concurrent driver separately validates variable
/// winners. Neither this generator nor its data uses earlier checkpoint/application workloads.
/// </summary>
public static class ContextTraces
{
    public static ImmutableArray<ReplayAction> Create(ContextFixture fixture, ContextScenario scenario)
    {
        var actions = ImmutableArray.CreateBuilder<ReplayAction>();
        var session = fixture.Sessions[0];
        var entries = ContextPolicies.Entries(session).ToArray();
        long revision = 0;
        void Read(ContextReadRequest request, Guid? id = null) =>
            actions.Add(new(ReplayActionKind.Read, id ?? session.SessionId, Request: request));
        void Change(params ContextChange[] changes) =>
            actions.Add(new(ReplayActionKind.Change, session.SessionId, revision++, Changes: changes.ToImmutableArray()));
        switch (scenario)
        {
            case ContextScenario.ActiveConversation:
                for (int round = 0; round < 8; round++)
                {
                    string call = $"round{round}";
                    Change(new AppendEntries([
                        Draft(round * 4, ContextRole.User, new TextContent($"Question {round}")),
                        Draft(round * 4 + 1, ContextRole.Assistant, new ToolCallContent(call, "lookup", "{}")),
                        Draft(round * 4 + 2, ContextRole.Tool, new ToolResultContent(call, "{}", false)),
                        Draft(round * 4 + 3, ContextRole.Assistant, new TextContent($"Answer {round}"))]));
                    Read(new(ContextReadKind.Model, Limit: 128));
                }
                break;
            case ContextScenario.Navigation:
                var anchors = session.Anchors.Values.OrderBy(anchor => anchor.AnchorId).ToArray();
                foreach (var anchor in new[] { anchors[0], anchors[anchors.Length / 2], anchors[^1] })
                {
                    Read(new(ContextReadKind.Anchor, AnchorId: anchor.AnchorId));
                    long sequence = entries.Single(entry => entry.EntryId == anchor.StartEntryId).Sequence;
                    Read(new(ContextReadKind.Range, Math.Max(0, sequence - 2)));
                }
                Read(new(ContextReadKind.Conversation));
                break;
            case ContextScenario.Search:
                for (int round = 0; round < 4; round++)
                {
                    foreach (string query in new[] { "context", "topic3", "entry0x7", "absentword", "topic 0" })
                        Read(new(ContextReadKind.Search, Query: query));
                    Change(new ReplaceEntry(entries[4].EntryId, new TextContent($"correction{round} context")));
                    Read(new(ContextReadKind.Search, Query: $"correction{round}"));
                }
                break;
            case ContextScenario.Correction:
                Change(new ReplaceEntry(entries[entries.Length / 2].EntryId, new TextContent("point correction")));
                Change(new DeleteEntry(entries[0].EntryId));
                Read(new(ContextReadKind.Anchor, AnchorId: session.Anchors.Values.First(anchor => anchor.StartEntryId == entries[0].EntryId).AnchorId));
                Change(entries.Skip(1).Take(16).Select(entry =>
                    (ContextChange)new ReplaceEntry(entry.EntryId, new TextContent("bounded range correction"))).ToArray());
                Read(new(ContextReadKind.Range, 0, 24));
                break;
            case ContextScenario.Concurrent:
                for (int round = 0; round < 8; round++)
                {
                    Change(new ReplaceEntry(entries[4].EntryId, new TextContent($"serialcontrol{round}")));
                    Read(new(ContextReadKind.Range, 0, 8));
                    Read(new(ContextReadKind.Model, Limit: 128));
                }
                break;
            case ContextScenario.ScopedMemory:
                var anchorId = session.Anchors.Values.First(anchor => anchor.StartEntryId == entries[0].EntryId).AnchorId;
                var source = ImmutableArray.Create(new MemorySource(session.SessionId, anchorId));
                var repo = new ContextMemory(ContextFixture.Id(30, 0, 0), new(RepositoryId: session.RepositoryId),
                    "Repository guideline", 0, MemoryStatus.Confirmed, null, source);
                var local = repo with { MemoryId = ContextFixture.Id(30, 0, 1), Scope = new(SessionId: session.SessionId), Content = "Session constraint" };
                var combined = repo with { MemoryId = ContextFixture.Id(30, 0, 2), Scope = new(session.UserId, session.RepositoryId), Content = "User repository preference" };
                var proposed = repo with { MemoryId = ContextFixture.Id(30, 0, 3), Status = MemoryStatus.Proposed };
                var expired = repo with { MemoryId = ContextFixture.Id(30, 0, 4), ExpiresAt = ContextFixture.Now.AddSeconds(-1) };
                actions.Add(new(ReplayActionKind.Memory, session.SessionId, Memory: new(0, [repo, local, combined, proposed, expired], [])));
                Read(new(ContextReadKind.Memory, Scopes: [repo.Scope, local.Scope, combined.Scope]));
                if (fixture.Sessions.Length > 1)
                    Read(new(ContextReadKind.Memory, Scopes: [repo.Scope]), fixture.Sessions[1].SessionId);
                if (fixture.Sessions.Length > 2)
                    Read(new(ContextReadKind.Memory, Scopes: [new(RepositoryId: fixture.Sessions[2].RepositoryId)]),
                        fixture.Sessions[2].SessionId);
                actions.Add(new(ReplayActionKind.Memory, session.SessionId, Memory: new(1, [repo with { Status = MemoryStatus.Superseded }], [])));
                Read(new(ContextReadKind.Memory, Scopes: [repo.Scope, local.Scope, combined.Scope]));
                actions.Add(new(ReplayActionKind.Memory, session.SessionId, Memory: new(2, [proposed with { Status = MemoryStatus.Confirmed }], [])));
                actions.Add(new(ReplayActionKind.Memory, session.SessionId, Memory: new(3, [local with { Status = MemoryStatus.Retracted }], [])));
                Read(new(ContextReadKind.Model, Limit: 128, Scopes: [repo.Scope, local.Scope, combined.Scope]));
                break;
            case ContextScenario.Retention:
                for (int step = 0; step < 8; step++)
                {
                    actions.Add(new(ReplayActionKind.Retain, session.SessionId, RetentionId: step));
                    Change(new ReplaceEntry(entries[0].EntryId, new TextContent($"retention{step}")));
                    actions.Add(new(ReplayActionKind.CheckRetained, session.SessionId, RetentionId: step));
                }
                for (int step = 0; step < 8; step++) actions.Add(new(ReplayActionKind.Release, session.SessionId, RetentionId: step));
                Change(new SetSessionStatus(SessionStatus.Suspended));
                Read(new(ContextReadKind.Range));
                Change(new SetSessionStatus(SessionStatus.Closed));
                Change(new SetSessionStatus(SessionStatus.Active));
                Change(new SetSessionStatus(SessionStatus.Expired));
                break;
        }
        return actions.ToImmutable();

        static ContextEntryDraft Draft(int index, ContextRole role, ContextContent content) =>
            new(ContextFixture.Id(11, 0, index), role, ContextFixture.Now.AddHours(1).AddSeconds(index), content);
    }
}
