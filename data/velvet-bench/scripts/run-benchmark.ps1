<#
.SYNOPSIS
  Runs the complete stock-model baseline benchmark for one model against a live VelvetRP.

.DESCRIPTION
  Orchestrates the Phase 7 suites in a fixed order so two runs are comparable:

    1. preflight      VelvetRP's own provider capability probe (function-tools,
                      strict-json-schema), captured independently.
    2. metrics        inference performance (pp/tg tok/s, TTFT, peak VRAM).
    3. freeform       the repository's existing 18-turn free-form evaluator
                      (scripts/freeform-fun-eval.ts) driven over real HTTP against a
                      freshly bootstrapped world. Creative roleplay + world-state probes.
    4. conformance    RPG provider-contract conformance against the running model.
    5. export         bundles every artifact with its hash.

  Deterministic correctness is reported separately from subjective narrative quality.
  The evaluator's own verdict and probe outcomes are the deterministic signals; narration
  provider share, latency, and materialisation rate are descriptive.

.EXAMPLE
  .\run-benchmark.ps1 -ConfigPath ..\bench.config.json -ModelId qwen3-8b
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ConfigPath,
  [Parameter(Mandatory)][string]$ModelId,
  [int]$Turns = 0,
  [int]$Seed = 0,
  [switch]$SkipFreeform
)

$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$model = $config.models | Where-Object { $_.id -eq $ModelId }
if (-not $model) { throw "Unknown model '$ModelId'" }
$repo = $config.velvetRepo
$reportDir = $config.reportDir
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null

if ($Turns  -le 0) { $Turns  = [int]$config.eval.freeformTurns }
if ($Seed   -le 0) { $Seed   = [int]$config.eval.freeformSeed }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runDir = Join-Path $reportDir "run-$ModelId-$stamp"
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$summary = [ordered]@{
  model        = $ModelId
  alias        = $model.alias
  file         = $model.file
  repository   = $model.huggingface.repo
  revision     = $model.huggingface.revision
  license      = $model.huggingface.license
  velvetCommit = $config.velvetCommit
  startedUtc   = (Get-Date).ToUniversalTime().ToString('o')
  node         = (& node --version)
  gpu          = (nvidia-smi --query-gpu=name,driver_version --format=csv,noheader | Select-Object -First 1)
  suites       = [ordered]@{}
}

function Save-Suite($name, $obj) {
  $p = Join-Path $runDir "$name.json"
  $obj | ConvertTo-Json -Depth 60 | Set-Content -LiteralPath $p -Encoding UTF8
  $summary.suites[$name] = $p
  Write-Host "    saved -> $p" -ForegroundColor DarkGray
}

Write-Host "`n################  BASELINE RUN: $ModelId  ################" -ForegroundColor Magenta
Write-Host "velvet commit : $($config.velvetCommit)"
Write-Host "model         : $($model.file)"
Write-Host "artifacts     : $runDir"

# --- 1. preflight ------------------------------------------------------------------------------
Write-Host "`n[1/4] provider preflight (deterministic capability)" -ForegroundColor Cyan
$api = "http://$($config.velvet.host):$($config.velvet.port)"
$gwBase = "http://$($config.gateway.host):$($config.gateway.port)"
$put = Invoke-RestMethod -Uri "$api/api/provider" -Method PUT -TimeoutSec 60 -ContentType 'application/json' `
      -Body (@{ baseUrl = "$gwBase/v1"; model = $model.alias; apiKey = $config.velvet.apiKey
                providerType = $config.velvet.providerType; streaming = $true } | ConvertTo-Json -Depth 10)
$pre = [ordered]@{}
try {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $pf = Invoke-RestMethod -Uri "$api/api/provider/preflight" -Method POST -TimeoutSec 600 -ContentType 'application/json' -Body '{}'
  $sw.Stop()
  $pre = [ordered]@{
    dmPlayCompatible           = $pf.dmPlayCompatible
    campaignGenerationCompatible = $pf.campaignGenerationCompatible
    ok                         = $pf.ok
    capabilities               = $pf.capabilities
    elapsedMs                  = [int]$sw.Elapsed.TotalMilliseconds
  }
} catch {
  $pre = [ordered]@{ error = $_.Exception.Message }
}
Save-Suite '01-preflight' $pre
Write-Host "    dmPlay=$($pre.dmPlayCompatible)  campaignGen=$($pre.campaignGenerationCompatible)  ok=$($pre.ok)"

# --- 2. metrics --------------------------------------------------------------------------------
Write-Host "`n[2/4] inference metrics" -ForegroundColor Cyan
$metricsFile = Join-Path $runDir '02-metrics.json'
try {
  & (Join-Path $PSScriptRoot 'measure-inference.ps1') -ConfigPath $ConfigPath -ModelId $ModelId | Out-Null
  $latest = Get-ChildItem -LiteralPath $reportDir -Filter "metrics-$ModelId-*.json" |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($latest) { Copy-Item -LiteralPath $latest.FullName -Destination $metricsFile -Force; $summary.suites['02-metrics'] = $metricsFile }
} catch {
  $summary.suites['02-metrics'] = "FAILED: $($_.Exception.Message)"
  Write-Warning $_.Exception.Message
}

# --- 3. free-form 18-turn evaluator ------------------------------------------------------------
if (-not $SkipFreeform) {
  Write-Host "`n[3/4] free-form evaluator ($Turns turns, seed $Seed) - this takes a long time on a local 8B" -ForegroundColor Cyan
  $worldDir = Join-Path $runDir 'world'
  $outJson  = Join-Path $runDir '03-freeform-fun-eval.json'
  $env:FREEFORM_FUN_EVAL_BASE_URL = "$gwBase/v1"
  $env:FREEFORM_FUN_EVAL_API_KEY  = $config.velvet.apiKey
  $env:FREEFORM_FUN_EVAL_MODEL    = $model.alias
  try {
    Push-Location $repo
    & npx tsx scripts/freeform-fun-eval.ts --data-dir="$worldDir" --turns=$Turns --seed=$Seed --out="$outJson" --quiet
    $exit = $LASTEXITCODE
    Pop-Location
    Write-Host "    evaluator exit code: $exit"
    $summary.suites['03-freeform'] = $outJson
    $summary.freeformExitCode = $exit
  } catch {
    $summary.suites['03-freeform'] = "FAILED: $($_.Exception.Message)"
    Write-Warning $_.Exception.Message
  }
} else {
  $summary.suites['03-freeform'] = 'SKIPPED'
}

# --- 4. conformance -----------------------------------------------------------------------------
Write-Host "`n[4/4] RPG provider-contract conformance" -ForegroundColor Cyan
$confOut = Join-Path $runDir '04-conformance.json'
try {
  & node (Join-Path (Split-Path -Parent $PSScriptRoot) 'conformance\run-conformance.mjs') `
        --config $ConfigPath --model $ModelId --out $confOut
  $summary.suites['04-conformance'] = $confOut
} catch {
  $summary.suites['04-conformance'] = "FAILED: $($_.Exception.Message)"
  Write-Warning $_.Exception.Message
}

# --- summary -----------------------------------------------------------------------------------
$summary.finishedUtc = (Get-Date).ToUniversalTime().ToString('o')
$summaryPath = Join-Path $runDir 'SUMMARY.json'
$summary | ConvertTo-Json -Depth 60 | Set-Content -LiteralPath $summaryPath -Encoding UTF8

Write-Host "`n################  RUN COMPLETE  ################" -ForegroundColor Magenta
Write-Host "summary: $summaryPath"