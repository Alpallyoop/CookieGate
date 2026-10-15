$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $RepoRoot

$DistRoot = Join-Path $RepoRoot "dist"
$AuditParent = Join-Path $RepoRoot "proofs\audits"

if (!(Test-Path -LiteralPath $DistRoot)) { throw "DIST_ROOT_MISSING: $DistRoot" }

$CleanBuild = Get-ChildItem -LiteralPath $DistRoot -Directory |
  Where-Object { $_.Name -like "v012_canonical_safe_recovery_v32_banner_suppression_metrics_domain_rules_*" } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if ($null -eq $CleanBuild) { throw "NO_CLEAN_V32_BASELINE_FOUND" }

$LatestBuild = Get-ChildItem -LiteralPath $DistRoot -Directory |
  Where-Object { $_.Name -like "v012_canonical_safe_recovery_v*" } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

$Stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$AuditRoot = Join-Path $AuditParent "cookiegate_domain_ops_actual_targets_audit_v1_$Stamp"
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

function Get-FunctionBlock {
  param(
    [Parameter(Mandatory=$true)][string]$Text,
    [Parameter(Mandatory=$true)][string]$Name
  )

  $m = [regex]::Match($Text, "function\s+$([regex]::Escape($Name))\s*\([^)]*\)\s*\{")
  if (!$m.Success) {
    return [pscustomobject]@{
      found = $false
      name = $Name
      start_index = -1
      end_index = -1
      text = ""
    }
  }

  $start = $m.Index
  $i = $m.Index
  $depth = 0
  $seen = $false
  $end = -1
  $inString = $false
  $stringQuote = [char]0
  $escape = $false

  while ($i -lt $Text.Length) {
    $ch = $Text[$i]

    if ($inString) {
      if ($escape) {
        $escape = $false
      } elseif ($ch -eq "\") {
        $escape = $true
      } elseif ($ch -eq $stringQuote) {
        $inString = $false
      }
      $i++
      continue
    }

    if ($ch -eq '"' -or $ch -eq "'" -or $ch -eq '`') {
      $inString = $true
      $stringQuote = $ch
      $i++
      continue
    }

    if ($ch -eq "{") {
      $depth++
      $seen = $true
    } elseif ($ch -eq "}") {
      if ($seen) { $depth-- }
      if ($seen -and $depth -eq 0) {
        $end = $i + 1
        break
      }
    }

    $i++
  }

  if ($end -lt 0) {
    return [pscustomobject]@{
      found = $false
      name = $Name
      start_index = $start
      end_index = -1
      text = ""
    }
  }

  return [pscustomobject]@{
    found = $true
    name = $Name
    start_index = $start
    end_index = $end
    text = $Text.Substring($start, $end - $start)
  }
}

function Get-LineNumberForIndex {
  param(
    [Parameter(Mandatory=$true)][string]$Text,
    [int]$Index
  )
  if ($Index -lt 0) { return 0 }
  return (($Text.Substring(0, [Math]::Min($Index, $Text.Length)) -split "`n").Count)
}

function Find-Lines {
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

$FunctionTargets = @(
  "inputRuleObject",
  "saveInputRule",
  "saveRules",
  "rules",
  "renderDomainRules",
  "installBadge",
  "saveAndActivateRule",
  "renderRuleLock",
  "findDomainRulesPanel",
  "checkInputDomain",
  "normalizeDomain",
  "selectedModeNearSave",
  "typedDomain",
  "setStatus"
)

$PatternTargets = [ordered]@{
  save_rule_button = 'Save rule'
  check_site_button = 'Check site'
  native_disabled_until_checked = 'disabled until checked'
  saved_rule_message = 'Saved rule for'
  native_empty_state = 'No domain rules yet'
  duplicate_empty_state = 'No domain rules saved'
  domain_rule_active = 'Domain rule active'
  mode_locked = 'Mode locked by rule'
  rule_key = 'cookiegate\.domainModeLocks\.v32'
  banner_title = 'Banner Suppression'
  metric_this_site = 'this site now'
  metric_session = 'this session'
  metric_timeline = 'site timeline'
  metric_lifetime = 'lifetime blocked'
  active_field = 'active\s*[:=]\s*true'
  enabled_field = 'enabled\s*[:=]\s*true'
  disabled_false_field = 'disabled\s*[:=]\s*false'
  enabled_false_field = 'enabled\s*[:=]\s*false'
  status_active = 'status\s*[:=]\s*["'']active["'']'
  checked_false = 'checked\s*[:=]\s*false'
  reachable_false = 'reachable\s*[:=]\s*false'
  reachability_unchecked = 'reachability\s*[:=]\s*["'']unchecked["'']'
  mutation_observer = 'MutationObserver'
  old_generated_patch = 'COOKIEGATE_V33|COOKIEGATE_V34|COOKIEGATE_V35|COOKIEGATE_V36|COOKIEGATE_V37|COOKIEGATE_V38|COOKIEGATE_V39|COOKIEGATE_V40|COOKIEGATE_V41|COOKIEGATE_V42|COOKIEGATE_V43|COOKIEGATE_V44|COOKIEGATE_V45|COOKIEGATE_V46|COOKIEGATE_V47'
  non_ascii = '[^\x09\x0A\x0D\x20-\x7E]'
}

$Targets = @(
  [pscustomobject]@{ role = "clean_v32_baseline"; build = $CleanBuild },
  [pscustomobject]@{ role = "latest_build"; build = $LatestBuild }
) | Where-Object { $null -ne $_.build }

$Reports = @()
$Risks = @()

foreach ($Target in $Targets) {
  $PopupPath = Join-Path $Target.build.FullName "chrome\ui\popup.js"
  if (!(Test-Path -LiteralPath $PopupPath)) { throw "POPUP_MISSING: $PopupPath" }

  $Text = Get-Content -LiteralPath $PopupPath -Raw
  if ($null -eq $Text) { $Text = "" }

  $Lines = @(Read-LinesSafe -Path $PopupPath)

  $Counts = [ordered]@{}
  foreach ($k in $PatternTargets.Keys) {
    $Counts[$k] = Count-Regex -Text $Text -Pattern $PatternTargets[$k]
  }

  $FunctionReports = @()
  $FunctionDump = New-Object System.Collections.Generic.List[string]

  foreach ($fn in $FunctionTargets) {
    $block = Get-FunctionBlock -Text $Text -Name $fn
    $startLine = Get-LineNumberForIndex -Text $Text -Index $block.start_index

    $fnCounts = [ordered]@{}
    foreach ($k in $PatternTargets.Keys) {
      $fnCounts[$k] = Count-Regex -Text $block.text -Pattern $PatternTargets[$k]
    }

    $FunctionReports += [pscustomobject]@{
      name = $fn
      found = $block.found
      start_line = $startLine
      length = $block.text.Length
      counts = $fnCounts
    }

    $FunctionDump.Add("")
    $FunctionDump.Add("===== FUNCTION $fn :: found=$($block.found) :: start_line=$startLine =====")
    if ($block.found) {
      $FunctionDump.Add($block.text)
    }
  }

  $HitDump = New-Object System.Collections.Generic.List[string]
  foreach ($k in $PatternTargets.Keys) {
    $rows = @(Find-Lines -Lines $Lines -Pattern $PatternTargets[$k])
    foreach ($row in ($rows | Select-Object -First 40)) {
      $HitDump.Add(("{0,6} [{1}] {2}" -f $row.line, $k, $row.text))
    }
  }

  $Risk = @()

  if ($Counts.banner_title -lt 1 -or $Counts.metric_this_site -lt 1 -or $Counts.metric_session -lt 1 -or $Counts.metric_timeline -lt 1 -or $Counts.metric_lifetime -lt 1) { $Risk += "BANNER_METRICS_MISSING" }

  $inputRule = @($FunctionReports | Where-Object { $_.name -eq "inputRuleObject" } | Select-Object -First 1)
  $saveRule = @($FunctionReports | Where-Object { $_.name -eq "saveInputRule" } | Select-Object -First 1)
  $badgeRule = @($FunctionReports | Where-Object { $_.name -eq "installBadge" } | Select-Object -First 1)

  if ($inputRule.Count -lt 1 -or -not $inputRule[0].found) { $Risk += "TARGET_FUNCTION_inputRuleObject_MISSING" }
  if ($saveRule.Count -lt 1 -or -not $saveRule[0].found) { $Risk += "TARGET_FUNCTION_saveInputRule_MISSING" }
  if ($badgeRule.Count -lt 1 -or -not $badgeRule[0].found) { $Risk += "TARGET_FUNCTION_installBadge_MISSING" }

  if ($saveRule.Count -gt 0 -and $saveRule[0].counts.native_disabled_until_checked -gt 0) { $Risk += "saveInputRule_WRITES_DISABLED_UNTIL_CHECKED_STATUS" }
  if ($inputRule.Count -gt 0 -and $inputRule[0].counts.enabled_false_field -gt 0) { $Risk += "inputRuleObject_DEFAULTS_ENABLED_FALSE" }
  if ($inputRule.Count -gt 0 -and $inputRule[0].counts.checked_false -gt 0) { $Risk += "inputRuleObject_DEFAULTS_CHECKED_FALSE" }
  if ($inputRule.Count -gt 0 -and $inputRule[0].counts.reachable_false -gt 0) { $Risk += "inputRuleObject_DEFAULTS_REACHABLE_FALSE" }
  if ($inputRule.Count -gt 0 -and $inputRule[0].counts.reachability_unchecked -gt 0) { $Risk += "inputRuleObject_DEFAULTS_REACHABILITY_UNCHECKED" }
  if ($badgeRule.Count -gt 0 -and $badgeRule[0].counts.non_ascii -gt 0) { $Risk += "installBadge_HAS_MOJIBAKE_NON_ASCII" }
  if ($Counts.duplicate_empty_state -gt 0) { $Risk += "DUPLICATE_CUSTOM_EMPTY_STATE_PRESENT" }
  if ($Counts.old_generated_patch -gt 0) { $Risk += "OLD_GENERATED_PATCH_PRESENT" }

  foreach ($r in $Risk) {
    $Risks += [pscustomobject]@{
      role = $Target.role
      build = $Target.build.Name
      risk = $r
    }
  }

  $SafeName = ($Target.role + "_" + $Target.build.Name) -replace '[^A-Za-z0-9_.-]', '_'
  $FunctionDumpPath = Join-Path $AuditRoot "$SafeName.actual_function_targets.txt"
  $HitDumpPath = Join-Path $AuditRoot "$SafeName.pattern_hits.txt"

  Write-Utf8NoBomLf -Path $FunctionDumpPath -Text ($FunctionDump -join "`n")
  Write-Utf8NoBomLf -Path $HitDumpPath -Text ($HitDump -join "`n")

  $Reports += [pscustomobject]@{
    role = $Target.role
    build = $Target.build.FullName
    build_name = $Target.build.Name
    popup = $PopupPath
    counts = $Counts
    functions = $FunctionReports
    risks = $Risk
    actual_function_targets = $FunctionDumpPath
    pattern_hits = $HitDumpPath
  }
}

$Plan = [pscustomobject]@{
  patch_only_these_functions = @(
    "inputRuleObject",
    "saveInputRule",
    "installBadge",
    "saveAndActivateRule",
    "renderRuleLock"
  )
  do_not_replace = @(
    "whole popup",
    "Domain Ops container",
    "Banner Suppression",
    "Browser Observer",
    "Domain Tools",
    "Active Site cookie inspection",
    "renderDomainRules unless the audited function itself requires it"
  )
  required_post_patch_assertions = @(
    "inputRuleObject returns enabled true, active true, disabled false, checked true, reachable true, reachability checked",
    "saveInputRule status string is always active after save",
    "installBadge has ASCII only Domain rule active text",
    "no duplicate No domain rules saved panel",
    "no old generated patch stack",
    "Banner Suppression metrics remain present"
  )
}

Write-JsonFile -Path (Join-Path $AuditRoot "audit.json") -Object ([pscustomobject]@{
  schema = "cookiegate.domain_ops_actual_targets_audit.v1"
  utc = (Get-Date).ToUniversalTime().ToString("o")
  repo_root = $RepoRoot
  audit_root = $AuditRoot
  risk_count = $Risks.Count
  risks = $Risks
  plan = $Plan
  reports = $Reports
})

$Summary = New-Object System.Collections.Generic.List[string]
$Summary.Add("COOKIEGATE_DOMAIN_OPS_ACTUAL_TARGETS_AUDIT_V1")
$Summary.Add("AUDIT: $AuditRoot")
$Summary.Add("RISKS: $($Risks.Count)")
$Summary.Add("")
$Summary.Add("PATCH ONLY THESE FUNCTIONS:")
foreach ($x in $Plan.patch_only_these_functions) { $Summary.Add("  - $x") }
$Summary.Add("")
$Summary.Add("DO NOT REPLACE:")
foreach ($x in $Plan.do_not_replace) { $Summary.Add("  - $x") }
$Summary.Add("")
$Summary.Add("ASSERT AFTER PATCH:")
foreach ($x in $Plan.required_post_patch_assertions) { $Summary.Add("  - $x") }
$Summary.Add("")

foreach ($r in $Reports) {
  $Summary.Add("[$($r.role) :: $($r.build_name)]")
  foreach ($k in $r.counts.Keys) {
    $Summary.Add(("  {0}: {1}" -f $k, $r.counts[$k]))
  }

  $Summary.Add("  function targets:")
  foreach ($fn in $r.functions) {
    $Summary.Add(("    {0}: found={1} start_line={2} len={3}" -f $fn.name,$fn.found,$fn.start_line,$fn.length))
  }

  if ($r.risks.Count -gt 0) {
    $Summary.Add("  risks:")
    foreach ($risk in $r.risks) { $Summary.Add("    $risk") }
  } else {
    $Summary.Add("  risks: none")
  }

  $Summary.Add("  actual_function_targets: $($r.actual_function_targets)")
  $Summary.Add("  pattern_hits: $($r.pattern_hits)")
  $Summary.Add("")
}

$SummaryPath = Join-Path $AuditRoot "audit_summary.txt"
Write-Utf8NoBomLf -Path $SummaryPath -Text ($Summary -join "`n")

if ($Risks.Count -gt 0) {
  Write-Host "COOKIEGATE_DOMAIN_OPS_ACTUAL_TARGETS_AUDIT_FOUND_RISKS" -ForegroundColor Yellow
} else {
  Write-Host "COOKIEGATE_DOMAIN_OPS_ACTUAL_TARGETS_AUDIT_CLEAN" -ForegroundColor Green
}

Write-Host "Audit root: $AuditRoot" -ForegroundColor Yellow
Write-Host "Summary: $SummaryPath" -ForegroundColor Yellow
$Risks | Format-Table -Wrap -AutoSize
