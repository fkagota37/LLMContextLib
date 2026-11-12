// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using System.Text.Json;

namespace LLMContextLib.Examples.BuildInvestigation;

/// <summary>
/// Application worker that runs the existing profiler and journals its results.
/// It borrows the shared context owner; it does not create or dispose one.
/// The cache path below contains no IReasoningModel dependency.
/// </summary>
public sealed class BuildRunnerWorker
{
    private readonly ILLMContextPolymorphicArray _contexts;
    private readonly IBuildProfiler _profiler;

    /// <summary>Borrow the host's shared owner and existing tool integration; neither is owned by this worker.</summary>
    public BuildRunnerWorker(ILLMContextPolymorphicArray contexts, IBuildProfiler profiler)
    {
        _contexts = contexts;
        _profiler = profiler;
    }

    /// <summary>
    /// Capture a base revision, execute one external job, then publish its completed call/result
    /// pair atomically. Returns only after the publication succeeds. The profiler is outside the
    /// storage transaction: a conflict after execution must not trigger a blind rerun.
    /// </summary>
    /// <param name="sessionId">Canonical target session shared with the coordinator.</param>
    /// <param name="settings">Application-defined inputs serialized into the invocation record.</param>
    /// <returns>Committed identities/version for later anchors and dependent publications.</returns>
    /// <exception cref="InvalidOperationException">Recording failed, possibly after external work completed.</exception>
    public RecordedBuild RunAndRecord(Guid sessionId, BuildSettings settings)
    {
        // Step 1: capture the revision this job is based on. Release the read
        // immediately: an external build must not retain an unnecessary snapshot.
        long expectedRevision;
        using (var read = _contexts.OpenRead(sessionId))
            expectedRevision = read.Session.Revision;

        // Step 2: execute the application's tool OUTSIDE the library.
        // This may be expensive, but it is build execution, not LLM inference.
        BuildObservation observation = _profiler.Run(settings);

        // Step 3: assign canonical entry IDs now. The coordinator will later
        // use them as anchor endpoints without rediscovering text locations.
        Guid callEntryId = Guid.NewGuid();
        Guid resultEntryId = Guid.NewGuid();
        string callId = Guid.NewGuid().ToString("N");
        DateTimeOffset recordedAt = DateTimeOffset.UtcNow;

        // Step 4: describe ONE atomic transcript update. AppendEntries is a
        // command, not the execution of the profiler. Here we record a completed
        // call/result pair together so readers never see half of this publication.
        var completedRun = new AppendEntries([
            new ContextEntryDraft(callEntryId, ContextRole.Assistant, recordedAt,
                new ToolCallContent(callId, settings.Tool, JsonSerializer.Serialize(settings))),
            new ContextEntryDraft(resultEntryId, ContextRole.Tool, recordedAt,
                new ToolResultContent(callId, JsonSerializer.Serialize(observation), false))
        ]);
        var changeSet = new ContextChangeSet(
            SessionId: sessionId,
            ExpectedRevision: expectedRevision,
            Changes: [completedRun]);

        // Step 5: ask the library to validate and publish that update.
        // If another writer advanced this session during the build, this can
        // return RevisionConflict. The already executed build is NOT rolled back.
        IContextMutationResult result = _contexts.Apply(changeSet);
        long publishedRevision = Publication.EnsureApplied(result, "Record completed build");

        // Step 6: hand identities and the committed revision to the next worker.
        return new RecordedBuild(
            settings, observation, callEntryId, resultEntryId, publishedRevision);
    }

    /// <summary>
    /// Inspect a bounded repository-memory view, check this application's configuration schema,
    /// and require current provenance. A compatible hit needs no reasoning-model invocation,
    /// but does not skip the next external build or certify that these settings are optimal.
    /// </summary>
    /// <param name="sessionId">Target job session; repository identity comes from stored metadata.</param>
    /// <param name="toolVersion">Exact version required by the current external tool.</param>
    /// <param name="workloadKey">Exact workload compatibility key chosen by the application.</param>
    /// <param name="settings">Compatible decoded settings on success; null for an ordinary miss.</param>
    /// <returns>False for absence, incompatible payloads, or non-current source status.</returns>
    /// <remarks>
    /// This is deliberately not a total error-to-cache-miss adapter. Missing source sessions/
    /// anchors and admission failures can throw; a live host must choose recovery behavior.
    /// A 16-item search cap can miss later compatible records, and Current is conservative.
    /// </remarks>
    public bool TryGetReusableSettings(
        Guid sessionId, string toolVersion, string workloadKey, out BuildSettings? settings)
    {
        settings = null;

        // Step 1: obtain the session's repository identity from stored context,
        // rather than allowing a model to invent the scope of a lookup.
        Guid? repositoryId;
        using (var read = _contexts.OpenRead(sessionId))
            repositoryId = read.Session.RepositoryId;
        if (repositoryId is null) return false;

        // Step 2: request repository memory. The library filters for the exact
        // requested scope, applicability, Confirmed status, and captured expiry.
        // This bounded example inspects at most 16 records; a truncated view is
        // not proof that no other configuration exists.
        var scope = new MemoryScope(RepositoryId: repositoryId);
        using var memories = _contexts.OpenView(ContextViews.Memory(sessionId, [scope], limit: 16));
        foreach (var memory in memories)
        {
            BuildSettings? candidate;
            try
            {
                // Step 3: decode our OWN payload format. Other applications can
                // store different text/JSON in this catalog; it is not a typed
                // configuration cache supplied by LLMContextLib.
                candidate = JsonSerializer.Deserialize<BuildSettings>(memory.Content);
            }
            catch (JsonException)
            {
                continue;
            }

            // Step 4: ordinary application checks decide compatibility.
            // Scope/TTL alone cannot tell us whether a setting fits this tool.
            if (candidate is null || candidate.Tool != "build-profiler" ||
                candidate.ToolVersion != toolVersion || candidate.WorkloadKey != workloadKey ||
                candidate.Workers is < 1 or > 32 || memory.Sources.Length != 1)
                continue;

            // Step 5: inspect the source anchor using the library, not inference.
            // Requiring Current is this application's conservative cache policy:
            // even an unrelated later session edit can make an anchor Edited.
            var source = memory.Sources[0];
            using var evidence = _contexts.OpenRead(source.SessionId);
            var target = evidence.ResolveAnchor(source.AnchorId);
            if (target.Status != AnchorTargetStatus.Current) continue;

            // A hit bypasses planning/explanation calls in the host's follow-up
            // branch. It does NOT prove the setting is optimal or skip the build.
            settings = candidate;
            return true;
        }
        return false;
    }
}
