param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Set-Location $RepoRoot

function Write-Utf8NoBomLf {
  param(
    [Parameter(Mandatory=$true)][string]$Path,
    [Parameter(Mandatory=$true)][AllowEmptyString()][string]$Text
  )

  $dir = Split-Path -Parent $Path
  if($dir -and -not (Test-Path -LiteralPath $dir)){
    New-Item -ItemType Directory -Force $dir | Out-Null
  }

  $t = $Text -replace "`r`n","`n"
  $t = $t -replace "`r","`n"

  if(-not $t.EndsWith("`n")){
    $t += "`n"
  }

  [System.IO.File]::WriteAllText($Path,$t,(New-Object System.Text.UTF8Encoding($false)))
}

function Sha256File {
  param([Parameter(Mandatory=$true)][string]$Path)

  $sha = [Security.Cryptography.SHA256]::Create()

  try {
    $fs = [System.IO.File]::OpenRead($Path)

    try {
      return ([BitConverter]::ToString($sha.ComputeHash($fs))).Replace('-','').ToLowerInvariant()
    } finally {
      $fs.Dispose()
    }
  } finally {
    $sha.Dispose()
  }
}

$Stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd_HHmmssZ')
$ProofDir = Join-Path $RepoRoot ('proofs\receipts\v011_innerhtml_audit_' + $Stamp)

New-Item -ItemType Directory -Force $ProofDir | Out-Null

$Targets = @()

foreach($p in @(
  'ui\popup.js',
  'adapters\firefox\ui\popup.js',
  'adapters\brave\ui\popup.js',
  'adapters\edge\ui\popup.js',
  'adapters\opera\ui\popup.js',
  'adapters\chromium\brave\ui\popup.js',
  'adapters\chromium\edge\ui\popup.js',
  'adapters\chromium\opera\ui\popup.js'
)){
  $full = Join-Path $RepoRoot $p

  if(Test-Path -LiteralPath $full -PathType Leaf){
    $Targets += $full
  }
}

$Results = @()

foreach($file in $Targets){
  $lines = Get-Content -LiteralPath $file

  for($i = 0; $i -lt $lines.Count; $i++){
    $line = $lines[$i]

    if($line -match '\.innerHTML\s*='){
      $start = [Math]::Max(0, $i - 5)
      $end = [Math]::Min($lines.Count - 1, $i + 8)

      $Results += [ordered]@{
        file = $file
        file_sha256 = Sha256File $file
        line = $i + 1
        text = $line.Trim()
        context_start = $start + 1
        context_end = $end + 1
        context = ($lines[$start..$end] -join "`n")
        status = 'INNERHTML_ASSIGNMENT_FOUND'
      }
    }
  }
}

$Report = [ordered]@{
  schema = 'cookiegate.v011.innerhtml_audit.report.v1'
  stamp_utc = $Stamp
  status = 'COOKIEGATE_V011_INNERHTML_AUDIT_OK'
  repo_root = $RepoRoot
  target_count = @($Targets).Count
  finding_count = @($Results).Count
  findings = $Results
}

$ReportPath = Join-Path $ProofDir 'innerhtml_audit_report.json'
Write-Utf8NoBomLf $ReportPath ($Report | ConvertTo-Json -Depth 30)

Write-Host 'COOKIEGATE_V011_INNERHTML_AUDIT_OK' -ForegroundColor Green
Write-Host ('TARGETS: ' + @($Targets).Count) -ForegroundColor Green
Write-Host ('FINDINGS: ' + @($Results).Count) -ForegroundColor Green
Write-Host ('REPORT: ' + $ReportPath) -ForegroundColor Green
