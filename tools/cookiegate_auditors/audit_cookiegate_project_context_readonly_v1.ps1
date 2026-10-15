$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

try {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
  Set-Location $RepoRoot

  $AuditJs = "$RepoRoot\tools\cookiegate_auditors\audit_cookiegate_project_context_readonly_v1.js"

  if(-not (Test-Path -LiteralPath $AuditJs -PathType Leaf)){
    throw "AUDIT_JS_MISSING $AuditJs"
  }

  $Node = Get-Command node -ErrorAction SilentlyContinue
  if($null -eq $Node){
    throw "NODE_NOT_FOUND"
  }

  $ToolRoot = Split-Path -Parent $AuditJs
  $NodeCheckOut = Join-Path $ToolRoot "stdout_node_check_project_context_readonly.txt"
  $NodeCheckErr = Join-Path $ToolRoot "stderr_node_check_project_context_readonly.txt"

  $p0 = Start-Process -FilePath "node" -ArgumentList @("--check",$AuditJs) -NoNewWindow -PassThru -Wait -RedirectStandardOutput $NodeCheckOut -RedirectStandardError $NodeCheckErr
  if($p0.ExitCode -ne 0){
    $stderr = if(Test-Path -LiteralPath $NodeCheckErr){ Get-Content -LiteralPath $NodeCheckErr -Raw } else { "" }
    throw "AUDIT_JS_PARSE_FAILED $stderr"
  }

  $RunOut = Join-Path $ToolRoot "stdout_project_context_readonly_run.txt"
  $RunErr = Join-Path $ToolRoot "stderr_project_context_readonly_run.txt"

  $p1 = Start-Process -FilePath "node" -ArgumentList @($AuditJs) -NoNewWindow -PassThru -Wait -RedirectStandardOutput $RunOut -RedirectStandardError $RunErr
  if($p1.ExitCode -ne 0){
    $stderr = if(Test-Path -LiteralPath $RunErr){ Get-Content -LiteralPath $RunErr -Raw } else { "" }
    throw "AUDIT_RUN_FAILED $stderr"
  }

  $stdout = Get-Content -LiteralPath $RunOut -Raw
  Write-Host $stdout

  $summaryLine = ($stdout -split "`n" | Where-Object { $_ -like "SUMMARY=*" } | Select-Object -First 1)
  if([string]::IsNullOrWhiteSpace($summaryLine)){
    throw "SUMMARY_PATH_NOT_PRINTED"
  }

  $summaryPath = $summaryLine.Substring("SUMMARY=".Length).Trim()
  if(-not (Test-Path -LiteralPath $summaryPath -PathType Leaf)){
    throw "SUMMARY_FILE_MISSING $summaryPath"
  }

  Write-Host ""
  Write-Host "===== SUMMARY CONTENT =====" -ForegroundColor Cyan
  Get-Content -LiteralPath $summaryPath -Raw
}
catch {
  Write-Host "COOKIEGATE_PROJECT_CONTEXT_READONLY_AUDIT_FAILED" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  throw
}
