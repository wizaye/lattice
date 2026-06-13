param(
    [Parameter(Mandatory = $true)]
    [string]$Path
)

# Recover a quartz.config.yaml that was corrupted by the $indent
# named-capture bug.  The bug stripped both the indent and the key
# name from any line that the theme patcher touched, producing
# lines like `: My BookWorm` instead of `  pageTitle: My BookWorm`.
#
# Strategy: walk top-to-bottom.  Bare `:` lines under `configuration:`
# (before any nested block) map in order to:
#   pageTitle, pageTitleSuffix, enableSPA, enablePopovers
# Bare `:` lines under `typography:` map in order to:
#   header, body, code
# Other bare `:` lines are left alone (shouldn't happen with the
# current patcher set).

if (-not (Test-Path -LiteralPath $Path)) {
    Write-Error "File not found: $Path"
    exit 1
}

$lines = Get-Content -LiteralPath $Path
$rootKeys = @('pageTitle', 'pageTitleSuffix', 'enableSPA', 'enablePopovers')
$typoKeys = @('header', 'body', 'code')
$rootIdx = 0
$typoIdx = 0
$inTypo = $false
$out = New-Object System.Collections.Generic.List[string]
foreach ($line in $lines) {
    if ($line -match '^\s+typography:\s*$') {
        $inTypo = $true
        $typoIdx = 0
        $out.Add($line)
        continue
    }
    if ($line -match '^\s+colors:\s*$') {
        $inTypo = $false
        $out.Add($line)
        continue
    }
    if ($line -match '^:\s*(.*)$') {
        $val = $Matches[1]
        if ($inTypo) {
            if ($typoIdx -lt $typoKeys.Count) {
                $out.Add(('      {0}: {1}' -f $typoKeys[$typoIdx], $val))
                $typoIdx++
            } else { $out.Add($line) }
        } else {
            if ($rootIdx -lt $rootKeys.Count) {
                $out.Add(('  {0}: {1}' -f $rootKeys[$rootIdx], $val))
                $rootIdx++
            } else { $out.Add($line) }
        }
    } else {
        $out.Add($line)
    }
}

Copy-Item -LiteralPath $Path -Destination ($Path + '.broken-by-indent-bug') -Force
Set-Content -LiteralPath $Path -Value ($out -join "`n") -NoNewline -Encoding utf8

# Drop a pristine snapshot so the new ensure_quartz_config_intact()
# helper has something to restore from on future corruption.
$origBackup = $Path + '.lattice-orig'
if (-not (Test-Path -LiteralPath $origBackup)) {
    Copy-Item -LiteralPath $Path -Destination $origBackup -Force
    Write-Host "Wrote $origBackup"
}

Write-Host "Reconstructed. First 25 lines:"
Get-Content -LiteralPath $Path -TotalCount 25
