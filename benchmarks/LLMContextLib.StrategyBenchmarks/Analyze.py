# Copyright (c) 2026 felix kagota
# Author: felix kagota (felixkagota@gmail.com)
# SPDX-License-Identifier: MIT
# Experimental work in progress; not production-ready. No stable release/API guarantees.

"""Verify raw matched evidence and aggregate nearest-rank per-call percentiles."""

import argparse
import csv
import hashlib
import json
import math
import statistics
from collections import Counter, defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
POLICIES = (
    "Native", "PinnedNative", "LuceneRange", "LuceneChar", "MemoNative1M",
    "MemoRange1M", "Deferred", "AppendRouter", "ComposedNative1M",
    "ComposedRange1M", "ComposedNative4M", "ComposedRange4M",
)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest().upper()


def percentile(values, fraction):
    ordered = sorted(values)
    if not ordered:
        return None
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)]


def latency(samples, field, frequency, prefix=""):
    values = [sample[field] * 1_000_000 / frequency for sample in samples]
    return {
        prefix + "P50Us": percentile(values, .50),
        prefix + "P95Us": percentile(values, .95),
        prefix + "P99Us": percentile(values, .99),
    }


def median(samples, field):
    return statistics.median(sample[field] for sample in samples)


def save_csv(path, rows):
    if not rows:
        raise ValueError(f"No rows for {path}")
    fields = list(dict.fromkeys(key for row in rows for key in row))
    with path.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def check(condition, message):
    if not condition:
        raise ValueError(message)


def reconstruct_query_hits(run):
    """Derive result cardinality at each captured content revision from accepted writes."""
    for session in {request["Session"] for request in run["Requests"]}:
        identity = int(session.split("-")[0], 16)
        entries = {f"{identity * 1000 + i:08x}-0000-0000-0000-000000000000": i for i in range(8)}
        writes = sorted((r for r in run["Requests"] if r["Session"] == session and r["Outcome"] == "Applied"),
                        key=lambda r: r["Revision"])
        queries = sorted((r for r in run["Requests"] if r["Session"] == session and r["Kind"] == "Search"),
                         key=lambda r: r["Revision"])
        position = 0
        for query in queries:
            while position < len(writes) and writes[position]["Revision"] <= query["Revision"]:
                write = writes[position]
                check(write["Revision"] == position + 1, "Noncontiguous accepted history.")
                entries[write["Entry"]] = write["Variant"]
                position += 1
            check(position == query["Revision"], "Missing history for captured query revision.")
            query["ExpectedHits"] = min(16, sum(value == query["Variant"] for value in entries.values()))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=r"TestResults\ComposedPerformance\Final-v3")
    parser.add_argument("--analysis-output", help="Separate derived output directory when existing CSVs are open.")
    parser.add_argument("--source-root", help="Archived measured source tree; defaults to the current checkout.")
    parser.add_argument("--binary-root", help="Archived per-framework DLL directories; defaults to current build output.")
    args = parser.parse_args()
    output = (ROOT / args.output).resolve()
    analysis = (ROOT / args.analysis_output).resolve() if args.analysis_output else output
    source_root = (ROOT / args.source_root).resolve() if args.source_root else ROOT
    binary_root = (ROOT / args.binary_root).resolve() if args.binary_root else Path(__file__).parent / "bin" / "Release"
    reports = []
    expected_sources = None
    for framework in ("net8.0", "net9.0"):
        expected_assemblies = None
        for direction in ("forward", "reverse"):
            path = output / f"{framework}-{direction}.json"
            report = json.loads(path.read_text(encoding="utf-8-sig"))
            check(report["Suite"] == "all", "Only complete all-phase reports can be aggregated.")
            check(report["Reverse"] == (direction == "reverse"), "Wrong order marker.")
            check(report["OracleChecks"] == 84, "Missing oracle gate.")
            check(len(report["Sequential"]) == 264, "Incomplete sequential matrix.")
            check(len(report["Loads"]) == 48, "Incomplete load matrix.")
            check(len(report["Memory"]) == 72, "Incomplete heap matrix.")
            if expected_sources is not None:
                check(expected_sources == report["SourceHashes"], "Mixed source identities.")
            expected_sources = report["SourceHashes"]
            if expected_assemblies is not None:
                check(expected_assemblies == report["AssemblyHashes"], "Mixed runtime binaries.")
            expected_assemblies = report["AssemblyHashes"]
            for name, sha in report["SourceHashes"].items():
                check(digest(source_root / name) == sha, f"Source mismatch: {name}")
            binary_dir = binary_root / framework
            for name, sha in report["AssemblyHashes"].items():
                check(digest(binary_dir / name) == sha, f"Binary mismatch: {framework}/{name}")
            for run in report["Sequential"]:
                check(len(run["Mutations"]) == report["Calls"], "Incomplete mutation samples.")
                check(len(run["Queries"]) == report["Calls"], "Incomplete query samples.")
                check(all(q["Pending"] == 0 and q["Hits"] > 0 for q in run["Queries"]),
                      "Complete-query coverage failed.")
                expected_position = int((run["Policy"] == "Native") == report["Reverse"])
                check(run["Position"] == expected_position, "Baseline/candidate order is not matched.")
            for run in report["Loads"]:
                check(len(run["Requests"]) == 4 * report["Calls"], "Missing load terminal requests.")
                counts = Counter(request["Outcome"] for request in run["Requests"])
                check(set(counts) <= {"Applied", "RevisionConflict", "AdmissionRejected", "Succeeded"},
                      f"Unexpected terminal outcome: {counts}")
                check(counts["Succeeded"] == 2 * report["Calls"], "Lost query requests.")
                check(len({(r["Worker"], r["Index"]) for r in run["Requests"]}) == 4 * report["Calls"],
                      "Duplicate request terminals.")
                check(all(r["QueueTicks"] >= 0 and r["Ticks"] >= 0
                          and r["EndToEndTicks"] == r["QueueTicks"] + r["Ticks"] for r in run["Requests"]),
                      "Invalid scheduled/service timing accounting.")
                check(run["ForegroundTicks"] >= (report["Calls"] - 1) * report["Frequency"] / 1000,
                      "Load ended before its final predetermined arrivals.")
                check(run["Final"]["PendingIndexWork"] == 0 and run["Final"]["EstimatedIndexWorkBytes"] == 0
                      and run["Final"]["RetainedReads"] == 0, "Work/read reservation did not drain.")
                check(len(run["Heap"]) > 0, "No loaded heap samples.")
                reconstruct_query_hits(run)
            reports.append((framework, direction, report))

    sequential = defaultdict(list)
    loads = defaultdict(list)
    memories = defaultdict(list)
    for framework, direction, report in reports:
        for run in report["Sequential"]:
            key = (framework, run["Profile"], run["Reuse"], run["Operation"], run["Candidate"], run["Policy"])
            sequential[key].append((report, run))
        for run in report["Loads"]:
            key = (framework, run["Profile"], run["Policy"], run["Serialized"], run["Distributed"])
            loads[key].append((report, run))
        for run in report["Memory"]:
            memories[(framework, run["Profile"], run["Policy"])].append(run)

    sequential_rows = []
    for key, pairs in sorted(sequential.items()):
        check(len(pairs) == 2, "Unpaired sequential result.")
        framework, profile, reuse, operation, candidate, policy = key
        frequency = pairs[0][0]["Frequency"]
        check(frequency == pairs[1][0]["Frequency"], "Mixed stopwatch frequency.")
        mutations = [sample for _, run in pairs for sample in run["Mutations"]]
        queries = [sample for _, run in pairs for sample in run["Queries"]]
        executions = [run["Execution"] for _, run in pairs if run["Execution"] is not None]
        row = dict(Framework=framework, Profile=profile, Reuse=reuse, Operation=operation,
                   Candidate=candidate, Policy=policy, Samples=len(mutations),
                   Characters=pairs[0][1]["Characters"], Terms=pairs[0][1]["Terms"])
        row.update(latency(mutations, "ApplyTicks", frequency, "Apply"))
        row.update(latency(mutations, "CompleteTicks", frequency, "Complete"))
        row.update(latency(queries, "Ticks", frequency, "Query"))
        row.update(CallerBytes=median(mutations, "CallerBytes"),
                   ProcessBytesThroughCompletion=median(mutations, "ProcessBytes"),
                   QueryBytes=median(queries, "Bytes"),
                   FinalActiveBytes=statistics.median(run["ActiveBytes"] for _, run in pairs))
        for field in ("MemoHits", "MemoMisses", "MemoBypasses", "MemoAdmissionBypasses",
                      "DeferredEntries", "SynchronousEntries", "DeferredCapacityFallbacks", "TermCollections"):
            row[field] = sum(execution[field] for execution in executions)
        sequential_rows.append(row)

    load_rows = []
    load_latencies = []
    query_coverage = []
    for key, pairs in sorted(loads.items()):
        check(len(pairs) == 2, "Unpaired load result.")
        framework, profile, policy, serialized, distributed = key
        frequency = pairs[0][0]["Frequency"]
        requests = [request for _, run in pairs for request in run["Requests"]]
        counts = Counter(request["Outcome"] for request in requests)
        foreground = sum(run["ForegroundTicks"] for _, run in pairs) / frequency
        complete = sum(run["ThroughCompletionTicks"] for _, run in pairs) / frequency
        successful = counts["Applied"] + counts["Succeeded"]
        row = dict(Framework=framework, Profile=profile, Policy=policy,
                   Serialized=serialized, Distributed=distributed, Requests=len(requests),
                   Applied=counts["Applied"], Conflicted=counts["RevisionConflict"],
                   Rejected=counts["AdmissionRejected"], Searches=counts["Succeeded"],
                   AppliedPerSecond=counts["Applied"] / foreground,
                   SearchesPerSecond=counts["Succeeded"] / foreground,
                   SuccessfulRequestsPerSecond=successful / foreground,
                   SuccessfulRequestsThroughCompletionPerSecond=successful / complete,
                   ProcessBytesPerSuccessfulRequest=sum(run["ProcessBytes"] for _, run in pairs) / successful,
                   MaximumObservedManagedBytes=max(h["ManagedBytes"] for _, run in pairs for h in run["Heap"]),
                   MaximumObservedManagedDeltaBytes=max(
                       h["ManagedBytes"] - run["BaselineManagedBytes"] for _, run in pairs for h in run["Heap"]),
                   MaximumObservedPrivateBytes=max(h["PrivateBytes"] for _, run in pairs for h in run["Heap"]),
                   MaximumObservedPending=max(h["Pending"] for _, run in pairs for h in run["Heap"]),
                   GCPauseMs=sum(run["GCPauseTicks"] for _, run in pairs) / 10000,
                   MedianPostForegroundDrainMs=statistics.median(
                       (run["ThroughCompletionTicks"] - run["ForegroundTicks"]) * 1000 / frequency for _, run in pairs),
                   MinimumHeapObservations=min(len(run["Heap"]) for _, run in pairs),
                   MedianForegroundMs=statistics.median(run["ForegroundTicks"] * 1000 / frequency for _, run in pairs),
                   EmptySearches=sum(r["ExpectedHits"] == 0 for r in requests if r["Kind"] == "Search"),
                   NonemptySearches=sum(r["ExpectedHits"] > 0 for r in requests if r["Kind"] == "Search"),
                   PendingQueries=sum(r["Pending"] > 0 for r in requests if r["Kind"] == "Search"))
        for outcome in ("Applied", "RevisionConflict", "AdmissionRejected", "Succeeded"):
            for kind in ("Append", "Replace", "Search"):
                samples = [r for r in requests if r["Outcome"] == outcome and r["Kind"] == kind]
                if samples:
                    metric = dict(Framework=framework, Profile=profile, Policy=policy, Serialized=serialized,
                                  Distributed=distributed, Kind=kind, Outcome=outcome, Samples=len(samples),
                                  MedianCallerBytes=median(samples, "CallerBytes"))
                    metric.update(latency(samples, "Ticks", frequency))
                    metric.update(latency(samples, "EndToEndTicks", frequency, "EndToEnd"))
                    metric.update(latency(samples, "QueueTicks", frequency, "Scheduling"))
                    load_latencies.append(metric)
        for pending in (False, True):
            for nonempty in (False, True):
                samples = [r for r in requests if r["Kind"] == "Search"
                           and (r["Pending"] > 0) == pending and (r["ExpectedHits"] > 0) == nonempty]
                if samples:
                    metric = dict(Framework=framework, Profile=profile, Policy=policy,
                                  Serialized=serialized, Distributed=distributed,
                                  Coverage="PendingExact" if pending else "Complete",
                                  Results="Nonempty" if nonempty else "Empty", Samples=len(samples))
                    metric.update(latency(samples, "Ticks", frequency))
                    metric.update(latency(samples, "EndToEndTicks", frequency, "EndToEnd"))
                    query_coverage.append(metric)
        load_rows.append(row)

    memory_rows = []
    for (framework, profile, policy), samples in sorted(memories.items()):
        check(len(samples) == 6, "Incomplete paired retention samples.")
        row = dict(Framework=framework, Profile=profile, Policy=policy, Samples=len(samples))
        for field in ("ActiveHeap", "TwoGenerationHeap", "AfterDeleteHeap", "AfterDisposeHeap",
                      "EstimatedActiveBytes", "EstimatedRetainedBytes", "EstimatedAfterDeleteBytes", "MemoEntries"):
            row[field] = median(samples, field)
        memory_rows.append(row)

    paired_rows = []
    indexed = {(r["Framework"], r["Profile"], r["Reuse"], r["Operation"], r["Candidate"], r["Policy"]): r
               for r in sequential_rows}
    for row in sequential_rows:
        if row["Policy"] == "Native":
            continue
        baseline = indexed[(row["Framework"], row["Profile"], row["Reuse"], row["Operation"], row["Candidate"], "Native")]
        paired = {key: row[key] for key in ("Framework", "Profile", "Reuse", "Operation", "Policy", "Samples")}
        for field in ("ApplyP50Us", "ApplyP95Us", "ApplyP99Us", "CompleteP50Us", "CompleteP95Us",
                      "CallerBytes", "ProcessBytesThroughCompletion", "QueryP95Us"):
            paired["Baseline" + field] = baseline[field]
            paired["Candidate" + field] = row[field]
            paired[field + "Ratio"] = row[field] / baseline[field] if baseline[field] else None
        paired_rows.append(paired)

    analysis.mkdir(parents=True, exist_ok=True)
    for name, rows in (("sequential", sequential_rows), ("loads", load_rows),
                       ("load-latencies", load_latencies), ("load-query-coverage", query_coverage),
                       ("memory", memory_rows), ("paired", paired_rows)):
        save_csv(analysis / f"{name}.csv", rows)
    totals = {
        "Reports": len(reports),
        "OracleTraces": sum(r["OracleChecks"] for _, _, r in reports),
        "SequentialMutations": sum(len(run["Mutations"]) for _, _, r in reports for run in r["Sequential"]),
        "SequentialQueries": sum(len(run["Queries"]) for _, _, r in reports for run in r["Sequential"]),
        "LoadedRequests": sum(len(run["Requests"]) for _, _, r in reports for run in r["Loads"]),
        "RetentionSamples": sum(len(r["Memory"]) for _, _, r in reports),
    }
    summary = dict(Totals=totals, AnalyzerSHA256=digest(Path(__file__)),
                   Reports={f"{f}-{d}": digest(output / f"{f}-{d}.json") for f, d, _ in reports},
                   Sequential=sequential_rows, Paired=paired_rows, Loads=load_rows,
                   LoadLatencies=load_latencies, QueryCoverage=query_coverage, Memory=memory_rows)
    (analysis / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(totals, indent=2))


if __name__ == "__main__":
    main()
