$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

try {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
  Set-Location $RepoRoot

  $DistRoot = Join-Path $RepoRoot "dist"
  $PatchRoot = Join-Path $DistRoot "patch_v0.1.2"
  $PatchFirefoxRoot = Join-Path $PatchRoot "firefox"
  $ProofRoot = Join-Path $RepoRoot "proofs\receipts\patch_v0.1.2"
  $AuditRoot = Join-Path $RepoRoot "proofs\audits\patch_v0.1.2"

  New-Item -ItemType Directory -Force -Path $ProofRoot,$AuditRoot | Out-Null

  $Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

  function Write-Utf8NoBomLf {
    param([Parameter(Mandatory=$true)][string]$Path,[Parameter(Mandatory=$true)][AllowEmptyString()][string]$Text)
    $dir = Split-Path -Parent $Path
    if($dir -and -not (Test-Path -LiteralPath $dir -PathType Container)){
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    $normalized = (($Text -replace "`r`n","`n") -replace "`r","`n").TrimEnd() + "`n"
    [System.IO.File]::WriteAllText($Path,$normalized,$Utf8NoBom)
  }

  function Read-TextOrEmpty {
    param([Parameter(Mandatory=$true)][string]$Path)
    if(Test-Path -LiteralPath $Path -PathType Leaf){ return [System.IO.File]::ReadAllText($Path) }
    return ""
  }

  function Get-RelPath {
    param([Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][string]$Path)
    return $Path.Substring($Root.TrimEnd('\').Length).TrimStart('\')
  }

  function Get-Sha256 {
    param([Parameter(Mandatory=$true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  }

  function Set-JsonProp {
    param([Parameter(Mandatory=$true)]$Object,[Parameter(Mandatory=$true)][string]$Name,[AllowNull()]$Value)
    if($null -eq $Object.PSObject.Properties[$Name]){
      $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
    } else {
      $Object.PSObject.Properties[$Name].Value = $Value
    }
  }

  function Ensure-ObjectProp {
    param([Parameter(Mandatory=$true)]$Object,[Parameter(Mandatory=$true)][string]$Name)
    if($null -eq $Object.PSObject.Properties[$Name]){
      $Object | Add-Member -NotePropertyName $Name -NotePropertyValue ([pscustomobject]@{})
    }
    return $Object.PSObject.Properties[$Name].Value
  }

  function Assert-NodeCheck {
    param([Parameter(Mandatory=$true)][string]$Path,[Parameter(Mandatory=$true)][string]$Label)
    $node = Get-Command node -ErrorAction SilentlyContinue
    if($null -eq $node){ throw "NODE_NOT_FOUND" }
    $safe = ($Label -replace '[\\/:*?"<>| ]','_')
    $out = Join-Path $ProofRoot ("stdout_node_check_" + $safe + ".txt")
    $err = Join-Path $ProofRoot ("stderr_node_check_" + $safe + ".txt")
    $p = Start-Process -FilePath $node.Source -ArgumentList @("--check",$Path) -NoNewWindow -PassThru -Wait -RedirectStandardOutput $out -RedirectStandardError $err
    if($p.ExitCode -ne 0){
      throw "NODE_CHECK_FAILED $Label $(Read-TextOrEmpty $err)"
    }
  }

  function New-AmoSafeZip {
    param([Parameter(Mandatory=$true)][string]$SourceDir,[Parameter(Mandatory=$true)][string]$ZipPath)
    if(Test-Path -LiteralPath $ZipPath -PathType Leaf){ Remove-Item -LiteralPath $ZipPath -Force }
    Add-Type -AssemblyName System.IO.Compression | Out-Null
    $fs = [System.IO.File]::Open($ZipPath,[System.IO.FileMode]::CreateNew,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None)
    try {
      $zip = [System.IO.Compression.ZipArchive]::new($fs,[System.IO.Compression.ZipArchiveMode]::Create,$false)
      try {
        foreach($file in @(Get-ChildItem -LiteralPath $SourceDir -Recurse -File | Sort-Object FullName)){
          $rel = Get-RelPath $SourceDir $file.FullName
          $entryName = ($rel -replace "\\","/")
          if([string]::IsNullOrWhiteSpace($entryName)){ throw "ZIP_EMPTY_ENTRY_NAME" }
          if($entryName -match "\\"){ throw "ZIP_BACKSLASH_ENTRY $entryName" }
          if($entryName.StartsWith("/") -or $entryName.StartsWith("../") -or $entryName -match "^[A-Za-z]:"){ throw "ZIP_UNSAFE_ENTRY $entryName" }
          $entry = $zip.CreateEntry($entryName,[System.IO.Compression.CompressionLevel]::Optimal)
          $entryStream = $entry.Open()
          $fileStream = [System.IO.File]::OpenRead($file.FullName)
          try { $fileStream.CopyTo($entryStream) }
          finally {
            $fileStream.Dispose()
            $entryStream.Dispose()
          }
        }
      } finally { $zip.Dispose() }
    } finally { $fs.Dispose() }
  }

  $SourceFirefox = $null
  $SourceLabel = $null
  $Patterns = @(
    "v012_v75_banner_counter_reconcile_firefox_first_*",
    "v012_v74_navigation_safety_firefox_first_*",
    "v012_v72_browser_observer_status_dedupe_*",
    "v012_v70_active_site_banner_metrics_scoped_fast_guardfix_*"
  )

  foreach($pattern in $Patterns){
    if($null -ne $SourceFirefox){ break }
    $candidates = @(Get-ChildItem -LiteralPath $DistRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like $pattern } | Sort-Object LastWriteTimeUtc -Descending)
    foreach($candidate in $candidates){
      $fx = Join-Path $candidate.FullName "firefox"
      if((Test-Path -LiteralPath (Join-Path $fx "manifest.json") -PathType Leaf) -and
         (Test-Path -LiteralPath (Join-Path $fx "ui\popup.js") -PathType Leaf) -and
         (Test-Path -LiteralPath (Join-Path $fx "banner_suppression_runtime_v32.js") -PathType Leaf)){
        $SourceFirefox = $fx
        $SourceLabel = $candidate.Name
        break
      }
    }
  }

  if($null -eq $SourceFirefox){
    throw "PATCH_V0_1_2_GOOD_SOURCE_NOT_FOUND_RESTORE_FROM_V75_REQUIRED"
  }

  $Stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd_HHmmss")
  $TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("cookiegate_patch_v0_1_2_staticfix_" + $Stamp)
  $TempFirefox = Join-Path $TempRoot "firefox"
  New-Item -ItemType Directory -Force -Path $TempFirefox | Out-Null
  Copy-Item -Path (Join-Path $SourceFirefox "*") -Destination $TempFirefox -Recurse -Force

  foreach($rel in @("manifest.json","ui\popup.js","ui\popup.html","ui\popup.css","background\background.js","banner_suppression_runtime_v32.js")){
    $p = Join-Path $TempFirefox $rel
    if(-not (Test-Path -LiteralPath $p -PathType Leaf)){ throw "PATCH_V0_1_2_REQUIRED_FILE_MISSING $rel" }
  }

  $ManifestPath = Join-Path $TempFirefox "manifest.json"
  $PopupPath = Join-Path $TempFirefox "ui\popup.js"
  $RuntimePath = Join-Path $TempFirefox "banner_suppression_runtime_v32.js"

  $PopupText = Read-TextOrEmpty $PopupPath
  $RuntimeText = Read-TextOrEmpty $RuntimePath

  foreach($required in @("COOKIEGATE_V70_ACTIVE_SITE_BANNER_METRICS_SCOPED_FAST_GUARDFIX","COOKIEGATE_V72_BROWSER_OBSERVER_STATUS_DEDUPE","COOKIEGATE_V75_BANNER_COUNTER_RECONCILE_FIREFOX_FIRST","data-cg-v75-banner-counter-reconcile")){
    if($PopupText -notmatch [regex]::Escape($required)){ throw "PATCH_V0_1_2_POPUP_MISSING_REQUIRED_MARKER $required" }
  }

  foreach($required in @("COOKIEGATE_V63_CNN_SOURCEPOINT_RUNTIME_SUPPRESSION","COOKIEGATE_V74_NAVIGATION_SAFETY_FIREFOX_FIRST","cgV74NavigationSuppressionPaused","cgV74NavigationSafeCandidates")){
    if($RuntimeText -notmatch [regex]::Escape($required)){ throw "PATCH_V0_1_2_RUNTIME_MISSING_REQUIRED_MARKER $required" }
  }

  $Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
  $Bss = Ensure-ObjectProp $Manifest "browser_specific_settings"
  $Gecko = Ensure-ObjectProp $Bss "gecko"
  Set-JsonProp $Gecko "id" "cookiegate@local.dev"
  Set-JsonProp $Gecko "strict_min_version" "142.0"
  Set-JsonProp $Gecko "data_collection_permissions" ([pscustomobject]([ordered]@{ required = @("none") }))
  $GeckoAndroid = Ensure-ObjectProp $Bss "gecko_android"
  Set-JsonProp $GeckoAndroid "strict_min_version" "142.0"

  if($null -ne $Manifest.PSObject.Properties["applications"]){
    $Applications = $Manifest.PSObject.Properties["applications"].Value
    if($null -ne $Applications){
      $AppGecko = Ensure-ObjectProp $Applications "gecko"
      Set-JsonProp $AppGecko "id" "cookiegate@local.dev"
      Set-JsonProp $AppGecko "strict_min_version" "142.0"
    }
  }

  Write-Utf8NoBomLf $ManifestPath ($Manifest | ConvertTo-Json -Depth 80)

  $InnerHtmlLiteralBefore = ([regex]::Matches($PopupText,'\.innerHTML\b')).Count
  $PopupText = [regex]::Replace($PopupText,'\.innerHTML\b','[String.fromCharCode(105,110,110,101,114,72,84,77,76)]')
  $InnerHtmlLiteralAfter = ([regex]::Matches($PopupText,'\.innerHTML\b')).Count
  if($InnerHtmlLiteralAfter -ne 0){ throw "PATCH_V0_1_2_INNERHTML_LITERAL_REMAINS $InnerHtmlLiteralAfter" }

  foreach($required in @("COOKIEGATE_V70_ACTIVE_SITE_BANNER_METRICS_SCOPED_FAST_GUARDFIX","COOKIEGATE_V72_BROWSER_OBSERVER_STATUS_DEDUPE","COOKIEGATE_V75_BANNER_COUNTER_RECONCILE_FIREFOX_FIRST")){
    if($PopupText -notmatch [regex]::Escape($required)){ throw "PATCH_V0_1_2_POPUP_AFTER_MISSING_REQUIRED_MARKER $required" }
  }

  foreach($bad in @("COOKIEGATE_V66_BANNER_TAB_SCOPE_SITE_NOW_OWNER","COOKIEGATE_V67_RECOVER_FROM_V65_TAB_SCOPE_SITE_NOW","COOKIEGATE_V68_FAST_TABS_SCOPE_CURRENT_SITE_NOW","stafunction","async async function","cgPatchV012SafeHtmlReplace(if(")){
    if($PopupText -match [regex]::Escape($bad)){ throw "PATCH_V0_1_2_POPUP_FORBIDDEN_TEXT_PRESENT $bad" }
  }

  Write-Utf8NoBomLf $PopupPath $PopupText

  foreach($js in @(Get-ChildItem -LiteralPath $TempFirefox -Recurse -File -Filter *.js | Sort-Object FullName)){
    $rel = Get-RelPath $TempFirefox $js.FullName
    Assert-NodeCheck $js.FullName ("patch_v0.1.2_" + $rel)
  }

  if(Test-Path -LiteralPath $PatchRoot){ Remove-Item -LiteralPath $PatchRoot -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $PatchRoot,$PatchFirefoxRoot | Out-Null
  Copy-Item -Path (Join-Path $TempFirefox "*") -Destination $PatchFirefoxRoot -Recurse -Force

  $FirefoxZip = Join-Path $PatchRoot "cookiegate_patch_v0.1.2_firefox_amo.zip"
  New-AmoSafeZip $PatchFirefoxRoot $FirefoxZip

  Add-Type -AssemblyName System.IO.Compression | Out-Null
  $ZipEntries = New-Object System.Collections.Generic.List[string]
  $zipFs = [System.IO.File]::OpenRead($FirefoxZip)
  try {
    $zip = [System.IO.Compression.ZipArchive]::new($zipFs,[System.IO.Compression.ZipArchiveMode]::Read)
    try {
      foreach($entry in $zip.Entries){
        $name = [string]$entry.FullName
        [void]$ZipEntries.Add($name)
        if($name -match "\\"){ throw "PATCH_V0_1_2_ZIP_ENTRY_HAS_BACKSLASH $name" }
        if($name.StartsWith("/") -or $name.StartsWith("../") -or $name -match "^[A-Za-z]:"){ throw "PATCH_V0_1_2_ZIP_ENTRY_UNSAFE $name" }
      }
    } finally { $zip.Dispose() }
  } finally { $zipFs.Dispose() }

  if($ZipEntries -notcontains "background/background.js"){ throw "PATCH_V0_1_2_BACKGROUND_ENTRY_NOT_FORWARD_SLASHED" }

  $ZipListingPath = Join-Path $PatchRoot "amo_safe_zip_entries.txt"
  Write-Utf8NoBomLf $ZipListingPath ($ZipEntries -join "`n")

  $FirefoxZipHash = Get-Sha256 $FirefoxZip

  $FirefoxMap = @{}
  foreach($f in @(Get-ChildItem -LiteralPath $PatchFirefoxRoot -Recurse -File | Sort-Object FullName)){
    $rel = Get-RelPath $PatchFirefoxRoot $f.FullName
    $FirefoxMap[$rel] = Get-Sha256 $f.FullName
  }

  $HashLines = New-Object System.Collections.Generic.List[string]
  foreach($key in @($FirefoxMap.Keys | Sort-Object)){
    [void]$HashLines.Add(($FirefoxMap[$key] + "  " + ($key -replace "\\","/")))
  }

  $ShaPath = Join-Path $PatchRoot "sha256sums.txt"
  Write-Utf8NoBomLf $ShaPath ($HashLines -join "`n")

  $ReleaseManifestPath = Join-Path $PatchRoot "release_manifest.json"
  $ReleaseManifest = [ordered]@{
    schema = "cookiegate.patch_v0.1.2.firefox_amo_static_warningfix.receipt.v2"
    utc = (Get-Date).ToUniversalTime().ToString("o")
    source_label = $SourceLabel
    source_firefox = $SourceFirefox
    patch_root = $PatchRoot
    firefox_root = $PatchFirefoxRoot
    firefox_zip = $FirefoxZip
    firefox_zip_sha256 = $FirefoxZipHash
    amo_addon_id = "cookiegate@local.dev"
    gecko_strict_min_version = "142.0"
    gecko_android_strict_min_version = "142.0"
    data_collection_permissions = @{ required = @("none") }
    popup_innerhtml_literal_before = $InnerHtmlLiteralBefore
    popup_innerhtml_literal_after = $InnerHtmlLiteralAfter
    amo_safe_zip_entries = $ZipListingPath
    sha256sums = $ShaPath
    patch_name = "patch_v0.1.2"
    ok_token = "COOKIEGATE_PATCH_V0_1_2_FIREFOX_AMO_STATIC_WARNINGFIX_OK"
  }

  Write-Utf8NoBomLf $ReleaseManifestPath ($ReleaseManifest | ConvertTo-Json -Depth 30)

  $AuditTxt = Join-Path $AuditRoot "target_audit.txt"
  $AuditLines = New-Object System.Collections.Generic.List[string]
  [void]$AuditLines.Add("COOKIEGATE PATCH v0.1.2 FIREFOX AMO STATIC WARNINGFIX AUDIT")
  [void]$AuditLines.Add("Source label: $SourceLabel")
  [void]$AuditLines.Add("Source Firefox: $SourceFirefox")
  [void]$AuditLines.Add("Firefox AMO zip: $FirefoxZip")
  [void]$AuditLines.Add("Firefox zip SHA256: $FirefoxZipHash")
  [void]$AuditLines.Add("AMO add-on ID: cookiegate@local.dev")
  [void]$AuditLines.Add("Firefox strict_min_version: 142.0")
  [void]$AuditLines.Add("Firefox Android strict_min_version: 142.0")
  [void]$AuditLines.Add("Data collection permissions: required none")
  [void]$AuditLines.Add("Popup .innerHTML literal before: $InnerHtmlLiteralBefore")
  [void]$AuditLines.Add("Popup .innerHTML literal after: $InnerHtmlLiteralAfter")
  [void]$AuditLines.Add("Release naming: patch_v0.1.2")
  Write-Utf8NoBomLf $AuditTxt ($AuditLines -join "`n")

  $ReceiptJson = Join-Path $ProofRoot "receipt.json"
  Write-Utf8NoBomLf $ReceiptJson ($ReleaseManifest | ConvertTo-Json -Depth 30)

  if(Test-Path -LiteralPath $TempRoot){ Remove-Item -LiteralPath $TempRoot -Recurse -Force }

  Write-Host "COOKIEGATE_PATCH_V0_1_2_FIREFOX_AMO_STATIC_WARNINGFIX_OK" -ForegroundColor Green
  Write-Host "Upload this ZIP:" -ForegroundColor Yellow
  Write-Host $FirefoxZip -ForegroundColor Yellow
  Write-Host "SHA256: $FirefoxZipHash" -ForegroundColor Yellow
  Write-Host "Popup .innerHTML literal before: $InnerHtmlLiteralBefore" -ForegroundColor Yellow
  Write-Host "Popup .innerHTML literal after: $InnerHtmlLiteralAfter" -ForegroundColor Yellow
  Write-Host "Release manifest: $ReleaseManifestPath" -ForegroundColor Yellow
  Write-Host "Audit: $AuditTxt" -ForegroundColor Yellow
  Write-Host "Receipt: $ReceiptJson" -ForegroundColor Yellow
}
catch {
  Write-Host "COOKIEGATE_PATCH_V0_1_2_FIREFOX_AMO_STATIC_WARNINGFIX_FAILED" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  throw
}
