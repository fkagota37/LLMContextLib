# Copyright (c) 2026 felix kagota
# Author: felix kagota (felixkagota@gmail.com)
# SPDX-License-Identifier: MIT
# Experimental work in progress; not production-ready. No stable release/API guarantees.

param(
    [Parameter(Mandatory = $true)][string] $OutputDirectory,
    [ValidateRange(16, 512)][int] $Calls = 128,
    [switch] $ProducerWrites,
    [switch] $NoRestore
)

$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path "$PSScriptRoot\..\..")
$output = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory)
if (Test-Path $output) { throw 'Use a new output directory; previous evidence is never overwritten.' }
if (-not $NoRestore) {
    dotnet restore "$PSScriptRoot\LLMContextLib.StrategyBenchmarks.csproj" --locked-mode
    if ($LASTEXITCODE -ne 0) { throw 'Locked restore failed.' }
}
dotnet build "$PSScriptRoot\LLMContextLib.StrategyBenchmarks.csproj" -c Release -m:1 --no-restore
if ($LASTEXITCODE -ne 0) { throw 'Benchmark build failed.' }
New-Item -ItemType Directory -Path $output | Out-Null
dotnet --info | Set-Content (Join-Path $output 'dotnet-info.txt')
foreach ($item in @(@('net8.0', 'forward'), @('net9.0', 'forward'),
    @('net9.0', 'reverse'), @('net8.0', 'reverse'))) {
    $framework = $item[0]
    $direction = $item[1]
    $name = "$framework-$direction"
    $arguments = @("$PSScriptRoot\bin\Release\$framework\LLMContextLib.StrategyBenchmarks.dll",
        '--calls', "$Calls", '--output', (Join-Path $output "$name.json"))
    if ($direction -eq 'reverse') { $arguments += '--reverse' }
    if ($ProducerWrites) { $arguments += '--producer-writes' }
    Write-Output "Starting $name"
    & dotnet @arguments *> (Join-Path $output "$name.log")
    if ($LASTEXITCODE -ne 0) {
        Get-Content (Join-Path $output "$name.log") -Tail 30
        throw "Run $name failed with $LASTEXITCODE."
    }
    Write-Output "$name PASS"
}
$analyzer = if ($ProducerWrites) { 'Analyze-ProducerWrites.py' } else { 'Analyze.py' }
python (Join-Path $PSScriptRoot $analyzer) --output $output
if ($LASTEXITCODE -ne 0) { throw 'Evidence verification failed.' }
