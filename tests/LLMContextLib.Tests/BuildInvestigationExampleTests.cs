// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using System.Text.Json;
using LLMContextLib.Examples.BuildInvestigation;
using Xunit;

namespace LLMContextLib.Tests;

public sealed class BuildInvestigationExampleTests
{
    [Fact]
    public void CompleteExampleSharesContextAndReusesConfigurationWithoutNewModelCalls()
    {
        using var example = new BuildInvestigationAssistant(TextWriter.Null);
        var result = example.RunDemonstration();

        Assert.True(result.ReusedConfiguration);
        Assert.Equal(5, result.InvestigationRevision);
        Assert.Equal(1, result.FollowupRevision);
        Assert.Equal(1, result.MemoryRevision);
        Assert.Equal(2, result.InvestigationMemories);
        Assert.Equal(1, result.FollowupMemories);
        Assert.Equal(3, result.ModelAdapterInvocations);
        Assert.Equal(3, result.SimulatedBuildRuns);
        Assert.Equal(0, result.DirectUiModelAdapterInvocations);
        Assert.Equal(0, result.FollowupModelAdapterInvocations);
    }

    [Fact]
    public void CompletedRunPublishesItsPairAtomicallyAndDoesNotRerunAfterConflict()
    {
        var session = NewSession(Guid.NewGuid(), Guid.NewGuid());
        using var owner = LLMContextFactory.Create().Initialize([session]);
        var profiler = new InterleavingProfiler();
        var runner = new BuildRunnerWorker(owner, profiler);
        var settings = new BuildSettings("build-profiler", "example-v1", "example-build", 4);
        var recorded = runner.RunAndRecord(session.SessionId, settings);
        using (var read = owner.OpenRead(session.SessionId))
        {
            var entries = read.ReadRange(0, 8);
            Assert.Equal(1, recorded.PublishedSessionRevision);
            Assert.Equal(2, entries.Length);
            Assert.Equal(recorded.CallEntryId, entries[0].EntryId);
            Assert.Equal(recorded.ResultEntryId, entries[1].EntryId);
            var call = Assert.IsType<ToolCallContent>(entries[0].Content);
            var result = Assert.IsType<ToolResultContent>(entries[1].Content);
            Assert.Equal(call.CallId, result.CallId);
            Assert.Equal(recorded.Observation, JsonSerializer.Deserialize<BuildObservation>(result.ResultJson));
        }

        profiler.BeforeReturn = () =>
        {
            using var read = owner.OpenRead(session.SessionId);
            var change = new ContextChangeSet(session.SessionId, read.Session.Revision,
                [new AppendEntries([new ContextEntryDraft(Guid.NewGuid(), ContextRole.User,
                    DateTimeOffset.UtcNow, new TextContent("Another worker advanced the session."))])]);
            Publication.EnsureApplied(owner.Apply(change), "Competing writer");
        };
        var conflict = Assert.Throws<InvalidOperationException>(() => runner.RunAndRecord(session.SessionId, settings));
        Assert.Contains(nameof(ContextMutationStatus.RevisionConflict), conflict.Message);
        using var final = owner.OpenRead(session.SessionId);
        Assert.Equal(2, final.Session.Revision);
        Assert.Equal(3, final.ReadRange(0, 8).Length);
        Assert.Equal(2, profiler.Runs);
    }

    [Theory]
    [InlineData("example-v1", "example-build", true)]
    [InlineData("different-version", "example-build", false)]
    [InlineData("example-v1", "other-workload", false)]
    public void ConfigurationLookupChecksCompatibilityWithoutInvokingModel(
        string version, string workload, bool expectedHit)
    {
        var user = Guid.NewGuid();
        var repository = Guid.NewGuid();
        var first = NewSession(user, repository);
        var second = NewSession(user, repository);
        using var owner = LLMContextFactory.Create().Initialize([first, second]);
        var model = new ScriptedReasoningModel();
        var runner = new BuildRunnerWorker(owner, new SimulatedBuildProfiler());
        var outcome = new InvestigationCoordinator(owner, runner, model)
            .Investigate(first.SessionId, "example-v1", "example-build");
        new KnowledgeWorker(owner).PublishApproved(first.SessionId, outcome);

        Assert.Equal(expectedHit, runner.TryGetReusableSettings(second.SessionId, version, workload, out var settings));
        if (expectedHit) Assert.Equal(outcome.RecommendedSettings, settings);
        else Assert.Null(settings);
        Assert.Equal(2, model.InvocationCount);
    }

    [Fact]
    public void LaterSourceEditMakesConfigurationIneligibleUnderConservativePolicy()
    {
        var session = NewSession(Guid.NewGuid(), Guid.NewGuid());
        using var owner = LLMContextFactory.Create().Initialize([session]);
        var model = new ScriptedReasoningModel();
        var runner = new BuildRunnerWorker(owner, new SimulatedBuildProfiler());
        var outcome = new InvestigationCoordinator(owner, runner, model)
            .Investigate(session.SessionId, "example-v1", "example-build");
        new KnowledgeWorker(owner).PublishApproved(session.SessionId, outcome);
        Assert.True(runner.TryGetReusableSettings(session.SessionId, "example-v1", "example-build", out _));

        var laterChange = new ContextChangeSet(session.SessionId, outcome.PublishedSessionRevision,
            [new AppendEntries([new ContextEntryDraft(Guid.NewGuid(), ContextRole.User,
                DateTimeOffset.UtcNow, new TextContent("A later update."))])]);
        Publication.EnsureApplied(owner.Apply(laterChange), "Advance source");

        Assert.False(runner.TryGetReusableSettings(session.SessionId, "example-v1", "example-build", out _));
        Assert.Equal(2, model.InvocationCount);
    }

    [Fact]
    public void ToolAdapterSelectsScopesAndFollowsReturnedSourceIds()
    {
        var user = Guid.NewGuid();
        var repository = Guid.NewGuid();
        var first = NewSession(user, repository);
        var second = NewSession(user, repository);
        using var owner = LLMContextFactory.Create().Initialize([first, second]);
        var runner = new BuildRunnerWorker(owner, new SimulatedBuildProfiler());
        var outcome = new InvestigationCoordinator(owner, runner, new ScriptedReasoningModel())
            .Investigate(first.SessionId, "example-v1", "example-build");
        new KnowledgeWorker(owner).PublishApproved(first.SessionId, outcome);
        var tools = new ContextToolAdapter(owner, first.SessionId, second.SessionId);

        JsonElement View(Guid sessionId, string memoryScope)
        {
            using var reply = JsonDocument.Parse(tools.Execute("context_view",
                JsonSerializer.SerializeToElement(new { sessionId, view = "memory", memoryScope, limit = 8 })));
            return reply.RootElement.Clone();
        }

        Assert.Single(View(first.SessionId, "session").GetProperty("items").EnumerateArray());
        Assert.Empty(View(second.SessionId, "session").GetProperty("items").EnumerateArray());
        var shared = View(second.SessionId, "repository").GetProperty("items");
        var source = Assert.Single(shared.EnumerateArray()).GetProperty("sources")[0];
        using var passage = JsonDocument.Parse(tools.Execute("context_read_anchor",
            JsonSerializer.SerializeToElement(new
            {
                sessionId = source.GetProperty("sessionId").GetGuid(),
                anchorId = source.GetProperty("anchorId").GetGuid(),
                limit = 32
            })));
        Assert.Equal("Current", passage.RootElement.GetProperty("status").GetString());
        Assert.Equal(6, passage.RootElement.GetProperty("items").GetArrayLength());

        using var search = JsonDocument.Parse(tools.Execute("context_view",
            JsonSerializer.SerializeToElement(new
            {
                sessionId = first.SessionId,
                view = "search",
                query = "workers",
                limit = 8
            })));
        Assert.Contains(search.RootElement.GetProperty("items").EnumerateArray(),
            item => item.GetProperty("anchorId").ValueKind == JsonValueKind.String &&
                item.GetProperty("anchorId").GetGuid() == outcome.ExperimentAnchorId);
    }

    [Fact]
    public void MemoryToolReleasesMetadataLeaseBeforeOpeningItsView()
    {
        var session = NewSession(Guid.NewGuid(), Guid.NewGuid());
        using var owner = LLMContextFactory.Create(new LLMContextOptions
        {
            MaximumRetainedReads = 1
        }).Initialize([session]);
        var runner = new BuildRunnerWorker(owner, new SimulatedBuildProfiler());
        var outcome = new InvestigationCoordinator(owner, runner, new ScriptedReasoningModel())
            .Investigate(session.SessionId, "example-v1", "example-build");
        new KnowledgeWorker(owner).PublishApproved(session.SessionId, outcome);
        var tools = new ContextToolAdapter(owner, session.SessionId);

        using var reply = JsonDocument.Parse(tools.Execute("context_view",
            JsonSerializer.SerializeToElement(new
            {
                sessionId = session.SessionId,
                view = "memory",
                memoryScope = "sessionAndRepository",
                limit = 8
            })));

        Assert.Equal(2, reply.RootElement.GetProperty("items").GetArrayLength());
        Assert.Equal(0, owner.GetStatistics().RetainedReads);
        Assert.Equal(0, owner.GetStatistics().EstimatedRetainedBytes);
        Assert.Equal(0, owner.GetStatistics().EstimatedViewBytes);
    }

    private static LLMSessionContext NewSession(Guid user, Guid repository) => new(
        Guid.NewGuid(), user, repository, 0, SessionStatus.Active,
        ImmutableSortedDictionary<long, ContextSegment>.Empty,
        ImmutableDictionary<Guid, ConversationAnchor>.Empty);

    private sealed class InterleavingProfiler : IBuildProfiler
    {
        internal Action? BeforeReturn { get; set; }
        internal int Runs { get; private set; }
        public BuildObservation Run(BuildSettings settings)
        {
            Runs++;
            BeforeReturn?.Invoke();
            return new BuildObservation("Completed");
        }
    }
}
