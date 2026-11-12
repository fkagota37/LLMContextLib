// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Text.Json;

namespace LLMContextLib.Examples.BuildInvestigation;

/// <summary>
/// Application worker that turns an approved investigation outcome into memory.
/// It does not duplicate the transcript: both memories point back to its anchor.
/// It writes the memory catalog, whose revision is independent of session A's.
/// </summary>
public sealed class KnowledgeWorker
{
    private readonly ILLMContextPolymorphicArray _contexts;

    /// <summary>Borrow the same owner used to publish the evidence; do not create a second catalog.</summary>
    public KnowledgeWorker(ILLMContextPolymorphicArray contexts) => _contexts = contexts;

    /// <summary>
    /// Publish an application-approved outcome as two memories: an investigation-only note and
    /// a repository-reusable configuration. Both retain source IDs, not copied transcripts.
    /// Approval is a host decision before this call, not something the library or worker infers.
    /// </summary>
    /// <param name="sessionId">Evidence session, required by this example to belong to a repository.</param>
    /// <param name="outcome">Coordinator handoff whose experiment anchor supplies provenance.</param>
    /// <returns>The new memory-catalog revision, not the source session revision.</returns>
    /// <remarks>
    /// This worker captures metadata then submits a separate catalog transaction. Source changes
    /// can race that workflow; publication does not lock sessions or guarantee future freshness.
    /// The repository configuration expires for new reads after 30 minutes; expiry is not eviction.
    /// </remarks>
    public long PublishApproved(Guid sessionId, InvestigationOutcome outcome)
    {
        // Step 1: capture source metadata and the memory revision to be checked.
        // We release the read before mutation. This capture is not an atomic
        // transaction spanning the session and memory catalogs.
        Guid repositoryId;
        long expectedMemoryRevision;
        using (var read = _contexts.OpenRead(sessionId))
        {
            repositoryId = read.Session.RepositoryId
                ?? throw new InvalidOperationException("This example requires a repository.");
            expectedMemoryRevision = read.MemoryRevision;
        }

        // Step 2: preserve WHY the memory exists. Confirmed memory requires source
        // anchors; the library validates that the source resolves when publishing.
        var source = new MemorySource(sessionId, outcome.ExperimentAnchorId);
        var localNote = new ContextMemory(
            MemoryId: Guid.NewGuid(),
            Scope: new MemoryScope(SessionId: sessionId),
            Content: "Keep verbose profiler traces for this investigation only.",
            Revision: 0,
            Status: MemoryStatus.Confirmed,
            ExpiresAt: null,
            Sources: [source]);

        // Step 3: store a reusable configuration under a DIFFERENT scope.
        // The payload is our BuildSettings JSON. Scope makes it applicable to
        // other sessions for this repository; it is not an authorization grant.
        var reusableConfiguration = new ContextMemory(
            MemoryId: Guid.NewGuid(),
            Scope: new MemoryScope(RepositoryId: repositoryId),
            Content: JsonSerializer.Serialize(outcome.RecommendedSettings),
            Revision: 0,
            Status: MemoryStatus.Confirmed,
            ExpiresAt: DateTimeOffset.UtcNow.AddMinutes(30),
            Sources: [source]);

        // Step 4: publish both records in one memory transaction.
        // Revision:0 above is initial record metadata, NOT our concurrency check.
        // ExpectedRevision below checks the catalog; the library stamps accepted
        // records with the new catalog revision.
        var memoryChange = new MemoryChangeSet(
            ExpectedRevision: expectedMemoryRevision,
            Upserts: [localNote, reusableConfiguration],
            Deletes: []);
        IContextMutationResult result = _contexts.ApplyMemory(memoryChange);
        return Publication.EnsureApplied(result, "Publish scoped knowledge");
    }
}
