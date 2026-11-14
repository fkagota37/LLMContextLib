# Copyright (c) 2026 felix kagota
# Author: felix kagota (felixkagota@gmail.com)
# SPDX-License-Identifier: MIT
# Experimental work in progress; not production-ready. No stable release/API guarantees.

param([string] $OutputDirectory = 'TestResults\DeferredIndexing\Final')

$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path "$PSScriptRoot\..\..")
$output = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory)

function Median($values) {
    $sorted = @($values | Sort-Object)
    if ($sorted.Count % 2 -eq 1) { return $sorted[[int][Math]::Floor($sorted.Count / 2)] }
    return ($sorted[$sorted.Count / 2 - 1] + $sorted[$sorted.Count / 2]) / 2
}
function PercentileUs($values, $p, $frequency) {
    $sorted = @($values | Sort-Object)
    return $sorted[[int][Math]::Ceiling($p * $sorted.Count) - 1] * 1000000.0 / $frequency
}

$summary = @(
    foreach ($framework in @('net8.0', 'net9.0')) {
        $reports = @(
            foreach ($direction in @('forward', 'reverse')) {
                $report = Get-Content "$output\$framework-$direction.json" -Raw | ConvertFrom-Json
                if ($report.Reports.Mutations.Count -ne 672 -or $report.Reports.Queries.Count -ne 54 -or
                    $report.Reports.Reverse -ne ($direction -eq 'reverse')) { throw 'Incomplete experiment evidence.' }
                foreach ($source in $report.SourceHashes.PSObject.Properties) {
                    if ((Get-FileHash $source.Name -Algorithm SHA256).Hash -ne $source.Value) {
                        throw "Source hash mismatch: $($source.Name)"
                    }
                }
                foreach ($assembly in $report.Reports.Assemblies) {
                    $path = Join-Path $PSScriptRoot "bin\Release\$framework\$($assembly.Name)"
                    if ((Get-FileHash $path -Algorithm SHA256).Hash -ne $assembly.Sha256) {
                        throw "Assembly hash mismatch: $path"
                    }
                }
                foreach ($sample in $report.Reports.Queries) {
                    if ($sample.RawTicks.Count -ne 32 -or $sample.RawBytes.Count -ne 32) {
                        throw 'Incomplete query trace.'
                    }
                }
                $report
            }
        )
        if ($reports[0].Frequency -ne $reports[1].Frequency) { throw 'Mixed stopwatch frequencies.' }
        foreach ($group in ($reports.Reports.Mutations | Group-Object Profile, Operation, Policy)) {
            if ($group.Count -ne 112) { throw 'Incomplete mutation group.' }
            [pscustomobject]@{
                Framework = $framework; Kind = 'Mutation'; Profile = $group.Group[0].Profile
                Operation = $group.Group[0].Operation; Policy = $group.Group[0].Policy; Samples = $group.Count
                P50ApplyUs = PercentileUs $group.Group.ApplyTicks .50 $reports[0].Frequency
                P95ApplyUs = PercentileUs $group.Group.ApplyTicks .95 $reports[0].Frequency
                P99ApplyUs = PercentileUs $group.Group.ApplyTicks .99 $reports[0].Frequency
                P50CompleteUs = PercentileUs $group.Group.CompleteTicks .50 $reports[0].Frequency
                P95CompleteUs = PercentileUs $group.Group.CompleteTicks .95 $reports[0].Frequency
                MedianCallerBytes = Median $group.Group.CallerBytes
                MedianProcessBytesThroughCompletion = Median $group.Group.ProcessBytesThroughCompletion
                MaximumObservedWorkBytes = ($group.Group.ObservedWorkBytes | Measure-Object -Maximum).Maximum
                MedianFinalActiveBytes = Median $group.Group.FinalActiveBytes
            }
        }
        foreach ($group in ($reports.Reports.Queries | Group-Object Profile, Policy, Stage)) {
            $ticks = @($group.Group | ForEach-Object { $_.RawTicks })
            $bytes = @($group.Group | ForEach-Object { $_.RawBytes })
            if ($ticks.Count -ne 192) { throw 'Incomplete query group.' }
            [pscustomobject]@{
                Framework = $framework; Kind = 'Query'; Profile = $group.Group[0].Profile
                Policy = $group.Group[0].Policy; Stage = $group.Group[0].Stage; Samples = $ticks.Count
                P50Us = PercentileUs $ticks .50 $reports[0].Frequency
                P95Us = PercentileUs $ticks .95 $reports[0].Frequency
                P99Us = PercentileUs $ticks .99 $reports[0].Frequency
                MedianBytes = Median $bytes
                PendingEntries = $group.Group[0].PendingEntries; ExpectedHits = $group.Group[0].ExpectedHits
                ReservedWorkBytes = Median $group.Group.ReservedWorkBytes
                MedianObservedActiveBytes = Median $group.Group.ObservedActiveBytes
                MedianObservedRetainedBytes = Median $group.Group.ObservedRetainedBytes
            }
        }
    }
)
$summary | ConvertTo-Json -Depth 5 | Set-Content "$output\summary.json"
$summary | Where-Object Kind -eq 'Mutation' | Export-Csv "$output\mutations.csv" -NoTypeInformation
$summary | Where-Object Kind -eq 'Query' | Export-Csv "$output\queries.csv" -NoTypeInformation
$summary | ForEach-Object { $_ | ConvertTo-Json -Compress }
Write-Output 'Verified four reports: 2688 public mutation calls and 6912 individually timed queries.'
