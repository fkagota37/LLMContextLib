// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using BenchmarkDotNet.Attributes;
using LLMContextLib;

namespace LLMContextLib.Benchmarks;

/// <summary>
/// Per finite replay, not per message or commit. IterationSetup restores initial state and
/// requires one invocation/unroll to prevent accidental growth across repeated invocations.
/// The default matrix is deliberately the small four-scenario first stage in the plan.
/// </summary>
[MemoryDiagnoser]
[InvocationCount(1)]
public class LlmReplayBenchmarks
{
    [Params("Interactive")]
    public string Profile { get; set; } = "Interactive";

    [Params(ContextScenario.ActiveConversation, ContextScenario.Navigation,
        ContextScenario.Correction, ContextScenario.ScopedMemory)]
    public ContextScenario Scenario { get; set; }

    private ContextFixture _fixture = null!;
    private System.Collections.Immutable.ImmutableArray<ReplayAction> _trace;
    private ParticipantKind _kind;
    private IContextBenchmarkParticipant? _participant;

    [GlobalSetup(Target = nameof(ConventionalIndexed))]
    public void SetupIndexed() => Setup(ParticipantKind.ConventionalIndexed);
    [GlobalSetup(Target = nameof(ConventionalScan))]
    public void SetupScan() => Setup(ParticipantKind.ConventionalScan);
    [GlobalSetup(Target = nameof(LLMPolymorphic))]
    public void SetupPolymorphic() => Setup(ParticipantKind.LLMPolymorphic);

    private void Setup(ParticipantKind kind)
    {
        _kind = kind;
        _fixture = ContextFixture.Create(Profile);
        if (Scenario == ContextScenario.ScopedMemory && _fixture.Sessions.Length < 2)
            _fixture = ContextFixture.Create(Profile, sessionCount: 2);
        _trace = ContextTraces.Create(_fixture, Scenario);
        ReplayChecks.Verify(_fixture, _trace);
    }

    [IterationSetup]
    public void Reset()
    {
        _participant?.Dispose();
        _participant = BenchmarkParticipants.Create(_kind, _fixture);
    }

    [Benchmark(Baseline = true)]
    public ulong ConventionalIndexed() => ReplayEngine.Execute(_participant!, _trace).Digest;
    [Benchmark]
    public ulong ConventionalScan() => ReplayEngine.Execute(_participant!, _trace).Digest;
    [Benchmark]
    public ulong LLMPolymorphic() => ReplayEngine.Execute(_participant!, _trace).Digest;

    [GlobalCleanup]
    public void Cleanup() => _participant?.Dispose();
}
