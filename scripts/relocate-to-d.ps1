# Relocate the Harness skill store to another drive by junction.
#
# Why not customSkillDirs: in the web bundle the global `skill-filesystem` row is
# disabled and every agent preset mounts its own provider, so a profile override
# of the global row changes nothing. A junction keeps every scanned path intact
# while the bytes live elsewhere.
#
# Usage (PowerShell, no admin needed for junctions):
#   .\scripts\relocate-to-d.ps1
#   .\scripts\relocate-to-d.ps1 -Target 'E:\dsh\skills'
#
# The script is idempotent: it moves existing skill folders, then replaces the
# scanned directory with a junction. Re-running on an existing junction only
# reports the current state.

[CmdletBinding()]
param(
    [string]$Target = 'D:\dsh\skills',
    [string]$Link = (Join-Path $env:USERPROFILE '.agents\skills')
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) { Write-Host "[relocate] $Message" }

if (-not (Test-Path -LiteralPath $Target)) {
    New-Item -ItemType Directory -Force -Path $Target | Out-Null
    Write-Step "created target $Target"
}

$existing = Get-Item -LiteralPath $Link -ErrorAction SilentlyContinue
if ($existing -and $existing.LinkType -eq 'Junction') {
    $current = @($existing.Target)[0]
    if ($current -eq $Target) {
        Write-Step "already a junction to $Target - nothing to do"
        exit 0
    }
    throw "refusing to touch $Link : it is a junction to $current, not $Target"
}

if ($existing) {
    $entries = Get-ChildItem -LiteralPath $Link -Force
    foreach ($entry in $entries) {
        $destination = Join-Path $Target $entry.Name
        if (Test-Path -LiteralPath $destination) {
            Write-Step "skip $($entry.Name) - already present at $destination"
            continue
        }
        Move-Item -LiteralPath $entry.FullName -Destination $destination
        Write-Step "moved $($entry.Name)"
    }
    $leftover = Get-ChildItem -LiteralPath $Link -Force
    if ($leftover.Count -gt 0) {
        throw "$Link still has $($leftover.Count) entries; refusing to replace it with a junction"
    }
    Remove-Item -LiteralPath $Link -Force
    Write-Step "removed empty $Link"
}

New-Item -ItemType Junction -Path $Link -Target $Target | Out-Null
Write-Step "linked $Link -> $Target"

Write-Host ''
Write-Host 'Keep the manager writing to the same place by adding this to the profile patch:'
Write-Host ''
Write-Host '  - id: skill-mcp-manager'
Write-Host '    config:'
Write-Host "      installRoot: '$Target'"
Write-Host "      mcpRoot: '$(Split-Path -Parent $Target)\mcp'"
