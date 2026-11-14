param([string] $OutputDirectory = 'TestResults\LuceneTerms')

$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path "$PSScriptRoot\..\..")
$output = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory)

function Median($values) {
    $ordered = @($values | Sort-Object)
    if ($ordered.Count % 2 -eq 1) { return $ordered[[int][Math]::Floor($ordered.Count / 2)] }
    return ($ordered[$ordered.Count / 2 - 1] + $ordered[$ordered.Count / 2]) / 2
}

# Verify the actual measured artifacts before deriving medians. A report referring to
# changed sources/binaries must not silently become evidence for the current checkout.
$summary = @(
    foreach ($framework in @('net8.0', 'net9.0')) {
        $reports = @(
            foreach ($direction in @('forward', 'reverse')) {
                $report = Get-Content "$output\$framework-$direction.json" -Raw | ConvertFrom-Json
                if ($report.Samples.Count -ne 280 -or $report.RetainedOutputs.Count -ne 45 -or
                    $report.VerifiedInputs -ne 2013 -or $report.Reverse -ne ($direction -eq 'reverse')) {
                    throw "Incomplete evidence: $framework $direction"
                }
                foreach ($source in $report.Sources) {
                    if ((Get-FileHash $source.Path -Algorithm SHA256).Hash -ne $source.Sha256) {
                        throw "Source hash mismatch: $($source.Path)"
                    }
                }
                $bin = Join-Path $PSScriptRoot "bin\Release\$framework"
                foreach ($assembly in $report.Assemblies) {
                    if ((Get-FileHash "$bin\$($assembly.Name)" -Algorithm SHA256).Hash -ne $assembly.Sha256) {
                        throw "Assembly hash mismatch: $($assembly.Name)"
                    }
                }
                $report
            }
        )
        foreach ($group in ($reports.Samples | Group-Object Fixture, Method)) {
            [pscustomobject]@{
                Framework = $framework
                Fixture = $group.Group[0].Fixture
                Method = $group.Group[0].Method
                Samples = $group.Count
                MedianBytes = Median $group.Group.Bytes
                MedianNanoseconds = Median $group.Group.Nanoseconds
            }
        }
        foreach ($group in ($reports.RetainedOutputs | Group-Object Fixture, Method)) {
            [pscustomobject]@{
                Framework = $framework
                Fixture = $group.Group[0].Fixture
                Method = $group.Group[0].Method
                Samples = $group.Count
                RetainedResultCount = 256
                MedianLiveOutputBytes = Median $group.Group.LiveBytes
            }
        }
    }
)
$summary | ConvertTo-Json -Depth 5 | Set-Content "$output\summary.json"
$summary | Where-Object { $_.PSObject.Properties.Name -contains 'MedianBytes' } |
    Export-Csv "$output\tokenization.csv" -NoTypeInformation
$summary | ForEach-Object { $_ | ConvertTo-Json -Compress }
Write-Output 'Verified four reports: 1,120 timed samples and 180 retained-output heap samples.'
