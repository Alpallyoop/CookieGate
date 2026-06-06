param(
  [string]$RepoRoot = 'C:\dev\cookiegate',
  [string]$Build = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if(-not $Build){
  $Build = Join-Path $RepoRoot 'dist\chrome-current'
}

Set-Location $RepoRoot

function Die {
  param([string]$Code,[string]$Detail = '')
  if($Detail){
    throw ($Code + ':' + $Detail)
  }
  throw $Code
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
  if(-not $t.EndsWith("`n")){ $t += "`n" }

  [System.IO.File]::WriteAllText($Path,$t,(New-Object System.Text.UTF8Encoding($false)))
}

function Has-Prop {
  param($Obj,[string]$Name)
  return $null -ne $Obj.PSObject.Properties[$Name]
}

$RequiredFiles = @(
  'manifest.json',
  'ui\popup.html',
  'ui\popup.js',
  'ui\popup.css',
  'content\banner_suppressor.js',
  'options\options.html',
  'options\options.css',
  'options\options.js'
)

foreach($rel in $RequiredFiles){
  $p = Join-Path $Build $rel
  if(-not (Test-Path -LiteralPath $p -PathType Leaf)){
    Die 'V011_VALIDATE_FAIL:MISSING_FILE' $rel
  }
}

$ManifestPath = Join-Path $Build 'manifest.json'
$Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json

if(-not (Has-Prop $Manifest 'options_ui')){
  Die 'V011_VALIDATE_FAIL:OPTIONS_UI_MISSING'
}

if($Manifest.options_ui.page -ne 'options/options.html'){
  Die 'V011_VALIDATE_FAIL:OPTIONS_UI_BAD' $Manifest.options_ui.page
}

if(-not (Has-Prop $Manifest 'content_scripts')){
  Die 'V011_VALIDATE_FAIL:CONTENT_SCRIPTS_MISSING'
}

$hasBanner = $false
foreach($cs in @($Manifest.content_scripts)){
  if(Has-Prop $cs 'js'){
    foreach($js in @($cs.js)){
      if([string]$js -eq 'content/banner_suppressor.js'){
        $hasBanner = $true
      }
    }
  }
}

if(-not $hasBanner){
  Die 'V011_VALIDATE_FAIL:BANNER_SUPPRESSOR_NOT_REGISTERED'
}

$PopupJs = Get-Content -LiteralPath (Join-Path $Build 'ui\popup.js') -Raw
$PopupCss = Get-Content -LiteralPath (Join-Path $Build 'ui\popup.css') -Raw
$OptionsJs = Get-Content -LiteralPath (Join-Path $Build 'options\options.js') -Raw
$BannerJs = Get-Content -LiteralPath (Join-Path $Build 'content\banner_suppressor.js') -Raw

$RequiredPopupMarkers = @(
  'COOKIEGATE_ROUTER_V7_STATIC_TABS_CLEAN'
  'COOKIEGATE_V011_OPTIONS_COG_LAUNCHER'
  'COOKIEGATE_V011_DOMAIN_REMOTE_TOOLS'
  'COOKIEGATE_V011_COUNT_SEMANTICS_UI'
  'COOKIEGATE_V011_NATIVE_OBSERVER_DONUT_PATCH'
  'COOKIEGATE_V011_BANNER_LIFETIME_UI_DOMAIN_OPS'

  'COOKIEGATE_V011_DOMAIN_RULE_EFFECTIVE_RESOLVER'
)

foreach($marker in $RequiredPopupMarkers){
  if($PopupJs -notmatch [regex]::Escape($marker)){
    Die 'V011_VALIDATE_FAIL:POPUP_MARKER_MISSING' $marker
  }
}

if($PopupJs -match 'COOKIEGATE_V011_OPTIONS_FLOATING_LAUNCHER'){
  Die 'V011_VALIDATE_FAIL:FLOATING_OPTIONS_LAUNCHER_STILL_PRESENT'
}

if(($PopupCss -notmatch 'COOKIEGATE_V011_OPTIONS_COG_LAUNCHER') -and ($PopupCss -notmatch '\.cg-options-gear-btn')){
  Die 'V011_VALIDATE_FAIL:COG_CSS_MISSING'
}

if($OptionsJs -notmatch 'COOKIEGATE_OPTIONS_V011'){
  Die 'V011_VALIDATE_FAIL:OPTIONS_JS_MARKER_MISSING'
}

if($BannerJs -notmatch 'COOKIEGATE_BANNER_SUPPRESSOR_V011'){
  Die 'V011_VALIDATE_FAIL:BANNER_JS_MARKER_MISSING'
}

if($BannerJs -notmatch 'COOKIEGATE_V011_BANNER_SUPPRESSION_SAFETY_GUARD'){
  Die 'V011_VALIDATE_FAIL:BANNER_SAFETY_GUARD_MISSING'
}

if($BannerJs -notmatch 'cookiegate.bannerSuppression.enabled'){
  Die 'V011_VALIDATE_FAIL:BANNER_SETTING_KEY_MISSING'
}

$Node = Get-Command node -ErrorAction SilentlyContinue
if($Node){
  foreach($jsPath in @(
    (Join-Path $Build 'ui\popup.js'),
    (Join-Path $Build 'content\banner_suppressor.js'),
    (Join-Path $Build 'options\options.js')
  )){
    & $Node.Source --check $jsPath
    if($LASTEXITCODE -ne 0){
      Die 'V011_VALIDATE_FAIL:JS_PARSE_FAIL' $jsPath
    }
  }
}

$Stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd_HHmmssZ')
$ProofDir = Join-Path $RepoRoot ('proofs\receipts\v011_dev_validate_' + $Stamp)
New-Item -ItemType Directory -Force $ProofDir | Out-Null

$Report = [ordered]@{
  schema = 'cookiegate.v011.dev_build_validation.report.v1'
  stamp_utc = $Stamp
  status = 'COOKIEGATE_V011_DEV_BUILD_VALIDATE_OK'
  build = $Build
  manifest_sha256 = Sha256File $ManifestPath
  popup_js_sha256 = Sha256File (Join-Path $Build 'ui\popup.js')
  popup_css_sha256 = Sha256File (Join-Path $Build 'ui\popup.css')
  banner_js_sha256 = Sha256File (Join-Path $Build 'content\banner_suppressor.js')
  options_js_sha256 = Sha256File (Join-Path $Build 'options\options.js')
  checks = @(
    'required files present',
    'options_ui registered',
    'banner content script registered',
    'popup cog launcher marker present',
    'floating launcher absent',
    'banner suppression setting key present',
    'node parse checks passed when node is available'
  )
}

$ReportPath = Join-Path $ProofDir 'v011_dev_build_validation_report.json'
Write-Utf8NoBomLf $ReportPath ($Report | ConvertTo-Json -Depth 20)


if($PopupJs -notmatch 'COOKIEGATE_V011_DOMAIN_OPS_FORM_POLISH'){
  Die 'V011_VALIDATE_FAIL:POPUP_MARKER_MISSING' 'COOKIEGATE_V011_DOMAIN_OPS_FORM_POLISH'

# COOKIEGATE_V011_VALIDATOR_DOMAIN_OPS_FORM_POLISH_MARKER_V4
if($PopupJs -notmatch 'COOKIEGATE_V011_DOMAIN_OPS_FORM_POLISH'){
  Die 'V011_VALIDATE_FAIL:POPUP_MARKER_MISSING' 'COOKIEGATE_V011_DOMAIN_OPS_FORM_POLISH'
}

# COOKIEGATE_V011_VALIDATOR_DOMAIN_OPS_UI_DEDUPE
if($PopupJs -notmatch 'COOKIEGATE_V011_DOMAIN_OPS_UI_DEDUPE'){
  Die 'V011_VALIDATE_FAIL:POPUP_MARKER_MISSING' 'COOKIEGATE_V011_DOMAIN_OPS_UI_DEDUPE'
}
}Write-Host 'COOKIEGATE_V011_DEV_BUILD_VALIDATE_OK' -ForegroundColor Green
Write-Host ('BUILD: ' + $Build) -ForegroundColor Green
Write-Host ('REPORT: ' + $ReportPath) -ForegroundColor Green
