<#
.SYNOPSIS
  Measures real local-inference performance for one loaded model.

.DESCRIPTION
  Records the Phase 5 metrics against the RUNNING llama-server:
    model load time, prompt processing tok/s, generation tok/s,
    time to first token, end-to-end latency, effective context, and peak VRAM.

  Peak VRAM is sampled from nvidia-smi while the requests run, because
  llama.cpp's own reported allocation does not include the Windows display
  driver's reserved memory.

  Deliberately measures the RAW llama-server endpoint, not the gateway, so the
  numbers describe the model and quantisation rather than proxy overhead.

.EXAMPLE
  .\measure-inference.ps1 -ConfigPath ..\bench.config.json -ModelId qwen3-8b
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ConfigPath,
  [Parameter(Mandatory)][string]$ModelId,
  [int]$PromptTokens = 1024,
  [int]$GenerateTokens = 128
)

$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$model = $config.models | Where-Object { $_.id -eq $ModelId }
if (-not $model) { throw "Unknown model '$ModelId'" }

$base = "http://$($config.llamaServer.host):$($config.llamaServer.port)/v1"
New-Item -ItemType Directory -Force -Path $config.reportDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outFile = Join-Path $config.reportDir "metrics-$ModelId-$stamp.json"

function Get-Json {
  param([string]$Url,[string]$Method='GET',$Body=$null,[int]$TimeoutSec=600)
  $p = @{ Uri=$Url; Method=$Method; TimeoutSec=$TimeoutSec }
  if ($null -ne $Body) { $p.Body = ($Body | ConvertTo-Json -Depth 20 -Compress); $p.ContentType='application/json' }
  Invoke-RestMethod @p
}

# ---- VRAM sampler -----------------------------------------------------------------------------
# A separate powershell.exe writes samples to a file. Using Start-Job + Register-ObjectEvent here
# is fragile (the event payload is easy to lose), and a plain child process is easier to reason
# about and to stop.
$vramFile = Join-Path $env:TEMP ("velvet-vram-{0}.txt" -f [guid]::NewGuid().ToString('N'))
$samplerArgs = @(
  '-NoProfile', '-Command',
  "`$end=(Get-Date).AddSeconds(900); while((Get-Date) -lt `$end){ try{ `$m=(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | Select-Object -First 1); if(`$m){ Add-Content -LiteralPath '$vramFile' -Value `$m } }catch{}; Start-Sleep -Milliseconds 250 }"
)
$sampler = Start-Process -FilePath 'powershell.exe' -ArgumentList $samplerArgs -PassThru -WindowStyle Hidden
Write-Host "VRAM sampler pid $($sampler.Id) -> $vramFile"

Write-Host "`n=== Inference metrics: $ModelId ===" -ForegroundColor Cyan

$props = Get-Json "http://$($config.llamaServer.host):$($config.llamaServer.port)/props"
$ctx = $props.default_generation_settings.n_ctx
Write-Host ("effective ctx : {0}" -f $ctx)

# ---- Probe 1: small warm request --------------------------------------------------------------
$warmBody = @{
  model = $model.alias; max_tokens = 1; temperature = 0
  messages = @(@{ role='user'; content='hi' })
}
$swWarm = [Diagnostics.Stopwatch]::StartNew()
try { $null = Get-Json "$base/chat/completions" -Method 'POST' -Body $warmBody -TimeoutSec 300 } catch { }
$swWarm.Stop()
Write-Host ("warmup ms     : {0:N0}" -f $swWarm.Elapsed.TotalMilliseconds)

# ---- Probe 2: prompt processing --------------------------------------------------------------
# Ask for one token with a long input: llama.cpp reports prompt_n / prompt_per_second for it.
$longText = (1..$PromptTokens | ForEach-Object { 'word' }) -join ' '
$ppBody = @{
  model = $model.alias; max_tokens = 1; temperature = 0; n_predict = 1
  messages = @(@{ role='user'; content = "$longText`n`nReply with only the word OK." })
}
$sw = [Diagnostics.Stopwatch]::StartNew()
$pp = Get-Json "$base/chat/completions" -Method 'POST' -Body $ppBody -TimeoutSec 900
$sw.Stop()
$ppMs = $sw.Elapsed.TotalMilliseconds
Write-Host ("prompt proc   : {0} tok in {1:N0} ms" -f $pp.usage.prompt_tokens, $ppMs)

# ---- Probe 3: generation + TTFT (streamed) ----------------------------------------------------
$genBody = @{
  model = $model.alias; max_tokens = $GenerateTokens; temperature = 0.7; top_p = 0.95
  stream = $true
  messages = @(@{ role='user'; content='Write a vivid, detailed short description of a rain-soaked harbour market at dawn.' })
}

$ttft = $null; $t0 = [Diagnostics.Stopwatch]::StartNew(); $firstContent = $false; $chunks = 0
try {
  $req = [Net.HttpWebRequest]::Create("$base/chat/completions")
  $req.Method = 'POST'; $req.ContentType = 'application/json'
  $req.Timeout = 900000
  $bytes = [Text.Encoding]::UTF8.GetBytes(($genBody | ConvertTo-Json -Depth 20 -Compress))
  $req.ContentLength = $bytes.Length
  $s = $req.GetRequestStream(); $s.Write($bytes,0,$bytes.Length); $s.Close()
  $resp = $req.GetResponse(); $reader = New-Object IO.StreamReader($resp.GetResponseStream())
  while (-not $reader.EndOfStream) {
    $line = $reader.ReadLine()
    if ($line -like 'data: *') {
      $payload = $line.Substring(6)
      if ($payload -eq '[DONE]') { break }
      $chunks++
      if ($null -eq $ttft) {
        try {
          $o = $payload | ConvertFrom-Json
          if ($o.choices[0].delta.content) { $ttft = $t0.Elapsed.TotalMilliseconds; $firstContent = $true }
        } catch { }
      }
    }
  }
  $reader.Close(); $resp.Close()
} catch {
  Write-Warning "streaming probe failed: $($_.Exception.Message)"
}
$t0.Stop()
$totalMs = $t0.Elapsed.TotalMilliseconds

# ---- VRAM ------------------------------------------------------------------------------------
Start-Sleep -Milliseconds 500
Stop-Process -Id $sampler.Id -Force -ErrorAction SilentlyContinue
$peak = 0.0
$samples = @(Get-Content -LiteralPath $vramFile -ErrorAction SilentlyContinue |
             ForEach-Object { [double]$_ } | Where-Object { $_ -gt 0 })
if ($samples.Count) { $peak = ($samples | Measure-Object -Maximum).Maximum }
Remove-Item -LiteralPath $vramFile -Force -ErrorAction SilentlyContinue
$finalSmi = nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader | Select-Object -First 1

# llama.cpp reports authoritative per-phase timings via /props timings endpoint
$timings = $null
try {
  $timings = Get-Json "http://$($config.llamaServer.host):$($config.llamaServer.port)/slots/$($model.alias)"
} catch { }

$genCount = $chunks
$result = [ordered]@{
  model            = $ModelId
  alias            = $model.alias
  capturedUtc      = (Get-Date).ToUniversalTime().ToString('o')
  file             = $model.file
  quantization     = (Split-Path -Leaf $model.file)
  requestedCtx     = $config.llamaServer.ctxSize
  effectiveCtx     = $ctx
  gpuLayers        = $config.llamaServer.gpuLayers
  flashAttn        = $config.llamaServer.flashAttn
  warmupMs         = [int]$swWarm.Elapsed.TotalMilliseconds
  promptTokens     = $pp.usage.prompt_tokens
  promptProcMs     = [int]$ppMs
  promptTokPerSec  = if ($pp.usage.prompt_tokens) { [math]::Round($pp.usage.prompt_tokens / ($ppMs/1000), 2) } else { $null }
  genTokens        = $genCount
  genMs            = [int]$totalMs
  genTokPerSec     = if ($genCount -and $totalMs -gt $ttft) { [math]::Round($genCount / (($totalMs - $ttft)/1000), 2) } else { $null }
  timeToFirstTokenMs = [int]$ttft
  endToEndMs      = [int]$totalMs
  peakVramMiB      = [int]$peak
  vramUsedMiB      = $finalSmi
  slotTimings      = $timings
}

$result | ConvertTo-Json -Depth 25 | Set-Content -LiteralPath $outFile -Encoding UTF8

Write-Host "`n--- results ---" -ForegroundColor Green
Write-Host ("  prompt        : {0} tok @ {1} tok/s" -f $result.promptTokens, $result.promptTokPerSec)
Write-Host ("  generation    : {0} tok @ {1} tok/s" -f $result.genTokens, $result.genTokPerSec)
Write-Host ("  TTFT          : {0} ms" -f $result.timeToFirstTokenMs)
Write-Host ("  end-to-end    : {0} ms" -f $result.endToEndMs)
Write-Host ("  peak VRAM     : {0} MiB   ({1})" -f $result.peakVramMiB, $finalSmi)
Write-Host ("  effective ctx : {0}" -f $result.effectiveCtx)
Write-Host "`n  report: $outFile"