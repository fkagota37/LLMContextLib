param(
    [Parameter(Mandatory)] [string] $Dotnet,
    [Parameter(Mandatory)] [string] $ReferenceAssembly
)

$ErrorActionPreference = 'Stop'

function Read-Reply($Lines, [string] $Label) {
    $matches = @($Lines | Where-Object { $_.StartsWith($Label, [StringComparison]::Ordinal) })
    if ($matches.Count -ne 1) { throw "Expected one reply with label '$Label'." }
    return ($matches[0].Substring($Label.Length) | ConvertFrom-Json -AsHashtable)
}

function Normalize-Example($Lines) {
    $navigation = Read-Reply $Lines 'Navigation result: '
    $passage = Read-Reply $Lines 'Source passage: '
    $search = Read-Reply $Lines 'Chat-selected search result: '
    $sessionId = [guid]::ParseExact($navigation.sessionId, 'D')
    if ([guid]::ParseExact($passage.sessionId, 'D') -ne $sessionId -or
        [guid]::ParseExact($search.sessionId, 'D') -ne $sessionId) { throw 'Replies refer to different sessions.' }

    $anchors = @{}
    $previousAnchor = $null
    foreach ($item in $navigation.items) {
        $id = [guid]::ParseExact($item.anchorId, 'D')
        if ($null -ne $previousAnchor -and $id.CompareTo($previousAnchor) -le 0) { throw 'Navigation order is not canonical.' }
        $previousAnchor = $id
        $anchors.Add($id, $item.title)
        $item.anchorId = $item.title
    }
    # The source and port generate different GUIDs, so their valid navigation order can differ.
    $navigation.items = @($navigation.items | Sort-Object { $_.title })
    $entries = @{}
    $calls = [ordered]@{}
    foreach ($entry in $passage.items) {
        $entries.Add([guid]::ParseExact($entry.entryId, 'D'), $entry.sequence)
        $entry.entryId = $entry.sequence
        if ([string]$entry.text -cmatch '^(?:build-profiler )?([0-9a-f]{32}) \{') {
            $id = $Matches[1]
            if (!$calls.Contains($id)) { $calls.Add($id, "call-$($calls.Count + 1)") }
        }
    }

    foreach ($item in $search.items) {
        $entryId = [guid]::ParseExact($item.entryId, 'D')
        if (!$entries.ContainsKey($entryId) -or $entries[$entryId] -ne $item.sequence) { throw 'Search did not preserve the source entry identity.' }
        $item.entryId = $entries[$entryId]
        if ($null -ne $item.anchorId) {
            $anchorId = [guid]::ParseExact($item.anchorId, 'D')
            if (!$anchors.ContainsKey($anchorId)) { throw 'Search returned an unknown anchor.' }
            $item.anchorId = $anchors[$anchorId]
        }
    }
    foreach ($reply in @($navigation, $passage, $search)) { $reply.sessionId = 'investigation' }
    $labels = 'Navigation result: ', 'Source passage: ', 'Chat-selected search result: '
    $summary = @($Lines | Where-Object {
        $line = $_
        $line -ne '' -and !($labels | Where-Object { $line.StartsWith($_, [StringComparison]::Ordinal) })
    })
    $result = ConvertTo-Json -InputObject @($summary, $navigation, $passage, $search) -Depth 20 -Compress
    foreach ($id in $calls.Keys) { $result = $result.Replace($id, $calls[$id]) }
    return $result
}

$reference = & $Dotnet $ReferenceAssembly
if ($LASTEXITCODE) { throw "Reference example failed: $LASTEXITCODE." }
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    $target = npm exec --yes --package=node@22 -- node .\node_modules\tsx\dist\cli.mjs .\examples\BuildInvestigation\program.ts
    if ($LASTEXITCODE) { throw "TypeScript example failed: $LASTEXITCODE." }
} finally {
    Pop-Location
}

$expected = Normalize-Example $reference
$actual = Normalize-Example $target
if ($actual -cne $expected) {
    throw "Example differential mismatch.`nReference: $expected`nTypeScript: $actual"
}
Write-Output 'BuildInvestigation: normalized navigation, source passage, search and summary match.'
