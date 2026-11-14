# Copyright (c) 2026 felix kagota
# Author: felix kagota (felixkagota@gmail.com)
# SPDX-License-Identifier: MIT
# Experimental work in progress; not production-ready. No stable release/API guarantees.

param([string] $OutputDirectory = 'TestResults\BitFasterTerms')

$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path "$PSScriptRoot\..\..")
$output = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory)
function Median($values) {
    $ordered = @($values | Sort-Object)
    if ($ordered.Count % 2 -eq 1) { return $ordered[[int][Math]::Floor($ordered.Count / 2)] }
    return ($ordered[$ordered.Count / 2 - 1] + $ordered[$ordered.Count / 2]) / 2
}
function Percentile($values, $p, $frequency) {
    $ordered = @($values | Sort-Object)
    return $ordered[[int][Math]::Ceiling($p * $ordered.Count) - 1] * 1000000000.0 / $frequency
}

$summary = @(
    foreach ($framework in @('net8.0', 'net9.0')) {
        $reports = @(
            foreach ($direction in @('forward', 'reverse')) {
                $report = Get-Content "$output\$framework-$direction.json" -Raw | ConvertFrom-Json
                if ($report.Samples.Count -ne 231 -or $report.Retention.Count -ne 27 -or
                    $report.VerifiedInputs -ne 263 -or $report.Reverse -ne ($direction -eq 'reverse')) {
                    throw "Incomplete evidence: $framework $direction"
                }
                foreach ($source in $report.Sources) {
                    if ((Get-FileHash $source.Path -Algorithm SHA256).Hash -ne $source.Sha256) {
                        throw "Source hash mismatch: $($source.Path)"
                    }
                }
                foreach ($assembly in $report.Assemblies) {
                    $path = Join-Path $PSScriptRoot "bin\Release\$framework\$($assembly.Name)"
                    if ((Get-FileHash $path -Algorithm SHA256).Hash -ne $assembly.Sha256) {
                        throw "Assembly hash mismatch: $path"
                    }
                }
                foreach ($sample in $report.Samples) {
                    if ($sample.RawLatencyTicks.Count -ne 512 -or $sample.Footprint.Count -gt 64) {
                        throw 'Incomplete latency trace or settled capacity violation.'
                    }
                }
                $report
            }
        )
        foreach ($group in ($reports.Samples | Group-Object Profile, Scenario, Policy)) {
            # Pool RAW per-call samples, not medians or round-level percentiles.
            $ticks = @($group.Group | ForEach-Object { $_.RawLatencyTicks })
            [pscustomobject]@{
                Framework = $framework; Profile = $group.Group[0].Profile
                Scenario = $group.Group[0].Scenario; Policy = $group.Group[0].Policy
                BatchSamples = $group.Count; LatencySamples = $ticks.Count
                MedianBatchAverageNs = Median $group.Group.AverageNanoseconds
                MedianBytesPerCall = Median $group.Group.Bytes
                InstrumentedP50Ns = Percentile $ticks .50 $reports[0].Frequency
                InstrumentedP95Ns = Percentile $ticks .95 $reports[0].Frequency
                InstrumentedP99Ns = Percentile $ticks .99 $reports[0].Frequency
                Computations = ($group.Group.BatchComputations | Measure-Object -Sum).Sum
                LatencyComputations = ($group.Group.LatencyComputations | Measure-Object -Sum).Sum
                Requests = $group.Count * 512
                MaxObservedEndCount = ($group.Group.CountBeforeMaintenance | Measure-Object -Maximum).Maximum
                MaxSettledCount = ($group.Group | ForEach-Object { $_.Footprint.Count } |
                    Measure-Object -Maximum).Maximum
            }
        }
        foreach ($group in ($reports.Retention | Group-Object Profile, Policy)) {
            [pscustomobject]@{
                Framework = $framework; Profile = $group.Group[0].Profile
                Policy = $group.Group[0].Policy; HeapSamples = $group.Count
                MedianLiveBytes = Median $group.Group.LiveBytes
                MedianDisposedBytes = Median $group.Group.DisposedBytes
                SettledCount = $group.Group[0].Footprint.Count
                EstimatedKeys = Median $group.Group.Footprint.EstimatedKeyBytes
                EstimatedMemberships = Median $group.Group.Footprint.EstimatedMembershipBytes
            }
        }
    }
)
$summary | ConvertTo-Json -Depth 5 | Set-Content "$output\summary.json"
$summary | Where-Object { $_.PSObject.Properties.Name -contains 'BatchSamples' } |
    Export-Csv "$output\timing.csv" -NoTypeInformation
$summary | ForEach-Object { $_ | ConvertTo-Json -Compress }
Write-Output 'Verified four reports: 924 batch samples, 473088 individually timed calls, 108 heap samples.'
