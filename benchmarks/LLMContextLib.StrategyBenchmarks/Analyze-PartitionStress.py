# Copyright (c) 2026 felix kagota
# Author: felix kagota (felixkagota@gmail.com)
# SPDX-License-Identifier: MIT
# Experimental work in progress; not production-ready. No stable release/API guarantees.

"""Verify bounded stress evidence and summarize load, fairness, heap and scaling."""

import argparse
import json
import math
from collections import defaultdict
from pathlib import Path
from statistics import median

from Analyze import ROOT, check, digest, save_csv

MIB = 1024 * 1024


def quantile(histograms, fraction, frequency):
    buckets = [sum(h["Buckets"][i] for h in histograms) for i in range(1024)]
    count = sum(buckets)
    if not count:
        return 0
    rank = max(1, math.ceil(count * fraction))
    running = 0
    for i, n in enumerate(buckets):
        running += n
        if running >= rank:
            return round(2 ** ((i + 1) / 32) * 1_000_000 / frequency, 2)
    raise AssertionError("Invalid histogram.")


def jain(values):
    square = sum(value * value for value in values)
    return sum(values) ** 2 / (len(values) * square) if square else 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--analysis-output", required=True)
    parser.add_argument("--source-root", default=str(ROOT))
    parser.add_argument("--binary-root", default=str(Path(__file__).parent / "bin" / "Release"))
    args = parser.parse_args()
    directory = (ROOT / args.output).resolve()
    target = (ROOT / args.analysis_output).resolve()
    source_root = Path(args.source_root).resolve()
    binary_root = Path(args.binary_root).resolve()
    groups = defaultdict(list)
    expected_sources = None
    reports = {}
    total_attempts = total_applied = total_offered = total_oracles = dedicated = 0
    for framework in ("net8.0", "net9.0"):
        expected_binaries = None
        for direction in ("forward", "reverse"):
            path = directory / f"{framework}-{direction}.json"
            report = json.loads(path.read_text(encoding="utf-8-sig"))
            check(report["Mode"] == "PartitionStress" and report["Complete"], "Incomplete/wrong report.")
            check(report["Suite"] == "all" and len(report["Results"]) == 26, "Incomplete matrix.")
            check(report["WriterThreads"] == 1000 and report["Seconds"] >= 8, "Shortened final workload.")
            check(report["Reverse"] == (direction == "reverse"), "Wrong order.")
            sources, binaries = report["SourceHashes"], report["AssemblyHashes"]
            check(expected_sources is None or expected_sources == sources, "Mixed measured sources.")
            check(expected_binaries is None or expected_binaries == binaries, "Mixed runtime binaries.")
            expected_sources, expected_binaries = sources, binaries
            for name, sha in sources.items():
                check(digest(source_root / name) == sha, f"Source mismatch: {name}")
            for name, sha in binaries.items():
                binary = binary_root / framework / name
                check(digest(binary) == sha, f"Binary mismatch: {binary}")
            identities = set()
            for case in report["Results"]:
                identity = (case["Suite"], case["Name"], case["Policy"])
                check(identity not in identities, "Duplicate case.")
                identities.add(identity)
                check(case["Policy"] in ("ProducerEager", "Partitioned"), "Unknown policy.")
                check(case["Position"] == int((case["Policy"] == "Partitioned") != report["Reverse"]),
                      "Wrong pair position.")
                telemetry = case["Telemetry"]
                check(telemetry["Samples"] > 0 and telemetry["HighResolutionTimer"], "Missing high-resolution sampling.")
                check(telemetry["SampledPrivatePeakBytes"] <= report["ProcessPrivateByteStopLimit"], "Resource limit exceeded.")
                check(telemetry["AllocatedBytes"] >= 0 and telemetry["GcPauseTicks"] >= 0, "Invalid GC accounting.")
                stats = case.get("FinalStatistics")
                if case["Suite"] in ("Load", "Threads"):
                    terminal = case["Terminal"]
                    stats = terminal["FinalStatistics"]
                    attempts = terminal["Attempts"]
                    check(case["Offered"] == attempts + case["Dropped"], "Lost scheduled requests.")
                    check(sum(terminal["Statuses"]) == attempts, "Lost terminal outcomes.")
                    check(terminal["Statuses"][0] == terminal["Applied"], "Wrong accepted count.")
                    check(terminal["Statuses"][2] == terminal["Statuses"][4] == 0, "Invalid/missing destination.")
                    check(terminal["Apply"]["Count"] + terminal["RejectedBeforeApply"] == attempts, "Wrong Apply count.")
                    check(sum(terminal["Apply"]["Buckets"]) == terminal["Apply"]["Count"], "Wrong Apply histogram.")
                    check(sum(terminal["EndToEnd"]["Buckets"]) == attempts, "Wrong response histogram.")
                    check(sum(w["Applied"] for w in terminal["Workers"]) == terminal["Applied"], "Wrong worker accounting.")
                    check(terminal["AppliedSameState"] <= terminal["Applied"], "Wrong same-state count.")
                    check(sum(terminal["AppliedBySecond"]) <= terminal["Applied"], "Wrong window accounting.")
                    check(terminal["OracleChecks"] >= 2 * case["Sessions"], "Missing exact checks.")
                    check(terminal["Query"]["Count"] == terminal["Queries"], "Missing live query timing.")
                    check(terminal["Queries"] > 0, "No live queries.")
                    check(terminal["SyncFailures"] == 0, "Maintenance failure.")
                    total_offered += case["Offered"]
                    total_attempts += attempts
                    total_applied += terminal["Applied"]
                    total_oracles += terminal["OracleChecks"]
                    if case["Suite"] == "Threads":
                        check(case["Writers"] == case["ReadyWriters"] == 1000, "Not 1000 dedicated threads.")
                        dedicated += case["ReadyWriters"]
                    else:
                        check(case["HighResolutionPacing"], "Low-resolution arrival pacing.")
                        check(case["Offered"] == case["TargetRate"] * report["Seconds"], "Wrong offered load.")
                        check(case["SourceExpired"] <= case["Dropped"], "Invalid source expiry.")
                elif case["Suite"] == "Heap":
                    check(case["Mutations"] == 480 and len(case["Phases"]) == 3, "Incomplete shrink/grow.")
                    check((case["RetainedBytesBeforeRelease"] > 0) == case["Pinned"], "Wrong pinned lifecycle.")
                    total_oracles += 2
                elif case["Suite"] == "Scaling":
                    check(case["Partitions"] in (4, 64, 1024), "Wrong scaling boundary.")
                    check(case["CommonQuery"]["Count"] == case["PointQuery"]["Count"] == 128, "Missing scaling queries.")
                    total_oracles += case["OracleChecks"]
                else:
                    raise AssertionError("Unknown suite.")
                check(stats["RetainedReads"] == stats["EstimatedRetainedBytes"] ==
                      stats["EstimatedPreparationBytes"] == stats["PendingSynchronizations"] == 0,
                      "Leaked owner retention/preparation/maintenance.")
                groups[(framework,) + identity].append((report, case))
            expected = {
                (suite, name, policy)
                for suite, names in (
                    ("Load", [f"{sessions}s-{rate}rps" for sessions in (1, 8) for rate in (2000, 10000)]),
                    ("Heap", [f"{profile}-{pinned}" for profile in ("common", "distinct") for pinned in (False, True)]),
                    ("Scaling", [f"{n}partitions" for n in (4, 64, 1024)]),
                    ("Threads", [f"1000writers-{n}s" for n in (1, 1000)]),
                )
                for name in names for policy in ("ProducerEager", "Partitioned")
            }
            check(identities == expected, "Wrong experiment identities.")
            reports[path.name] = digest(path)
    rows = []
    for key, pairs in sorted(groups.items()):
        check(len(pairs) == 2 and len({r["Reverse"] for r, _ in pairs}) == 2, "Unpaired case.")
        framework, suite, name, policy = key
        row = dict(Framework=framework, Suite=suite, Name=name, Policy=policy)
        frequency = pairs[0][0]["Frequency"]
        telemetry = [case["Telemetry"] for _, case in pairs]
        for source, dest in (("SampledManagedPeakBytes", "SampledManagedPeakMiB"),
                             ("SampledWorkingSetPeakBytes", "SampledWorkingSetPeakMiB"),
                             ("SampledPrivatePeakBytes", "SampledPrivatePeakMiB"),
                             ("ObservedPostGcHeapPeakBytes", "ObservedPostGcHeapPeakMiB")):
            row[dest] = round(max(t[source] for t in telemetry) / MIB, 3)
        row["MaximumSamplerGapMs"] = round(max(t["MaximumSampleGapTicks"] for t in telemetry) * 1000 / frequency, 3)
        row["SamplingObservations"] = sum(t["Samples"] for t in telemetry)
        row["AllocatedMiBMedian"] = round(median(t["AllocatedBytes"] for t in telemetry) / MIB, 3)
        row["GcPauseMsMedian"] = round(median(t["GcPauseTicks"] for t in telemetry) / 10000, 3)
        row["CpuMsMedian"] = round(median(t["CpuTicks"] for t in telemetry) / 10000, 3)
        row["CollectionsMedian"] = [median(t["Collections"][i] for t in telemetry) for i in range(3)]
        if suite in ("Load", "Threads"):
            cases = [case for _, case in pairs]
            terminals = [case["Terminal"] for case in cases]
            windows = sum(case["WindowTicks"] for case in cases) / frequency
            elapsed = sum(case["WindowTicks"] + case["DrainTicks"] for case in cases) / frequency
            row["Offered"] = sum(case["Offered"] for case in cases)
            row["Dropped"] = sum(case["Dropped"] for case in cases)
            row["SourceExpired"] = sum(case.get("SourceExpired", 0) for case in cases)
            row["Attempts"] = sum(t["Attempts"] for t in terminals)
            row["Applied"] = sum(t["Applied"] for t in terminals)
            row["AppliedSameState"] = sum(t["AppliedSameState"] for t in terminals)
            row["AppliedTransitions"] = row["Applied"] - row["AppliedSameState"]
            row["AppliedPerSecondIncludingDrain"] = round(row["Applied"] / elapsed, 2)
            row["AppliedWithinWindowPerSecond"] = round(sum(sum(t["AppliedBySecond"]) for t in terminals) / windows, 2)
            row["TransitionPerSecondIncludingDrain"] = round(row["AppliedTransitions"] / elapsed, 2)
            row["MaximumDrainMs"] = round(max(case["DrainTicks"] for case in cases) * 1000 / frequency, 3)
            row["Statuses"] = [sum(t["Statuses"][i] for t in terminals) for i in range(7)]
            row["PeakSimultaneousApply"] = max(case["PeakInApply"] for case in cases)
            row["ZeroProgressWorkersMax"] = max(sum(w["Applied"] == 0 for w in t["Workers"]) for t in terminals)
            row["ZeroTransitionWorkersMax"] = max(sum(w["Applied"] == w["AppliedSameState"]
                                                     for w in t["Workers"]) for t in terminals)
            row["WorkersWithAttemptsMin"] = min(sum(w["Attempts"] > 0 for w in t["Workers"]) for t in terminals)
            row["AppliedJainMedian"] = round(median(jain([w["Applied"] for w in t["Workers"]]) for t in terminals), 4)
            row["TransitionJainMedian"] = round(median(jain([w["Applied"] - w["AppliedSameState"]
                                                            for w in t["Workers"]]) for t in terminals), 4)
            row["AttemptsBySecond"] = [t["AttemptsBySecond"] for t in terminals]
            row["AppliedBySecond"] = [t["AppliedBySecond"] for t in terminals]
            row["LatestFirstAttemptOffsetMs"] = round(max(w["FirstAttemptOffsetTicks"]
                for t in terminals for w in t["Workers"]) * 1000 / frequency, 3)
            if suite == "Threads":
                row["CreationMedianMs"] = round(median(case["CreationTicks"] for case in cases) * 1000 / frequency, 3)
            row["QuiescentSynchronizationMedianMs"] = round(
                median(t["QuiescentSynchronizationTicks"] for t in terminals) * 1000 / frequency, 3)
            row["QuiescentOracleMedianMs"] = round(
                median(t["QuiescentOracleTicks"] for t in terminals) * 1000 / frequency, 3)
            for source in ("Apply", "EndToEnd", "Queue", "Query", "Synchronization"):
                histograms = [t[source] for t in terminals]
                for fraction, label in ((0.5, "P50Us"), (0.95, "P95Us"), (0.99, "P99Us")):
                    row[source + label] = quantile(histograms, fraction, frequency)
        elif suite == "Heap":
            for field in ("InitialManagedBytes", "ProducerBaselineManagedBytes", "BeforeReleaseCollectedManagedBytes",
                          "AfterReleaseCollectedManagedBytes", "RetainedBytesBeforeRelease"):
                row[field.replace("Bytes", "MiB")] = round(median(case[field] for _, case in pairs) / MIB, 3)
            row["InitialOwnerCollectedDeltaMiB"] = round(median(
                case["InitialManagedBytes"] - case["ProducerBaselineManagedBytes"] for _, case in pairs) / MIB, 3)
            row["CollectedReleaseDeltaMiB"] = round(median(
                case["BeforeReleaseCollectedManagedBytes"] - case["AfterReleaseCollectedManagedBytes"]
                for _, case in pairs) / MIB, 3)
        else:
            row["Partitions"] = pairs[0][1]["Partitions"]
            row["SynchronizationMedianMs"] = round(median(case["SynchronizationTicks"] for _, case in pairs) * 1000 / frequency, 3)
            for source in ("Apply", "CommonQuery", "PointQuery"):
                for fraction, label in ((0.5, "P50Us"), (0.95, "P95Us"), (0.99, "P99Us")):
                    row[source + label] = quantile([case[source] for _, case in pairs], fraction, frequency)
        rows.append(row)
    target.mkdir(parents=True, exist_ok=True)
    # Different suites have different columns; write one stable schema per suite.
    for suite in ("Load", "Threads", "Heap", "Scaling"):
        save_csv(target / f"stress-{suite.lower()}.csv", [row for row in rows if row["Suite"] == suite])
    summary = dict(Reports=reports, AnalyzerSHA256=digest(Path(__file__)),
                   Percentiles="Upper bounds from 32 logarithmic buckets per octave, approximately 2.2% resolution",
                   ReportCount=len(reports), VerifiedCases=sum(len(pairs) for pairs in groups.values()),
                   OfferedRequests=total_offered, Attempts=total_attempts, Applied=total_applied,
                   OracleChecks=total_oracles, DedicatedWriterThreadsCreated=dedicated, Results=rows)
    (target / "stress-summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in summary.items() if key not in ("Reports", "Results")}, indent=2))


if __name__ == "__main__":
    main()
