<#
.SYNOPSIS
  VelvetRP stock-model baseline workstation control script (Windows / PowerShell 5.1+).

.DESCRIPTION
  Single entry point for every repeatable operation in BASELINE_INFERENCE_SETUP.md.
  All machine-specific values come from bench.config.json, never from hard-coded
  literals, and every path is handled with -LiteralPath so spaces are safe.

  Commands:
    install              Verify Node/npm/git/python and print environment facts
    health               Check llama-server, gateway, and VelvetRP health endpoints
    start-llm            Start llama-server for one configured model
    stop-llm             Stop llama-server and the gateway
    start-gateway        Start the named-tool_choice compatibility gateway
    start-velvet         Start the VelvetRP API + Vite client with an explicit data dir
    stop-velvet          Stop VelvetRP processes started by this script
    preflight            Run VelvetRP's provider capability preflight against a model
    bench                Run the full baseline benchmark for one model
    metrics              Measure raw inference performance (pp/tg/TTFT/VRAM)
    export               Collect all artifacts into one timestamped bundle
    list-models          Show configured models and local file/checksum status

.EXAMPLE
  .\Invoke-VelvetBench.ps1 list-models
  .\Invoke-VelvetBench.ps1 start-llm -ModelId qwen3-8b
  .\Invoke-VelvetBench.ps1 preflight -ModelId qwen3-8b
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$Command = 'help',
  [string]$ModelId,
  [int]$ContextSize = 0,
  [switch]$NoGateway,
  [switch]$RawLlamaCpp,
  [switch]$Keep
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BenchDir = Split-Path -Parent $ScriptDir
$ConfigPath = Join-Path $BenchDir 'bench.config.json'

function Write-Step  { param([string]$m) Write-Host "`n==> $m" -ForegroundColor Cyan }
function Write-Ok    { param([string]$m) Write-Host "    [ok]   $m" -ForegroundColor Green }
function Write-Warn2 { param([string]$m) Write-Host "    [warn] $m" -ForegroundColor Yellow }
function Write-Err2  { param([string]$m) Write-Host "    [FAIL] $m" -ForegroundColor Red }

# Set-StrictMode makes property access on a missing key throw, which breaks the
# `.__error` sentinel below. This helper is the safe way to read an optional field.
function Get-Prop {
  param($Object, [string]$Name, $Default = $null)
  if ($null -eq $Object) { return $Default }
  $p = $Object.PSObject.Properties[$Name]
  if ($null -eq $p) { return $Default }
  $p.Value
}

function Get-Config {
  if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "Config not found: $ConfigPath" }
  $c = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  foreach ($k in 'velvetRepo','modelDir','llamaRuntimeDir','velvetDataDir','reportDir') {
    if (-not $c.$k) { throw "Config key '$k' missing from $ConfigPath" }
  }
  $c
}

function Get-ModelEntry {
  param($Config, [string]$Id)
  if (-not $Id) { throw "This command requires -ModelId. Known: $(($Config.models | ForEach-Object { $_.id }) -join ', ')" }
  $m = $Config.models | Where-Object { $_.id -eq $Id }
  if (-not $m) { throw "Unknown model id '$Id'. Known: $(($Config.models | ForEach-Object { $_.id }) -join ', ')" }
  $m
}

function Get-ModelPath {
  param($Config, $Model)
  Join-Path -Path $Config.modelDir -ChildPath $Model.file
}

function Invoke-Json {
  param([string]$Url, [string]$Method = 'GET', $Body = $null, [int]$TimeoutSec = 60)
  $params = @{ Uri = $Url; Method = $Method; TimeoutSec = $TimeoutSec }
  if ($Body -ne $null) {
    $params.Body = ($Body | ConvertTo-Json -Depth 40 -Compress)
    $params.ContentType = 'application/json'
  }
  try { return Invoke-RestMethod @params }
  catch {
    $resp = $_.Exception.Response
    if ($resp) {
      $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
      $text = $reader.ReadToEnd()
      return [pscustomobject]@{ __error = $true; status = [int]$resp.StatusCode; body = $text }
    }
    throw
  }
}

# ---------------------------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------------------------

function Cmd-Install {
  param($Config)
  Write-Step 'Environment verification'
  $node = & node --version 2>&1
  Write-Ok "node          $node"
  if ([int]($node -replace 'v','' -split '\.')[0] -lt 22) { Write-Warn2 'VelvetRP documents Node 22; a newer major may work but is not the documented target.' }
  Write-Ok "npm           $(& npm --version 2>&1)"
  Write-Ok "git           $(& git --version 2>&1)"
  Write-Ok "python        $(& python --version 2>&1)"

  Write-Step 'GPU'
  $smi = & nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used --format=csv,noheader 2>&1
  Write-Ok $smi

  Write-Step 'llama-server binary'
  $exe = Join-Path $Config.llamaRuntimeDir 'llama-server.exe'
  if (Test-Path -LiteralPath $exe) {
    Write-Ok "found: $exe"
    Write-Ok "version: $(& $exe --version 2>&1 | Select-Object -First 1)"
  } else {
    Write-Warn2 "missing: $exe (run the install steps in BASELINE_INFERENCE_SETUP.md)"
  }
  foreach ($dll in 'ggml-cuda.dll','cudart64_13.dll','cublas64_13.dll','cublasLt64_13.dll') {
    $p = Join-Path $Config.llamaRuntimeDir $dll
    if (Test-Path -LiteralPath $p) { Write-Ok "dll present: $dll" } else { Write-Err2 "dll MISSING: $dll" }
  }
}

function Cmd-ListModels {
  param($Config)
  Write-Step 'Configured models'
  foreach ($m in $Config.models) {
    $p = Get-ModelPath $Config $m
    $tag = if (Get-Prop $m 'optional' $false) { ' [optional]' } else { '' }
    Write-Host "  $($m.id)$tag" -ForegroundColor White
    Write-Host "      file       : $($m.file)"
    Write-Host "      present    : $(Test-Path -LiteralPath $p)"
    if (Test-Path -LiteralPath $p) {
      $f = Get-Item -LiteralPath $p
      Write-Host ("      size       : {0:N2} GB" -f ($f.Length / 1GB))
    }
    Write-Host "      hf repo    : $($m.huggingface.repo)"
    Write-Host "      revision   : $($m.huggingface.revision)"
    Write-Host "      license    : $($m.huggingface.license)"
    $prov = "$p.provenance.json"
    if (Test-Path -LiteralPath $prov) {
      $j = Get-Content -LiteralPath $prov -Raw | ConvertFrom-Json
      Write-Host ("      sha256     : {0}" -f (Get-Prop $j 'sha256' (Get-Prop $j 'outputSha256' 'not recorded')))
    }
    Write-Host ""
  }
}

function Cmd-StartLlama {
  param($Config, $Model, [int]$CtxOverride = 0, [switch]$NoGw)
  $exe = Join-Path $Config.llamaRuntimeDir 'llama-server.exe'
  if (-not (Test-Path -LiteralPath $exe)) { throw "llama-server.exe not found at $exe" }
  $modelPath = Get-ModelPath $Config $Model
  if (-not (Test-Path -LiteralPath $modelPath)) { throw "Model file not found: $modelPath" }

  $ctx = if ($CtxOverride -gt 0) { $CtxOverride } else { [int]$Config.llamaServer.ctxSize }
  $ls = $Config.llamaServer
  $logDir = $Config.reportDir
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $log = Join-Path $logDir "llama-server-$($Model.id).log"

  Write-Step "Starting llama-server for '$($Model.id)'"
  Write-Ok "model      : $modelPath"
  Write-Ok "alias      : $($Model.alias)"
  Write-Ok "ctx        : $ctx"
  Write-Ok "gpu-layers : $($ls.gpuLayers)"
  Write-Ok "port       : $($ls.port)"
  Write-Ok "log        : $log"

  $argList = @(
    '-m', $modelPath,
    '--host', $ls.host,
    '--port', "$($ls.port)",
    '--alias', $Model.alias,
    '-ngl', "$($ls.gpuLayers)",
    '-c', "$ctx",
    '-np', "$($ls.parallel)",
    '-t', "$($ls.threads)",
    '--jinja',
    '--no-ui'
  )
  # In build 11574 -fa takes an explicit value (on|off|auto); a bare -fa would swallow the next arg.
  if ($ls.flashAttn) { $argList += @('-fa', 'on') }
  # KV cache quantisation: q8_0 keeps tool-calling quality while fitting a large context alongside
  # the weights on an 8 GiB card. llama.cpp warns that heavy KV quantisation degrades tool calling.
  if ($ls.cacheTypeK) { $argList += @('-ctk', $ls.cacheTypeK) }
  if ($ls.cacheTypeV) { $argList += @('-ctv', $ls.cacheTypeV) }
  # Multimodal models need the projector file or loading fails / silently degrades.
  $mmproj = Get-Prop $Model 'mmproj' $null
  if ($mmproj) {
    $mp = Join-Path $Config.modelDir $mmproj
    if (-not (Test-Path -LiteralPath $mp)) { throw "mmproj not found: $mp" }
    $argList += @('--mmproj', $mp)
    # The projector is irrelevant to text-only benchmarking and costs ~876 MiB of VRAM.
    # Keeping it on CPU is what lets 24576 context fit on an 8 GiB card.
    if ((Get-Prop $Model 'mmprojOffload' $true) -eq $false) { $argList += '--no-mmproj-offload' }
  }
  # Per-model reasoning mode. llama.cpp prefers --reasoning on|off|auto over the deprecated
  # enable_thinking template kwarg, and it takes no JSON argument, so PowerShell's habit of
  # stripping inner quotes from native-command arguments cannot corrupt it.
  $reasoning = Get-Prop $Model 'reasoning' $null
  if ($reasoning) { $argList += @('--reasoning', $reasoning) }

  $existing = Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" -ErrorAction SilentlyContinue
  if ($existing) { Write-Warn2 "llama-server already running (PID $($existing.ProcessId -join ',')); stopping it first."; Stop-Llama }

  $p = Start-Process -FilePath $exe -ArgumentList $argList -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err" -WindowStyle Hidden
  Write-Ok "pid        : $($p.Id)"

  Write-Step 'Waiting for server readiness (model load)'
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $ready = $false
  while ($sw.Elapsed.TotalSeconds -lt 300) {
    Start-Sleep -Seconds 2
    if ($p.HasExited) { Write-Err2 "llama-server exited early. See $log.err"; break }
    try {
      $h = Invoke-Json "http://$($ls.host):$($ls.port)/health" -TimeoutSec 5
      if ($h.status -eq 'ok') { $ready = $true; break }
    } catch { }
  }
  if ($ready) {
    Write-Ok ("READY in {0:N1}s" -f $sw.Elapsed.TotalSeconds)
    $props = Invoke-Json "http://$($ls.host):$($ls.port)/props" -TimeoutSec 15
    if ($props -and $props.default_generation_settings) {
      Write-Ok "n_ctx       : $($props.default_generation_settings.n_ctx)"
      Write-Ok "model path  : $($props.model_path)"
    }
  } else {
    Write-Err2 'Server did not become ready within 300s.'
    Write-Host '--- last 40 log lines ---'
    Get-Content -LiteralPath "$log.err" -Tail 40 -ErrorAction SilentlyContinue
    return $false
  }

  if (-not $NoGw) { Start-Gateway -Config $Config | Out-Null }
  return $true
}

function Start-Gateway {
  param($Config)
  $script = Join-Path $BenchDir 'gateway\velvet-llm-gateway.mjs'
  if (-not (Test-Path -LiteralPath $script)) { throw "Gateway script missing: $script" }
  $g = $Config.gateway
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $g.log) | Out-Null

  $existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*velvet-llm-gateway*' }
  if ($existing) { Write-Ok "Gateway already running (PID $($existing.ProcessId -join ','))"; return }

  Write-Step 'Starting velvet-llm-gateway (named tool_choice compatibility)'
  $logOut = Join-Path (Split-Path -Parent $g.log) 'gateway.out.log'
  $p = Start-Process -FilePath 'node' -ArgumentList @(
      $script, '--host', $g.host, '--port', "$($g.port)", '--upstream', "http://$($Config.llamaServer.host):$($Config.llamaServer.port)", '--log', $g.log
    ) -PassThru -RedirectStandardOutput $logOut -RedirectStandardError "$logOut.err" -WindowStyle Hidden
  Start-Sleep -Seconds 2
  if ($p.HasExited) { Write-Err2 "Gateway exited: $(Get-Content -LiteralPath "$logOut.err" -Raw)"; return }
  Write-Ok "gateway     : http://$($g.host):$($g.port)  (pid $($p.Id))"
  Write-Ok "upstream    : http://$($Config.llamaServer.host):$($Config.llamaServer.port)"
  Write-Ok "note        : only named tool_choice is translated; responses pass through byte-for-byte"
}

function Stop-Llama {
  $p = Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" -ErrorAction SilentlyContinue
  if ($p) { $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Write-Ok 'llama-server stopped' }
  $g = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
       Where-Object { $_.CommandLine -like '*velvet-llm-gateway*' }
  if ($g) { $g | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Write-Ok 'gateway stopped' }
}

function Cmd-Health {
  param($Config)
  Write-Step 'Service health'
  $targets = @(
    @{ name = 'llama-server'; url = "http://$($Config.llamaServer.host):$($Config.llamaServer.port)/health" },
    @{ name = 'gateway';      url = "http://$($Config.gateway.host):$($Config.gateway.port)/gateway/stats" },
    @{ name = 'velvet-api';   url = "http://$($Config.velvet.host):$($Config.velvet.port)/api/health" },
    @{ name = 'velvet-ui';    url = "http://127.0.0.1:$($Config.velvet.clientPort)/" }
  )
  foreach ($t in $targets) {
    try {
      $r = Invoke-WebRequest -Uri $t.url -UseBasicParsing -TimeoutSec 8
      Write-Ok ("{0,-13} {1}" -f $t.name, $r.StatusCode)
    } catch {
      Write-Warn2 ("{0,-13} unreachable ({1})" -f $t.name, $_.Exception.Message.Split([Environment]::NewLine)[0])
    }
  }
}

function Cmd-StartVelvet {
  param($Config)
  Write-Step 'Starting VelvetRP'
  $env:HOST = $Config.velvet.host
  $env:PORT = "$($Config.velvet.port)"
  $env:VELVET_DATA_DIR = $Config.velvetDataDir
  $env:VELVET_API_URL = "http://$($Config.velvet.host):$($Config.velvet.port)"
  $env:FEATURE_RPG_CAMPAIGN = 'true'
  $env:FEATURE_RPG_MECHANICS = 'true'
  $env:FEATURE_RPG_COMBAT = 'true'
  $env:FEATURE_RPG_STUDIO = 'true'
  # Provider bootstrap defaults. A stored provider row wins over these, so the
  # preflight command writes the real profile through the API.
  $env:OPENAI_BASE_URL = "http://$($Config.gateway.host):$($Config.gateway.port)/v1"
  $env:OPENAI_API_KEY  = $Config.velvet.apiKey
  $env:OPENAI_MODEL    = ''

  New-Item -ItemType Directory -Force -Path $Config.velvetDataDir | Out-Null
  Write-Ok "data dir    : $($Config.velvetDataDir)"
  Write-Ok "api         : http://$($Config.velvet.host):$($Config.velvet.port)/api/health"
  Write-Ok "ui          : http://127.0.0.1:$($Config.velvet.clientPort)"

  $logDir = $Config.reportDir
  $p = Start-Process -FilePath 'npm.cmd' -ArgumentList 'run','dev' -WorkingDirectory $Config.velvetRepo `
        -PassThru -RedirectStandardOutput (Join-Path $logDir 'velvet-dev.out.log') `
        -RedirectStandardError (Join-Path $logDir 'velvet-dev.err.log') -WindowStyle Hidden
  Write-Ok "npm run dev pid $($p.Id)"

  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt 120) {
    Start-Sleep -Seconds 3
    try {
      $h = Invoke-Json "http://$($Config.velvet.host):$($Config.velvet.port)/api/health" -TimeoutSec 5
      if ($h) { Write-Ok ("API ready in {0:N1}s" -f $sw.Elapsed.TotalSeconds); return }
    } catch { }
  }
  Write-Err2 'Velvet API did not become ready in 120s.'
}

function Cmd-Preflight {
  param($Config, $Model, [switch]$Raw)
  $base = if ($Raw -or $RawLlamaCpp) { "http://$($Config.llamaServer.host):$($Config.llamaServer.port)" } else { "http://$($Config.gateway.host):$($Config.gateway.port)" }
  $api  = "http://$($Config.velvet.host):$($Config.velvet.port)"

  Write-Step "Provider preflight for '$($Model.id)' via $base"
  $put = Invoke-Json "$api/api/provider" -Method 'PUT' -Body @{
    baseUrl = "$base/v1"; model = $Model.alias; apiKey = $Config.velvet.apiKey
    providerType = $Config.velvet.providerType; streaming = $true
  }
  if ((Get-Prop $put '__error' $false)) { Write-Err2 "PUT /api/provider failed ($((Get-Prop $put 'status'))): $((Get-Prop $put 'body'))"; return $null }
  Write-Ok "provider configured: baseUrl=$base/v1 model=$($Model.alias)"

  Write-Step 'Running preflight (function-tools and strict-json-schema are probed separately)'
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $pf = Invoke-Json "$api/api/provider/preflight" -Method 'POST' -Body @{}
  $ms = [int]$sw.Elapsed.TotalMilliseconds

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $out = Join-Path $Config.reportDir "preflight-$($Model.id)-$stamp.json"
  New-Item -ItemType Directory -Force -Path $Config.reportDir | Out-Null
  @{ model = $Model.id; alias = $Model.alias; baseUrl = "$base/v1"; viaGateway = -not ($Raw -or $RawLlamaCpp)
     elapsedMs = $ms; capturedUtc = (Get-Date).ToUniversalTime().ToString('o'); result = $pf } | ConvertTo-Json -Depth 30 |
    Set-Content -LiteralPath $out

  if ((Get-Prop $pf '__error' $false)) { Write-Err2 "preflight HTTP $((Get-Prop $pf 'status')): $((Get-Prop $pf 'body'))"; return $pf }
  Write-Ok "dmPlayCompatible          : $((Get-Prop $pf 'dmPlayCompatible'))"
  Write-Ok "campaignGenerationCompatible: $((Get-Prop $pf 'campaignGenerationCompatible'))"
  Write-Ok "ok                        : $((Get-Prop $pf 'ok'))"
  foreach ($c in (Get-Prop $pf 'capabilities' @())) {
    $f = Get-Prop $c 'failure' $null
    Write-Host ("    - {0}: {1} {2}" -f $c.capability, $c.status, $(if ($f) { "($($f.code))" } else { '' }))
  }
  Write-Ok "report: $out"
  return $pf
}

function Cmd-Metrics {
  param($Config, $Model)
  $script = Join-Path $ScriptDir 'measure-inference.ps1'
  if (-not (Test-Path -LiteralPath $script)) { throw "measure-inference.ps1 missing at $script" }
  & $script -ConfigPath $ConfigPath -ModelId $Model.id
}

function Cmd-Bench {
  param($Config, $Model)
  $api = "http://$($Config.velvet.host):$($Config.velvet.port)"
  Write-Step "Baseline benchmark for '$($Model.id)'"
  Write-Warn2 'This drives the real application over HTTP. Expect long runtimes on an 8B local model.'
  $runner = Join-Path $ScriptDir 'run-benchmark.ps1'
  if (-not (Test-Path -LiteralPath $runner)) { throw 'run-benchmark.ps1 missing' }
  & $runner -ConfigPath $ConfigPath -ModelId $Model.id
}

function Cmd-Export {
  param($Config)
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $dest = Join-Path $Config.reportDir "bundle-$stamp"
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Copy-Item -LiteralPath $ConfigPath -Destination $dest
  Get-ChildItem -LiteralPath $Config.reportDir -File -ErrorAction SilentlyContinue |
    Copy-Item -Destination $dest -ErrorAction SilentlyContinue
  $prov = Join-Path $Config.modelDir '*.provenance.json'
  Get-ChildItem -Path $prov -ErrorAction SilentlyContinue | Copy-Item -Destination $dest -ErrorAction SilentlyContinue
  $manifest = Join-Path $dest 'MANIFEST.txt'
  "bundle      : $dest" | Set-Content -LiteralPath $manifest
  "createdUtc  : $((Get-Date).ToUniversalTime().ToString('o'))" | Add-Content -LiteralPath $manifest
  "velvetCommit: $($Config.velvetCommit)" | Add-Content -LiteralPath $manifest
  "node        : $(& node --version)" | Add-Content -LiteralPath $manifest
  "host        : $env:COMPUTERNAME" | Add-Content -LiteralPath $manifest
  & nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader | Add-Content -LiteralPath $manifest
  Write-Ok "bundle: $dest"
}

# ---------------------------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------------------------

$config = Get-Config
switch ($Command.ToLower()) {
  'install'      { Cmd-Install      $config }
  'health'       { Cmd-Health       $config }
  'list-models'  { Cmd-ListModels   $config }
  'start-llm'    { $m = Get-ModelEntry $config $ModelId; [void](Cmd-StartLlama $config $m $ContextSize -NoGw:$NoGateway) }
  'stop-llm'     { Stop-Llama }
  'start-gateway'{ Start-Gateway    $config }
  'start-velvet' { Cmd-StartVelvet  $config }
  'preflight'    { $m = Get-ModelEntry $config $ModelId; [void](Cmd-Preflight $config $m -Raw:$RawLlamaCpp) }
  'metrics'      { $m = Get-ModelEntry $config $ModelId; Cmd-Metrics $config $m }
  'bench'        { $m = Get-ModelEntry $config $ModelId; Cmd-Bench $config $m }
  'export'       { Cmd-Export       $config }
  default {
    Write-Host @"
VelvetRP baseline workstation commands:
  install              verify toolchain, GPU, and llama.cpp binaries
  list-models          show configured models, revisions, and checksums
  start-llm -ModelId X start llama-server (+ gateway unless -NoGateway)
  start-gateway        start the named-tool_choice compatibility gateway only
  start-velvet         start VelvetRP API + Vite with an explicit data directory
  health               probe every service endpoint
  preflight -ModelId X run VelvetRP provider preflight (add -RawLlamaCpp to bypass the gateway)
  metrics -ModelId X   measure pp/tg, TTFT, and peak VRAM
  bench -ModelId X     run the full baseline benchmark
  stop-llm             stop llama-server and gateway
  export               bundle all reports + provenance into a timestamped folder
"@ -ForegroundColor Gray
  }
}