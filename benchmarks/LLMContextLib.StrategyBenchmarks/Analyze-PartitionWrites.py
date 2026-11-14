# Copyright (c) 2026 felix kagota
# Author: felix kagota (felixkagota@gmail.com)
# SPDX-License-Identifier: MIT
# Experimental work in progress; not production-ready. No stable release/API guarantees.

"""Verify matched partition-write reports, including synchronization and retained roots."""

import argparse
import json
from collections import defaultdict
from pathlib import Path
from statistics import median

from Analyze import ROOT, check, digest, latency, save_csv


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--analysis-output", required=True)
    args = parser.parse_args()
    output = (ROOT / args.output).resolve()
    analysis = (ROOT / args.analysis_output).resolve()
    sources = None
    groups = defaultdict(list)
    reports = {}
    for framework in ("net8.0", "net9.0"):
        assemblies = None
        for direction in ("forward", "reverse"):
            path = output / f"{framework}-{direction}.json"
            report = json.loads(path.read_text(encoding="utf-8-sig"))
            check(report["Mode"] == "PartitionWrites", "Wrong experiment.")
            check(report["Reverse"] == (direction == "reverse"), "Wrong order.")
            check(sources is None or sources == report["SourceHashes"], "Mixed sources.")
            check(assemblies is None or assemblies == report["AssemblyHashes"], "Mixed binaries.")
            sources, assemblies = report["SourceHashes"], report["AssemblyHashes"]
            for name, sha in sources.items():
                check(digest(ROOT / name) == sha, f"Source mismatch: {name}")
            for name, sha in assemblies.items():
                binary = Path(__file__).parent / "bin" / "Release" / framework / name
                check(digest(binary) == sha, f"Binary mismatch: {name}")
            check(len(report["Rounds"]) == 8 * report["Calls"], "Incomplete pair matrix.")
            identities = set()
            for row in report["Rounds"]:
                identity = (row["Profile"], row["Pinned"], row["Policy"], row["Pair"])
                check(identity not in identities, "Duplicate round.")
                identities.add(identity)
                check(0 <= row["Pair"] < report["Calls"], "Invalid pair.")
                check(row["Position"] == int((row["Policy"] == "Partitioned") != report["Reverse"]),
                      "Wrong pair position.")
                check(len(row["Samples"]) == 32, "Incomplete mutation round.")
                check([s["Operation"] for s in row["Samples"]] == ["Delete"] * 16 + ["Grow"] * 16,
                      "Wrong shrink/grow workflow.")
                check(row["RetainedBytesAfterRelease"] == 0, "Leaked retention.")
                check((row["RetainedBytesBeforeRelease"] > 0) == row["Pinned"], "Wrong pinned lifecycle.")
                if row["Policy"] == "Partitioned":
                    check(row["AfterSynchronizationBytes"] < row["BeforeSynchronizationBytes"],
                          "Deletion debt was not released.")
                    check(row["SynchronizationTicks"] > 0 and row["GrowthSynchronizationTicks"] > 0,
                          "Missing completion costs.")
                groups[(framework, row["Profile"], row["Pinned"], row["Policy"])].append((report, row))
            reports[path.name] = digest(path)
    rows = []
    lifecycles = []
    for key, pairs in sorted(groups.items()):
        check(len({report["Reverse"] for report, _ in pairs}) == 2, "Unpaired order.")
        common = dict(zip(("Framework", "Profile", "Pinned", "Policy"), key))
        frequency = pairs[0][0]["Frequency"]
        for operation in ("Delete", "Grow"):
            samples = [s for _, row in pairs for s in row["Samples"] if s["Operation"] == operation]
            row = dict(common, Operation=operation, Samples=len(samples),
                       ApplyBytes=median(s["ApplyBytes"] for s in samples))
            row.update(latency(samples, "ApplyTicks", frequency, "Apply"))
            row.update(latency(samples, "QueryScopeTicks", frequency, "QueryScope"))
            rows.append(row)
        lifecycle = dict(common, Rounds=len(pairs))
        for name in ("SynchronizationTicks", "GrowthSynchronizationTicks"):
            lifecycle[name.replace("Ticks", "MedianUs")] = (
                median(row[name] for _, row in pairs) * 1_000_000 / frequency)
        lifecycle["WriteAndBothSynchronizationsMedianUs"] = median(
            sum(s["ApplyTicks"] for s in row["Samples"]) + row["SynchronizationTicks"] +
            row["GrowthSynchronizationTicks"] for _, row in pairs) * 1_000_000 / frequency
        for name in ("SynchronizationProcessBytes", "GrowthSynchronizationProcessBytes",
                     "InitialActiveBytes", "BeforeSynchronizationBytes", "AfterSynchronizationBytes",
                     "FinalActiveBytes", "RetainedBytesBeforeRelease"):
            lifecycle[name] = median(row[name] for _, row in pairs)
        lifecycles.append(lifecycle)
    analysis.mkdir(parents=True, exist_ok=True)
    save_csv(analysis / "partition-writes.csv", rows)
    save_csv(analysis / "partition-lifecycles.csv", lifecycles)
    summary = dict(Reports=reports, AnalyzerSHA256=digest(Path(__file__)),
                   SharedAnalyzerSHA256=digest(Path(__file__).with_name("Analyze.py")),
                   TimedWrites=sum(row["Samples"] for row in rows), Results=rows, Lifecycles=lifecycles)
    (analysis / "partition-summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(dict(Reports=len(reports), TimedWrites=summary["TimedWrites"]), indent=2))


if __name__ == "__main__":
    main()
