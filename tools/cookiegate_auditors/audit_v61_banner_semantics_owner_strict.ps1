$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

try {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
  Set-Location $RepoRoot

  $ChromeRoot = "$RepoRoot\dist\v012_chrome_only_v61_banner_message_reconcile_20260614_110754\chrome"

  $BadChromeRoots = @(
    "$RepoRoot\dist\v012_chrome_only_v57_mode_lock_immediate_repaint_note_layout_20260613_000451\chrome",
    "$RepoRoot\dist\v012_chrome_only_v58_banner_message_rule_button_spacing_20260613_012538\chrome",
    "$RepoRoot\dist\v012_chrome_only_v60_banner_metrics_reconcile_20260613_180429\chrome"
  )

  foreach($bad in $BadChromeRoots){
    if($ChromeRoot.TrimEnd('\') -ieq $bad.TrimEnd('\')){
      throw "REFUSING_BAD_CHROME_ROOT $ChromeRoot"
    }
  }

  if(-not (Test-Path -LiteralPath $ChromeRoot -PathType Container)){
    throw "MISSING_V61_CHROME_ROOT $ChromeRoot"
  }

  $PopupPath = Join-Path $ChromeRoot "ui\popup.js"
  $ManifestPath = Join-Path $ChromeRoot "manifest.json"

  foreach($p in @($PopupPath,$ManifestPath)){
    if(-not (Test-Path -LiteralPath $p -PathType Leaf)){
      throw "REQUIRED_FILE_MISSING $p"
    }
  }

  $PopupItem = Get-Item -LiteralPath $PopupPath
  if($PopupItem.Length -lt 1000){
    throw "POPUP_JS_TOO_SMALL_OR_EMPTY $PopupPath bytes=$($PopupItem.Length)"
  }

  $Stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd_HHmmssZ")
  $AuditRoot = Join-Path $RepoRoot ("proofs\audits\cookiegate_v61_banner_semantics_owner_audit_strict_" + $Stamp)
  $ReceiptRoot = Join-Path $RepoRoot ("proofs\receipts\v012_chrome_only_v61_banner_semantics_owner_audit_strict_" + $Stamp)
  New-Item -ItemType Directory -Force -Path $AuditRoot,$ReceiptRoot | Out-Null

  $Node = Get-Command node -ErrorAction SilentlyContinue
  if($null -eq $Node){
    throw "NODE_NOT_FOUND"
  }

  $PopupCheckOut = Join-Path $ReceiptRoot "stdout_node_check_popup.txt"
  $PopupCheckErr = Join-Path $ReceiptRoot "stderr_node_check_popup.txt"
  $p0 = Start-Process -FilePath "node" -ArgumentList @("--check",$PopupPath) -NoNewWindow -PassThru -Wait -RedirectStandardOutput $PopupCheckOut -RedirectStandardError $PopupCheckErr
  if($p0.ExitCode -ne 0){
    $stderr = if(Test-Path -LiteralPath $PopupCheckErr){ Get-Content -LiteralPath $PopupCheckErr -Raw } else { "" }
    throw "POPUP_JS_PARSE_FAILED $stderr"
  }

  $AuditJs = "$RepoRoot\tools\cookiegate_auditors\audit_v61_banner_semantics_owner_strict.js"
  if(-not (Test-Path -LiteralPath $AuditJs -PathType Leaf)){
    throw "AUDIT_JS_MISSING $AuditJs"
  }

  $AuditJsCheckOut = Join-Path $ReceiptRoot "stdout_node_check_auditor.txt"
  $AuditJsCheckErr = Join-Path $ReceiptRoot "stderr_node_check_auditor.txt"
  $p1 = Start-Process -FilePath "node" -ArgumentList @("--check",$AuditJs) -NoNewWindow -PassThru -Wait -RedirectStandardOutput $AuditJsCheckOut -RedirectStandardError $AuditJsCheckErr
  if($p1.ExitCode -ne 0){
    $stderr = if(Test-Path -LiteralPath $AuditJsCheckErr){ Get-Content -LiteralPath $AuditJsCheckErr -Raw } else { "" }
    throw "AUDITOR_JS_PARSE_FAILED $stderr"
  }

  $AuditRunOut = Join-Path $ReceiptRoot "stdout_audit_run.txt"
  $AuditRunErr = Join-Path $ReceiptRoot "stderr_audit_run.txt"
  $p2 = Start-Process -FilePath "node" -ArgumentList @($AuditJs,$ChromeRoot,$AuditRoot) -NoNewWindow -PassThru -Wait -RedirectStandardOutput $AuditRunOut -RedirectStandardError $AuditRunErr
  if($p2.ExitCode -ne 0){
    $stderr = if(Test-Path -LiteralPath $AuditRunErr){ Get-Content -LiteralPath $AuditRunErr -Raw } else { "" }
    throw "AUDITOR_RUN_FAILED $stderr"
  }

  $AuditJson = Join-Path $AuditRoot "audit.json"
  $AuditSummary = Join-Path $AuditRoot "audit_summary.txt"
  $HotHits = Join-Path $AuditRoot "popup_hot_string_hits.txt"
  $CounterHits = Join-Path $AuditRoot "popup_counter_candidate_hits.txt"

  foreach($p in @($AuditJson,$AuditSummary,$HotHits,$CounterHits)){
    if(-not (Test-Path -LiteralPath $p -PathType Leaf)){
      throw "AUDIT_OUTPUT_MISSING $p"
    }
  }

  $AuditObj = Get-Content -LiteralPath $AuditJson -Raw | ConvertFrom-Json
  if($AuditObj.patched -ne $false){ throw "AUDIT_CLAIMS_PATCHED_UNEXPECTEDLY" }
  if($AuditObj.zipped -ne $false){ throw "AUDIT_CLAIMS_ZIPPED_UNEXPECTEDLY" }
  if([string]::IsNullOrWhiteSpace([string]$AuditObj.owner_conclusion)){ throw "OWNER_CONCLUSION_EMPTY" }

  $enc = [System.Text.UTF8Encoding]::new($false)
  $ReceiptPath = Join-Path $ReceiptRoot "receipt.json"
  $Receipt = [pscustomobject]@{
    schema = "cookiegate.v61.banner_semantics_owner_audit.strict.receipt.v1"
    utc = (Get-Date).ToUniversalTime().ToString("o")
    chrome_root = $ChromeRoot
    popup_path = $PopupPath
    popup_sha256 = (Get-FileHash -LiteralPath $PopupPath -Algorithm SHA256).Hash.ToLowerInvariant()
    audit_root = $AuditRoot
    audit_json = $AuditJson
    audit_json_sha256 = (Get-FileHash -LiteralPath $AuditJson -Algorithm SHA256).Hash.ToLowerInvariant()
    audit_summary = $AuditSummary
    audit_summary_sha256 = (Get-FileHash -LiteralPath $AuditSummary -Algorithm SHA256).Hash.ToLowerInvariant()
    patched = $false
    zipped = $false
    ok_token = "COOKIEGATE_V61_BANNER_SEMANTICS_OWNER_AUDIT_STRICT_OK"
  }
  [System.IO.File]::WriteAllText($ReceiptPath, (($Receipt | ConvertTo-Json -Depth 20) -replace "`r`n","`n") + "`n", $enc)

  Write-Host "COOKIEGATE_V61_BANNER_SEMANTICS_OWNER_AUDIT_STRICT_OK" -ForegroundColor Green
  Write-Host ("AUDIT_SUMMARY=" + $AuditSummary) -ForegroundColor Yellow
  Write-Host ("AUDIT_JSON=" + $AuditJson) -ForegroundColor Yellow
  Write-Host ("HOT_HITS=" + $HotHits) -ForegroundColor Yellow
  Write-Host ("COUNTER_HITS=" + $CounterHits) -ForegroundColor Yellow
  Write-Host ("RECEIPT_JSON=" + $ReceiptPath) -ForegroundColor Yellow

  Write-Host ""
  Get-Content -LiteralPath $AuditSummary -Raw
}
catch {
  Write-Host "COOKIEGATE_V61_BANNER_SEMANTICS_OWNER_AUDIT_STRICT_FAILED" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  throw
}
