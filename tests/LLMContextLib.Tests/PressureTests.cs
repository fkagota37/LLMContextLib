// Copyright (c) 2026 felix kagota
// Author: felix kagota (felixkagota@gmail.com)
// SPDX-License-Identifier: MIT
// Experimental work in progress; not production-ready. No stable release/API guarantees.

using LLMContextLib.Benchmarks;
using Xunit;

namespace LLMContextLib.Tests;

public sealed class PressureTests
{
    [Theory]
    [InlineData(ParticipantKind.ConventionalScan, PressurePoint.Deletion)]
    [InlineData(ParticipantKind.ConventionalIndexed, PressurePoint.Deletion)]
    [InlineData(ParticipantKind.LLMPolymorphic, PressurePoint.Deletion)]
    [InlineData(ParticipantKind.ConventionalScan, PressurePoint.IndexPayoff)]
    [InlineData(ParticipantKind.ConventionalIndexed, PressurePoint.IndexPayoff)]
    [InlineData(ParticipantKind.LLMPolymorphic, PressurePoint.IndexPayoff)]
    [InlineData(ParticipantKind.ConventionalScan, PressurePoint.Contention)]
    [InlineData(ParticipantKind.ConventionalIndexed, PressurePoint.Contention)]
    [InlineData(ParticipantKind.LLMPolymorphic, PressurePoint.Contention)]
    [InlineData(ParticipantKind.ConventionalScan, PressurePoint.Snapshots)]
    [InlineData(ParticipantKind.ConventionalIndexed, PressurePoint.Snapshots)]
    [InlineData(ParticipantKind.LLMPolymorphic, PressurePoint.Snapshots)]
    public async Task PressureCasesValidateResultsAndRecordMechanismCounters(ParticipantKind kind, PressurePoint point)
    {
        var result = await PressureBenchmarks.RunCase(new(point, kind, 64, Iterations: 2, Warmups: 0));
        Assert.NotEmpty(result.Requests);
        Assert.NotEmpty(result.Memory);
        Assert.Equal(result.Requests.Length, result.Latencies.Sum(sample => sample.Samples));
        Assert.All(result.Requests, sample =>
        {
            Assert.True(sample.AllocatedBytes >= 0);
            Assert.True(sample.ElapsedMs >= 0);
        });
        if (point == PressurePoint.Deletion)
        {
            Assert.All(result.Requests.Where(sample => sample.Category == "Replay"), sample =>
            {
                Assert.Equal(kind == ParticipantKind.LLMPolymorphic ? (int?)null : 64, sample.CompactedEntries);
                Assert.Equal(kind == ParticipantKind.LLMPolymorphic ? (int?)null : 63, sample.RebuiltLocations);
            });
        }
        if (point == PressurePoint.Snapshots)
        {
            Assert.Equal(0, result.Memory[^1].Held);
            if (kind == ParticipantKind.LLMPolymorphic) Assert.Equal(0, result.Memory[^1].EstimatedRetainedBytes);
            else Assert.All(result.Requests.Where(sample => sample.Category == "Retain"),
                sample => Assert.True(sample.SnapshotReferences >= 64));
        }
        if (point == PressurePoint.Contention)
        {
            Assert.Equal(4, result.Requests.Count(sample => sample.Category == "LongReader"));
            Assert.Equal(2, result.Requests.Count(sample => sample.Category == "Writer" && sample.Status == "Applied"));
        }
    }

    [Theory]
    [InlineData(ParticipantKind.ConventionalScan)]
    [InlineData(ParticipantKind.ConventionalIndexed)]
    [InlineData(ParticipantKind.LLMPolymorphic)]
    public async Task AdmissionCasesExposeRatherThanConflateByteGuarantees(ParticipantKind kind)
    {
        var result = await PressureBenchmarks.RunCase(new(PressurePoint.Admission, kind, 64, Iterations: 2, Warmups: 0));
        Assert.Equal("Rejected", Assert.Single(result.Requests, sample => sample.Category == "ReadCountTimeout").Status);
        Assert.Equal(kind == ParticipantKind.LLMPolymorphic ? "Rejected" : "Completed",
            Assert.Single(result.Requests, sample => sample.Category == "RetainedByteRead").Status);
        Assert.Equal("Applied", Assert.Single(result.Requests, sample => sample.Category == "WriteAfterRelease").Status);
        Assert.Contains(result.Notes, note => note.Contains("ABSENT", StringComparison.Ordinal));
    }
}
