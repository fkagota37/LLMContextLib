// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using LLMContextLib.Benchmarks;
using Xunit;

namespace LLMContextLib.Tests;

public sealed class ViewAndReplayTests
{
    private static ILLMContextPolymorphicArray Create(LLMSessionContext session, LLMContextOptions? options = null) =>
        LLMContextFactory.Create(options).Initialize([session]);

    [Theory]
    [InlineData(0, 10, 0)]
    [InlineData(1, 10, 0)]
    [InlineData(2, 1, 0)]
    [InlineData(2, 2, 2)]
    public void ModelBudgetAndItemLimitNeverSplitToolPairs(int budget, int limit, int expected)
    {
        var entries = new[]
        {
            new ContextEntry(ContextTests.Id(1), 0, ContextRole.Assistant, ContextFixture.Now, new ToolCallContent("call", "lookup", "{}")),
            new ContextEntry(ContextTests.Id(2), 1, ContextRole.Tool, ContextFixture.Now, new ToolResultContent("call", "{}", false))
        };
        var session = ContextTests.Session() with
        {
            Segments = ImmutableSortedDictionary<long, ContextSegment>.Empty.Add(0, new(0, 0, entries.ToImmutableArray()))
        };
        using var owner = Create(session);
        using var model = owner.OpenView(ContextViews.Model(session.SessionId, budget, _ => 1, limit: limit));
        Assert.Equal(expected, model.Count);
        Assert.Equal(entries.Take(expected).Select(entry => entry.EntryId), model.Select(item => item.EntryId!.Value));
    }

    [Fact]
    public void ReplayedToolIdsDoNotAttachOneResultToMultipleCalls()
    {
        var entries = Enumerable.Range(0, 4).Select(index => new ContextEntry(
            ContextTests.Id(index + 1), index, index % 2 == 0 ? ContextRole.Assistant : ContextRole.Tool,
            ContextFixture.Now, index % 2 == 0 ? new ToolCallContent("reused", "lookup", "{}") :
                new ToolResultContent("reused", "{}", false))).ToImmutableArray();
        var session = ContextTests.Session() with
        {
            Segments = ImmutableSortedDictionary<long, ContextSegment>.Empty.Add(0, new(0, 0, entries))
        };
        using var owner = Create(session);
        using var model = owner.OpenView(ContextViews.Model(session.SessionId, 100, _ => 1));
        Assert.Equal(entries.Skip(2).Select(entry => entry.EntryId), model.Select(item => item.EntryId!.Value));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void ToolContentMustHaveItsCorrespondingRole(bool call)
    {
        var session = ContextTests.Session();
        using var owner = Create(session);
        ContextContent content = call ? new ToolCallContent("call", "lookup", "{}") : new ToolResultContent("call", "{}", false);
        Assert.Equal(ContextMutationStatus.InvalidOperation, owner.Apply(new(session.SessionId, 0,
            [new ReplaceEntry(session.Segments[0].Entries[0].EntryId, content)])).Status);
    }

    [Fact]
    public void ReEvaluatingViewRefreshesWithoutMutatingPriorViewAndDisposalReleasesOutputCharge()
    {
        var session = ContextTests.Session();
        using var owner = Create(session);
        var definition = ContextViews.Project(session.SessionId, _ => true, entry => ContextPolicies.Text(entry.Content), 1);
        using var original = owner.OpenView(definition);
        Assert.True(owner.GetStatistics().EstimatedViewBytes > 0);
        Assert.Equal(ContextMutationStatus.Applied, owner.Apply(new(session.SessionId, 0,
            [new ReplaceEntry(ContextTests.Id(1000), new TextContent("new view content"))])).Status);
        using (var refreshed = owner.OpenView(definition))
        {
            Assert.Equal(0, original.SessionRevision);
            Assert.Equal(1, refreshed.SessionRevision);
            Assert.Equal("message topic0", original[0]);
            Assert.Equal("new view content", refreshed[0]);
        }
        original.Dispose();
        Assert.Equal(0, owner.GetStatistics().EstimatedViewBytes);
        Assert.Equal(0, owner.GetStatistics().RetainedReads);
        Assert.Throws<ObjectDisposedException>(() => original[0]);
    }

    [Fact]
    public void OversizedProjectionAdmissionAndBadEstimatorDoNotLeakLeaseAccounting()
    {
        var session = ContextTests.Session();
        using var owner = Create(session, new() { ProjectionSizeEstimator = _ => 128 * 1024 * 1024 });
        Assert.Throws<InvalidOperationException>(() => owner.OpenView(ContextViews.Timeline(session.SessionId, limit: 1)));
        Assert.Equal(0, owner.GetStatistics().RetainedReads);
        Assert.Equal(0, owner.GetStatistics().EstimatedViewBytes);
        using var invalid = Create(session, new() { ProjectionSizeEstimator = _ => -1 });
        Assert.Throws<ArgumentException>(() => invalid.OpenView(ContextViews.Timeline(session.SessionId, limit: 1)));
        Assert.Equal(0, invalid.GetStatistics().RetainedReads);
    }

    [Fact]
    public void DeletedEntryIdentityCannotBeReusedToRedirectOldBookmark()
    {
        var session = ContextTests.Session();
        using var owner = Create(session);
        var entry = session.Segments[0].Entries[0];
        var anchor = new ConversationAnchor(ContextTests.Id(90), entry.EntryId, entry.EntryId,
            "Original passage", "Original passage", [], AnchorKind.Manual, 0, null);
        Assert.Equal(ContextMutationStatus.Applied, owner.Apply(new(session.SessionId, 0, [new PutAnchor(anchor)])).Status);
        Assert.Equal(ContextMutationStatus.Applied, owner.Apply(new(session.SessionId, 1, [new DeleteEntry(entry.EntryId)])).Status);
        Assert.Equal(ContextMutationStatus.InvalidOperation, owner.Apply(new(session.SessionId, 2,
            [new AppendEntries([new(entry.EntryId, ContextRole.User, ContextFixture.Now, new TextContent("different content"))])])).Status);
        using var read = owner.OpenRead(session.SessionId);
        Assert.Equal(AnchorTargetStatus.Missing, read.ResolveAnchor(anchor.AnchorId).Status);
    }

    [Fact]
    public void RemovedSessionIdentityCannotRedirectRetainedContextOrProvenance()
    {
        var session = ContextTests.Session();
        using var owner = Create(session);
        using var retained = owner.OpenRead(session.SessionId);
        Assert.Equal(ContextMutationStatus.Applied, owner.RemoveSession(session.SessionId, 0).Status);
        Assert.False(owner.TryFind(session.SessionId, out _));
        Assert.Equal(ContextMutationStatus.InvalidOperation, owner.CreateSession(session).Status);
        Assert.Equal(4, retained.ReadRange(0, 10).Length);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void PointAndBatchCorrectionDoNotReinspectUnchangedPayloadsInTheirSegment(bool batch)
    {
        var fixture = ContextFixture.Create("Interactive");
        var session = fixture.Sessions[0];
        var target = session.Segments[0].Entries[4];
        var second = session.Segments[0].Entries[5];
        bool admitted = false;
        using var owner = Create(session, fixture.Options with
        {
            EntrySizeEstimator = entry =>
            {
                if (admitted && entry.EntryId != target.EntryId && (!batch || entry.EntryId != second.EntryId))
                    throw new InvalidOperationException("Unchanged payload was re-inspected.");
                return ContextPolicies.EstimateEntryBytes(entry);
            }
        });
        admitted = true;
        ImmutableArray<ContextChange> changes = batch
            ? [new ReplaceEntry(target.EntryId, new TextContent("narrow point correction")),
                new ReplaceEntry(second.EntryId, new TextContent("second correction"))]
            : [new ReplaceEntry(target.EntryId, new TextContent("narrow point correction"))];
        Assert.Equal(ContextMutationStatus.Applied, owner.Apply(new(session.SessionId, 0,
            changes)).Status);
        using var read = owner.OpenRead(session.SessionId);
        Assert.Single(read.Search("narrow", 10));
        Assert.Single(read.Search("entry0x7", 10));
    }

    [Fact]
    public void ScopedMemoryScenarioExcludesAnotherRepository()
    {
        var fixture = ContextFixture.Create("Interactive", entryCount: 32, sessionCount: 3);
        ReplayChecks.Verify(fixture, ContextTraces.Create(fixture, ContextScenario.ScopedMemory));
    }

    [Fact]
    public async Task DisposalDrainsActiveProjectionWhileIssuedViewRemainsReadable()
    {
        var session = ContextTests.Session();
        var owner = Create(session);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        var definition = ContextViews.Project(session.SessionId, _ => true, entry =>
        {
            entered.TrySetResult();
            release.Wait();
            return entry.EntryId;
        }, 1);
        var projection = Task.Run(() => owner.OpenView(definition));
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var disposal = Task.Run(owner.Dispose);
        try { Assert.False(disposal.IsCompleted); }
        finally { release.Set(); }
        using var view = await projection;
        await disposal;
        Assert.Equal(0, view.SessionRevision);
        Assert.Equal(session.Segments[0].Entries[0].EntryId, view[0]);
    }

    [Theory]
    [InlineData(ContextScenario.ActiveConversation)]
    [InlineData(ContextScenario.Navigation)]
    [InlineData(ContextScenario.Search)]
    [InlineData(ContextScenario.Correction)]
    [InlineData(ContextScenario.Concurrent)]
    [InlineData(ContextScenario.ScopedMemory)]
    [InlineData(ContextScenario.Retention)]
    public void EveryFreshBenchmarkParticipantMatchesIndependentOracle(ContextScenario scenario)
    {
        var fixture = ContextFixture.Create("Interactive", entryCount: 64, sessionCount: 2);
        ReplayChecks.Verify(fixture, ContextTraces.Create(fixture, scenario));
    }

    [Theory]
    [InlineData(ParticipantKind.ConventionalScan)]
    [InlineData(ParticipantKind.ConventionalIndexed)]
    [InlineData(ParticipantKind.LLMPolymorphic)]
    public async Task ConcurrentBenchmarkChecksAcceptedHistoryAndRecordsAllRequests(ParticipantKind kind)
    {
        var result = await ConcurrentReplay.Run(kind, false, readers: 2, writers: 2, operationsPerWorker: 8);
        Assert.Equal(32, result.Requests.Length);
        Assert.Equal(result.Attempts, result.Commits + result.Conflicts + result.Rejections);
        Assert.NotEmpty(result.Memory);
        Assert.All(result.Requests, request => Assert.True(request.EndToEndMs >= request.ServiceMs));
        Assert.Equal(result.Requests.Length, result.Latencies.Sum(summary => summary.Samples));
        Assert.All(result.Latencies, summary =>
        {
            var requests = result.Requests.Where(request =>
                request.Category == summary.Category && request.Status == summary.Status).ToArray();
            var service = requests.Select(request => request.ServiceMs).Order().ToArray();
            var total = requests.Select(request => request.EndToEndMs).Order().ToArray();
            Assert.Equal(requests.Length, summary.Samples);
            Assert.Equal(service[(int)Math.Ceiling(service.Length * .50) - 1], summary.ServiceP50Ms);
            Assert.Equal(service[(int)Math.Ceiling(service.Length * .95) - 1], summary.ServiceP95Ms);
            Assert.Equal(service[(int)Math.Ceiling(service.Length * .99) - 1], summary.ServiceP99Ms);
            Assert.Equal(total[(int)Math.Ceiling(total.Length * .99) - 1], summary.EndToEndP99Ms);
        });
        Assert.Equal((16 + result.Commits) * 1000d / result.ElapsedMs, result.SuccessfulRequestsPerSecond);
    }
}
