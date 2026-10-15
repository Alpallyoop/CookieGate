$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $RepoRoot

$DistRoot = Join-Path $RepoRoot "dist"
$AuditParent = Join-Path $RepoRoot "proofs\audits"

if (!(Test-Path -LiteralPath $DistRoot)) { throw "DIST_ROOT_MISSING: $DistRoot" }

$Stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$AuditRoot = Join-Path $AuditParent "cookiegate_domain_ops_replacement_boundary_audit_v2_$Stamp"
New-Item -ItemType Directory -Force -Path $AuditRoot | Out-Null

function Write-Utf8NoBomLf {
  param(
    [Parameter(Mandatory=$true)][string]$Path,
    [Parameter(Mandatory=$true)][AllowEmptyString()][string]$Text
  )
  $enc = [System.Text.UTF8Encoding]::new($false)
  $normalized = (($Text -replace "`r`n","`n") -replace "`r","`n")
  [System.IO.File]::WriteAllText($Path, $normalized + "`n", $enc)
}

function Write-JsonFile {
  param(
    [Parameter(Mandatory=$true)][string]$Path,
    [Parameter(Mandatory=$true)]$Object
  )
  $json = $Object | ConvertTo-Json -Depth 100
  if ($null -eq $json) { $json = "null" }
  Write-Utf8NoBomLf -Path $Path -Text $json
}

function Read-LinesSafe {
  param([Parameter(Mandatory=$true)][string]$Path)
  if (!(Test-Path -LiteralPath $Path)) { return @("") }
  $lines = [System.IO.File]::ReadAllLines($Path)
  if ($null -eq $lines -or $lines.Count -lt 1) { return @("") }
  return @($lines)
}

function Count-Regex {
  param(
    [AllowEmptyString()][string]$Text,
    [Parameter(Mandatory=$true)][string]$Pattern
  )
  if ($null -eq $Text) { $Text = "" }
  return ([regex]::Matches($Text, $Pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)).Count
}

function Find-LineRows {
  param(
    $Lines,
    [Parameter(Mandatory=$true)][string]$Pattern
  )
  $safe = @($Lines)
  if ($safe.Count -lt 1) { $safe = @("") }

  $rows = @()
  for ($i = 0; $i -lt $safe.Count; $i++) {
    $line = [string]$safe[$i]
    if ($line -match $Pattern) {
      $rows += [pscustomobject]@{
        line = $i + 1
        text = $line.Trim()
      }
    }
  }
  return @($rows)
}

function Slice-Lines {
  param(
    $Lines,
    [int]$Line,
    [int]$Before = 22,
    [int]$After = 45
  )
  $safe = @($Lines)
  if ($safe.Count -lt 1) { $safe = @("") }
  if ($Line -lt 1) { return "" }

  $start = [Math]::Max(1, $Line - $Before)
  $end = [Math]::Min($safe.Count, $Line + $After)

  $out = New-Object System.Collections.Generic.List[string]
  for ($i = $start; $i -le $end; $i++) {
    $out.Add(("{0,6}: {1}" -f $i, [string]$safe[$i - 1]))
  }
  return ($out -join "`n")
}

function Find-OwnerStart {
  param(
    $Lines,
    [int]$HitLine
  )

  $safe = @($Lines)
  if ($safe.Count -lt 1) { return 1 }

  $patterns = @(
    '^\s*async\s+function\s+[A-Za-z0-9_$]+\s*\(',
    '^\s*function\s+[A-Za-z0-9_$]+\s*\(',
    '^\s*const\s+[A-Za-z0-9_$]+\s*=\s*(async\s*)?\(',
    '^\s*let\s+[A-Za-z0-9_$]+\s*=\s*(async\s*)?\(',
    '^\s*var\s+[A-Za-z0-9_$]+\s*=\s*(async\s*)?\(',
    '^\s*document\.addEventListener\s*\(',
    '^\s*window\.addEventListener\s*\(',
    '^\s*chrome\.storage|^\s*browser\.storage'
  )

  for ($i = [Math]::Min($HitLine - 1, $safe.Count - 1); $i -ge 0; $i--) {
    $line = [string]$safe[$i]
    foreach ($p in $patterns) {
      if ($line -match $p) { return $i + 1 }
    }
  }

  return [Math]::Max(1, $HitLine - 35)
}

function Find-OwnerEnd {
  param(
    $Lines,
    [int]$StartLine
  )

  $safe = @($Lines)
  if ($safe.Count -lt 1) { return 1 }

  $depth = 0
  $seenOpen = $false
  $max = [Math]::Min($safe.Count, $StartLine + 240)

  for ($i = $StartLine - 1; $i -lt $max; $i++) {
    $line = [string]$safe[$i]

    foreach ($ch in $line.ToCharArray()) {
      if ($ch -eq '{') {
        $depth++
        $seenOpen = $true
      } elseif ($ch -eq '}') {
        if ($seenOpen) { $depth-- }
      }
    }

    if ($seenOpen -and $depth -le 0) { return $i + 1 }
  }

  return $max
}

function Get-OwnerBlock {
  param(
    $Lines,
    [int]$HitLine
  )

  $start = Find-OwnerStart -Lines $Lines -HitLine $HitLine
  $end = Find-OwnerEnd -Lines $Lines -StartLine $start

  return [pscustomobject]@{
    hit_line = $HitLine
    start_line = $start
    end_line = $end
    first_line = ([string]$Lines[$start - 1]).Trim()
    text = (Slice-Lines -Lines $Lines -Line $HitLine -Before ($HitLine - $start) -After ($end - $HitLine))
  }
}

$CleanBuild = Get-ChildItem -LiteralPath $DistRoot -Directory |
  Where-Object { $_.Name -like "v012_canonical_safe_recovery_v32_banner_suppression_metrics_domain_rules_*" } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if ($null -eq $CleanBuild) { throw "NO_V32_CLEAN_BASELINE_FOUND" }

$LatestBuild = Get-ChildItem -LiteralPath $DistRoot -Directory |
  Where-Object { $_.Name -like "v012_canonical_safe_recovery_v*" } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

$Targets = @(
  [pscustomobject]@{ role="clean_v32_baseline"; build=$CleanBuild },
  [pscustomobject]@{ role="latest_build"; build=$LatestBuild }
) | Where-Object { $null -ne $_.build } | Sort-Object role -Unique

$Patterns = [ordered]@{
  save_rule_button = 'Save rule'
  check_site_button = 'Check site'
  native_disabled_until_checked = 'disabled until checked'
  saved_rule_message = 'Saved rule for'
  native_empty_state = 'No domain rules yet'
  duplicate_empty_state = 'No domain rules saved'
  domain_rule_active_text = 'Domain rule active'
  mode_locked_text = 'Mode locked by rule'
  domain_ops_heading = 'Domain Ops'
  domain_tools_heading = 'Domain Tools'
  active_site_heading = 'Active Site'
  banner_title = 'Banner Suppression'
  banner_metric_this_site = 'this site now'
  banner_metric_session = 'this session'
  banner_metric_timeline = 'site timeline'
  banner_metric_lifetime = 'lifetime blocked'
  rule_key = 'cookiegate\.domainModeLocks\.v32'
  storage_get = 'storage\.local\.get|chrome\.storage\.local\.get|browser\.storage\.local\.get'
  storage_set = 'storage\.local\.set|chrome\.storage\.local\.set|browser\.storage\.local\.set'
  event_listener = 'addEventListener'
  mutation_observer = 'MutationObserver'
  insert_before = 'insertBefore'
  append_child = 'appendChild'
  active_true = 'active\s*[:=]\s*true'
  enabled_true = 'enabled\s*[:=]\s*true'
  disabled_false = 'disabled\s*[:=]\s*false'
  status_active = 'status\s*[:=]\s*["'']active["'']'
  lock_reason = 'Site Mode is disabled because this domain has an active Domain Ops rule'
  old_generated_patch = 'COOKIEGATE_V33|COOKIEGATE_V34|COOKIEGATE_V35|COOKIEGATE_V36|COOKIEGATE_V37|COOKIEGATE_V38|COOKIEGATE_V39|COOKIEGATE_V40|COOKIEGATE_V41|COOKIEGATE_V42|COOKIEGATE_V43'
  non_ascii = '[^\x09\x0A\x0D\x20-\x7E]'
}

$Reports = @()
$BoundaryRows = @()
$RiskRows = @()

foreach ($Target in $Targets) {
  $Build = $Target.build
  $PopupPath = Join-Path $Build.FullName "chrome\ui\popup.js"
  $PopupHtmlPath = Join-Path $Build.FullName "chrome\ui\popup.html"
  $ManifestPath = Join-Path $Build.FullName "chrome\manifest.json"

  if (!(Test-Path -LiteralPath $PopupPath)) { throw "POPUP_MISSING: $PopupPath" }

  $Text = Get-Content -LiteralPath $PopupPath -Raw
  if ($null -eq $Text) { $Text = "" }

  $Lines = @(Read-LinesSafe -Path $PopupPath)

  $Counts = [ordered]@{}
  foreach ($k in $Patterns.Keys) {
    $Counts[$k] = Count-Regex -Text $Text -Pattern $Patterns[$k]
  }

  $Hits = @()
  foreach ($k in $Patterns.Keys) {
    $rows = @(Find-LineRows -Lines $Lines -Pattern $Patterns[$k])
    foreach ($row in $rows) {
      $Hits += [pscustomobject]@{
        kind = $k
        line = $row.line
        text = $row.text
      }
    }
  }

  $BoundaryKinds = @(
    "save_rule_button",
    "check_site_button",
    "native_disabled_until_checked",
    "saved_rule_message",
    "domain_rule_active_text",
    "mode_locked_text",
    "rule_key",
    "storage_get",
    "storage_set",
    "event_listener"
  )

  $OwnerBlocks = @()
  foreach ($hit in ($Hits | Where-Object { $_.kind -in $BoundaryKinds } | Sort-Object line,kind -Unique)) {
    $block = Get-OwnerBlock -Lines $Lines -HitLine ([int]$hit.line)
    $OwnerBlocks += [pscustomobject]@{
      kind = $hit.kind
      hit_line = $hit.line
      owner_start = $block.start_line
      owner_end = $block.end_line
      first_line = $block.first_line
    }

    $BoundaryRows += [pscustomobject]@{
      role = $Target.role
      build = $Build.Name
      kind = $hit.kind
      hit_line = $hit.line
      owner_start = $block.start_line
      owner_end = $block.end_line
      first_line = $block.first_line
    }
  }

  $Risks = @()

  if ($Counts.banner_title -lt 1 -or $Counts.banner_metric_this_site -lt 1 -or $Counts.banner_metric_session -lt 1 -or $Counts.banner_metric_timeline -lt 1 -or $Counts.banner_metric_lifetime -lt 1) { $Risks += "BANNER_METRICS_BOUNDARY_MISSING" }
  if ($Counts.save_rule_button -lt 1) { $Risks += "SAVE_RULE_BOUNDARY_MISSING" }
  if ($Counts.rule_key -lt 1) { $Risks += "RULE_STORAGE_KEY_MISSING" }
  if ($Counts.native_disabled_until_checked -gt 0) { $Risks += "NATIVE_SAVE_WRITES_DISABLED_UNTIL_CHECKED" }
  if ($Counts.duplicate_empty_state -gt 0) { $Risks += "CUSTOM_DUPLICATE_EMPTY_STATE_PRESENT" }
  if ($Counts.old_generated_patch -gt 0) { $Risks += "OLD_GENERATED_PATCH_PRESENT" }
  if ($Counts.mutation_observer -gt 0) { $Risks += "MUTATION_OBSERVER_GLITCH_RISK" }
  if ($Counts.non_ascii -gt 0) { $Risks += "NON_ASCII_MOJIBAKE_RISK" }
  if ($Counts.active_true -lt 1 -or $Counts.enabled_true -lt 1 -or $Counts.disabled_false -lt 1 -or $Counts.status_active -lt 1) { $Risks += "ACTIVE_RECORD_FIELDS_NOT_PRESENT" }
  if ($Counts.lock_reason -lt 1) { $Risks += "LOCK_REASON_COPY_NOT_PRESENT" }

  foreach ($risk in $Risks) {
    $RiskRows += [pscustomobject]@{
      role = $Target.role
      build = $Build.Name
      risk = $risk
    }
  }

  $SafeName = ($Target.role + "_" + $Build.Name) -replace '[^A-Za-z0-9_.-]', '_'
  $SnippetPath = Join-Path $AuditRoot "$SafeName.boundary_snippets.txt"
  $DumpPath = Join-Path $AuditRoot "$SafeName.popup.full.js"

  $Snippet = New-Object System.Collections.Generic.List[string]
  $Snippet.Add("ROLE: $($Target.role)")
  $Snippet.Add("BUILD: $($Build.FullName)")
  $Snippet.Add("POPUP: $PopupPath")
  $Snippet.Add("")
  $Snippet.Add("COUNTS")
  foreach ($k in $Counts.Keys) {
    $Snippet.Add(("  {0}: {1}" -f $k, $Counts[$k]))
  }
  $Snippet.Add("")
  $Snippet.Add("BOUNDARY OWNER BLOCKS")
  foreach ($block in ($OwnerBlocks | Sort-Object owner_start,owner_end,kind -Unique)) {
    $Snippet.Add("")
    $Snippet.Add("===== $($block.kind) :: hit $($block.hit_line) :: owner $($block.owner_start)-$($block.owner_end) =====")
    $Snippet.Add((Slice-Lines -Lines $Lines -Line ([int]$block.hit_line) -Before ([int]$block.hit_line - [int]$block.owner_start) -After ([int]$block.owner_end - [int]$block.hit_line)))
  }
  $Snippet.Add("")
  $Snippet.Add("RAW HIT LINES")
  foreach ($hit in ($Hits | Sort-Object line,kind | Select-Object -First 600)) {
    $Snippet.Add(("{0,6} [{1}] {2}" -f $hit.line, $hit.kind, $hit.text))
  }

  Write-Utf8NoBomLf -Path $SnippetPath -Text ($Snippet -join "`n")
  Write-Utf8NoBomLf -Path $DumpPath -Text $Text

  $Reports += [pscustomobject]@{
    role = $Target.role
    build = $Build.FullName
    build_name = $Build.Name
    popup = $PopupPath
    popup_html = $PopupHtmlPath
    manifest = $ManifestPath
    counts = $Counts
    risks = $Risks
    owner_blocks = $OwnerBlocks
    boundary_snippets = $SnippetPath
    popup_dump = $DumpPath
  }
}

$Plan = [pscustomobject]@{
  replace_only = @(
    "native Domain Ops Save rule storage write",
    "native saved-rule row status for the same domain",
    "native Active Site mode-lock reason copy"
  )
  do_not_replace = @(
    "Banner Suppression",
    "Browser Observer",
    "Domain Tools",
    "Active Site cookie inspection",
    "entire popup render tree",
    "native Domain Ops panel container",
    "native no-rule empty state with a duplicate custom panel"
  )
  next_patch_shape = @(
    "start from clean v32 baseline",
    "preserve v32 banner block exactly",
    "no custom Domain Rules panel",
    "no MutationObserver",
    "no broad UI rewrite",
    "patch the audited owner blocks only"
  )
}

Write-JsonFile -Path (Join-Path $AuditRoot "audit.json") -Object ([pscustomobject]@{
  schema = "cookiegate.domain_ops_replacement_boundary_audit.v2"
  utc = (Get-Date).ToUniversalTime().ToString("o")
  repo_root = $RepoRoot
  audit_root = $AuditRoot
  risk_count = $RiskRows.Count
  risks = $RiskRows
  boundary_rows = $BoundaryRows
  plan = $Plan
  reports = $Reports
})

$Summary = New-Object System.Collections.Generic.List[string]
$Summary.Add("COOKIEGATE_DOMAIN_OPS_REPLACEMENT_BOUNDARY_AUDIT_V2")
$Summary.Add("AUDIT: $AuditRoot")
$Summary.Add("RISKS: $($RiskRows.Count)")
$Summary.Add("")
$Summary.Add("REPLACE ONLY:")
foreach ($x in $Plan.replace_only) { $Summary.Add("  - $x") }
$Summary.Add("")
$Summary.Add("DO NOT REPLACE:")
foreach ($x in $Plan.do_not_replace) { $Summary.Add("  - $x") }
$Summary.Add("")
$Summary.Add("NEXT PATCH SHAPE:")
foreach ($x in $Plan.next_patch_shape) { $Summary.Add("  - $x") }
$Summary.Add("")

foreach ($r in $Reports) {
  $Summary.Add("[$($r.role) :: $($r.build_name)]")
  foreach ($k in $r.counts.Keys) {
    $Summary.Add(("  {0}: {1}" -f $k, $r.counts[$k]))
  }
  if ($r.risks.Count -gt 0) {
    $Summary.Add("  risks:")
    foreach ($risk in $r.risks) { $Summary.Add("    $risk") }
  } else {
    $Summary.Add("  risks: none")
  }
  $Summary.Add("  boundary_snippets: $($r.boundary_snippets)")
  $Summary.Add("")
}

$SummaryPath = Join-Path $AuditRoot "audit_summary.txt"
Write-Utf8NoBomLf -Path $SummaryPath -Text ($Summary -join "`n")

if ($RiskRows.Count -gt 0) {
  Write-Host "COOKIEGATE_DOMAIN_OPS_REPLACEMENT_BOUNDARY_AUDIT_FOUND_RISKS" -ForegroundColor Yellow
} else {
  Write-Host "COOKIEGATE_DOMAIN_OPS_REPLACEMENT_BOUNDARY_AUDIT_CLEAN" -ForegroundColor Green
}

Write-Host "Audit root: $AuditRoot" -ForegroundColor Yellow
Write-Host "Summary: $SummaryPath" -ForegroundColor Yellow
$RiskRows | Format-Table -AutoSize
