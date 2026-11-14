# Copyright (c) 2026 felix kagota
# Author: felix kagota (felixkagota@gmail.com)
# SPDX-License-Identifier: MIT
# Experimental work in progress; not production-ready. No stable release/API guarantees.

"""Verify producer-write evidence and preserve paired preparation/apply/pipeline metrics."""

import argparse
import json
from collections import defaultdict
from pathlib import Path

from Analyze import ROOT, check, digest, latency, median, save_csv


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--analysis-output", help="Separate derived output directory when existing CSVs are open.")
    parser.add_argument("--source-root", help="Archived measured source tree; default is the checkout.")
    parser.add_argument("--binary-root", help="Archived root containing net8.0/net9.0 DLL directories.")
    args = parser.parse_args()
    output = (ROOT / args.output).resolve()
    analysis = (ROOT / args.analysis_output).resolve() if args.analysis_output else output
    source_root = (ROOT / args.source_root).resolve() if args.source_root else ROOT
    binary_root = (ROOT / args.binary_root).resolve() if args.binary_root else Path(__file__).parent / "bin" / "Release"
    groups = defaultdict(list)
    sources = None
    reports = {}
    for framework in ("net8.0", "net9.0"):
        assemblies = None
        for direction in ("forward", "reverse"):
            path = output / f"{framework}-{direction}.json"
            report = json.loads(path.read_text(encoding="utf-8-sig"))
            check(report["Mode"] == "ProducerWrites" and len(report["Runs"]) == 24, "Wrong experiment matrix.")
            check(report["Reverse"] == (direction == "reverse"), "Wrong order.")
            check(sources is None or sources == report["SourceHashes"], "Mixed sources.")
            check(assemblies is None or assemblies == report["AssemblyHashes"], "Mixed runtime binaries.")
            sources, assemblies = report["SourceHashes"], report["AssemblyHashes"]
            for name, sha in sources.items():
                check(digest(source_root / name) == sha, f"Source mismatch: {name}")
            for name, sha in assemblies.items():
                check(digest(binary_root / framework / name) == sha, f"Binary mismatch: {name}")
            for run in report["Runs"]:
                check(len(run["Samples"]) == report["Calls"], "Incomplete samples.")
                check(run["Position"] == int((run["Policy"] == "NativeText") == report["Reverse"]), "Wrong pair order.")
                check(all(s["PipelineTicks"] >= s["PrepareTicks"] + s["ApplyTicks"] for s in run["Samples"]),
                      "Invalid pipeline timing.")
                key = (framework, run["Profile"], run["Reuse"], run["Operation"], run["Policy"])
                groups[key].append((report, run))
            reports[path.name] = digest(path)
    rows = []
    for key, pairs in sorted(groups.items()):
        check(len(pairs) == 2, "Unpaired producer result.")
        samples = [sample for _, run in pairs for sample in run["Samples"]]
        row = dict(zip(("Framework", "Profile", "Reuse", "Operation", "Policy"), key))
        row["Samples"] = len(samples)
        for scope in ("Prepare", "Apply", "Pipeline"):
            row.update(latency(samples, scope + "Ticks", pairs[0][0]["Frequency"], scope))
        row.update(PrepareBytes=median(samples, "PrepareBytes"), ApplyBytes=median(samples, "ApplyBytes"),
                   PipelineBytes=median([dict(Bytes=s["PrepareBytes"] + s["ApplyBytes"]) for s in samples], "Bytes"))
        rows.append(row)
    summary = dict(Reports=reports, AnalyzerSHA256=digest(Path(__file__)),
                   SharedAnalyzerSHA256=digest(Path(__file__).with_name("Analyze.py")),
                   TimedWrites=sum(row["Samples"] for row in rows), Results=rows)
    analysis.mkdir(parents=True, exist_ok=True)
    save_csv(analysis / "producer-writes.csv", rows)
    (analysis / "producer-summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(dict(Reports=len(reports), TimedWrites=summary["TimedWrites"]), indent=2))


if __name__ == "__main__":
    main()
