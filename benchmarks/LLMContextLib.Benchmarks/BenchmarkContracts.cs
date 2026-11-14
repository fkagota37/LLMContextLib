// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Collections.Immutable;
using LLMContextLib;

namespace LLMContextLib.Benchmarks;

public enum ParticipantKind { ConventionalScan, ConventionalIndexed, LLMPolymorphic }
public enum ContextScenario { ActiveConversation, Navigation, Search, Correction, Concurrent, ScopedMemory, Retention }
public enum ContextReadKind { Range, Model, Search, Anchor, Memory, Conversation }

public sealed record ContextReadRequest(
    ContextReadKind Kind, long FromSequence = 0, int Limit = 16, string Query = "",
    Guid AnchorId = default, int TokenBudget = 2048, ImmutableArray<MemoryScope> Scopes = default);

/// <summary>
/// Canonical output contains no physical segment layout. This prevents a benchmark from forcing
/// the conventional manager to adopt the proposed realization's representation. All participants
/// materialize the requested result and return both captured revision numbers.
/// </summary>
public sealed record ContextObservation(
    long SessionRevision, long MemoryRevision,
    ImmutableArray<ContextEntry> Entries, ImmutableArray<ContextSearchHit> Hits,
    ImmutableArray<AnchorResolution> Anchors, ImmutableArray<ContextMemory> Memories,
    ImmutableArray<ModelContextItem> Model)
{
    public static ContextObservation Empty(long revision, long memoryRevision) =>
        new(revision, memoryRevision, [], [], [], [], []);
}

public interface IContextRetention : IDisposable
{
    long Revision { get; }
    ContextEntry? FirstEntry { get; }
}

public interface IContextBenchmarkParticipant : IDisposable
{
    long Revision(Guid sessionId);
    ContextObservation Read(Guid sessionId, ContextReadRequest request);
    IContextMutationResult Apply(ContextChangeSet changes);
    IContextMutationResult ApplyMemory(MemoryChangeSet changes);
    IContextRetention Retain(Guid sessionId);
}

public static class BenchmarkParticipants
{
    public static IContextBenchmarkParticipant Create(LLMContextFactoryBuilder builder, ContextFixture fixture) =>
        new PolymorphicContextParticipant(builder.Initialize(fixture.Sessions));

    public static IContextBenchmarkParticipant Create(ParticipantKind kind, ContextFixture fixture) => kind switch
    {
        ParticipantKind.ConventionalScan => new ConventionalContextManager(fixture, indexed: false),
        ParticipantKind.ConventionalIndexed => new ConventionalContextManager(fixture, indexed: true),
        ParticipantKind.LLMPolymorphic => new PolymorphicContextParticipant(fixture),
        _ => throw new ArgumentOutOfRangeException(nameof(kind))
    };

    public static ImmutableArray<MemoryScope> Scopes(ContextReadRequest request) =>
        request.Scopes.IsDefault ? [] : request.Scopes;
}

internal sealed class BenchmarkMutationResult(ContextMutationStatus status, long revision, string? error = null)
    : IContextMutationResult
{
    public ContextMutationStatus Status { get; } = status;
    public long Revision { get; } = revision;
    public string? Error { get; } = error;
    public ImmutableArray<Guid> AppendedEntryIds => [];
}

/// <summary>Adapter for the NEW realization; no previous benchmark adapter participates.</summary>
internal sealed class PolymorphicContextParticipant : IContextBenchmarkParticipant
{
    private readonly ILLMContextPolymorphicArray _client;
    internal LLMContextStatistics Statistics => _client.GetStatistics();
    internal PolymorphicContextParticipant(ContextFixture fixture) => _client =
        LLMContextFactory.Create(fixture.Options).Initialize(fixture.Sessions);
    internal PolymorphicContextParticipant(ILLMContextPolymorphicArray client) => _client = client;

    public long Revision(Guid id) => _client.TryFind(id, out var session) ? session.Revision : throw new KeyNotFoundException();
    public IContextMutationResult Apply(ContextChangeSet changes) => _client.Apply(changes);
    public IContextMutationResult ApplyMemory(MemoryChangeSet changes) => _client.ApplyMemory(changes);
    public ContextObservation Read(Guid id, ContextReadRequest request)
    {
        using var read = _client.OpenRead(id);
        var result = ContextObservation.Empty(read.Session.Revision, read.MemoryRevision);
        return request.Kind switch
        {
            ContextReadKind.Range => result with { Entries = read.ReadRange(request.FromSequence, request.Limit) },
            ContextReadKind.Search => result with { Hits = read.Search(request.Query, request.Limit) },
            ContextReadKind.Anchor => result with { Anchors = [read.ResolveAnchor(request.AnchorId)] },
            ContextReadKind.Memory => result with { Memories = read.GetApplicableMemory(BenchmarkParticipants.Scopes(request)) },
            ContextReadKind.Conversation => result with
            {
                Entries = ContextPolicies.Entries(read.Session)
                    .Where(entry => entry.Role is ContextRole.User or ContextRole.Assistant && entry.Content is TextContent)
                    .Take(request.Limit).ToImmutableArray()
            },
            ContextReadKind.Model => result with
            {
                Model = ContextPolicies.BuildModelContext(ContextPolicies.Entries(read.Session),
                    read.GetApplicableMemory(BenchmarkParticipants.Scopes(request)), request.TokenBudget,
                    ContextFixture.EstimateTokens, request.Limit)
            },
            _ => throw new ArgumentOutOfRangeException(nameof(request))
        };
    }

    public IContextRetention Retain(Guid id) => new Retention(_client.OpenRead(id));
    public void Dispose() => _client.Dispose();

    private sealed class Retention(ILLMContextReadLease lease) : IContextRetention
    {
        public long Revision => lease.Session.Revision;
        public ContextEntry? FirstEntry => lease.ReadRange(0, 1).FirstOrDefault();
        public void Dispose() => lease.Dispose();
    }
}
