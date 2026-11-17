#Requires -Version 5.1
<#
.SYNOPSIS
    One-click setup for YT音轨翻译 (YT Audio Translator) local services.

.DESCRIPTION
    Installs the two services the extension talks to:
      1. speech recognition  - faster-whisper behind an OpenAI-compatible
                               /v1/audio/transcriptions endpoint on port 8000
      2. translation         - Ollama model qwen2.5:3b on port 11434

    Everything lives under -InstallDir. Nothing outside that folder is modified
    except the user-level OLLAMA_ORIGINS variable, which Ollama needs in order to
    accept requests from a Chrome extension origin.

.PARAMETER InstallDir
    Where to put the venv, the server script and the start scripts.

.PARAMETER AsrModel
    faster-whisper model: tiny / base / small / medium. `base` is the sweet spot
    for real-time subtitles; `small` is ~3x slower but more accurate.

.PARAMETER Threads
    CPU threads for faster-whisper. Default 12.

.PARAMETER OllamaModel
    Ollama model to pull. Default qwen2.5:3b.

.EXAMPLE
    .\install.ps1

.EXAMPLE
    .\install.ps1 -AsrModel small -Threads 20

.NOTES
    ASCII-only on purpose: Windows PowerShell reads .ps1 files without a BOM as
    ANSI, which corrupts non-ASCII text and breaks parsing.
#>

[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'yt-audio-translator'),
    [string]$AsrModel = 'base',
    [int]$Threads = 12,
    [string]$OllamaModel = 'qwen2.5:3b',
    [switch]$SkipAsr,
    [switch]$SkipOllama,
    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$script:RawUrl = 'https://raw.githubusercontent.com/LeoHwang74/yt-audio-translator/main/tools/asr_server.py'
$script:Ok = 0
$script:Warn = 0

function Write-Step([string]$text) {
    Write-Host ''
    Write-Host "==> $text" -ForegroundColor Cyan
}

function Write-Ok([string]$text) {
    $script:Ok++
    Write-Host "    OK   $text" -ForegroundColor Green
}

function Write-Warn2([string]$text) {
    $script:Warn++
    Write-Host "    WARN $text" -ForegroundColor Yellow
}

function Write-Info([string]$text) {
    Write-Host "         $text" -ForegroundColor DarkGray
}

function Find-Python {
    $candidates = @(
        @{ Exe = 'py'; Args = @('-3') },
        @{ Exe = 'python'; Args = @() },
        @{ Exe = "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"; Args = @() },
        @{ Exe = 'C:\Program Files\Python312\python.exe'; Args = @() },
        @{ Exe = 'C:\Program Files\Python311\python.exe'; Args = @() }
    )
    foreach ($c in $candidates) {
        $exe = $c.Exe
        if ($exe -match '[\\/]') {
            if (-not (Test-Path $exe)) { continue }
        } else {
            if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
        }
        try {
            $out = & $exe @($c.Args) '--version' 2>&1
            $line = ($out | Out-String).Trim()
            if ($line -match 'Python (\d+)\.(\d+)') {
                $major = [int]$Matches[1]
                $minor = [int]$Matches[2]
                if ($major -eq 3 -and $minor -ge 9) {
                    return @{ Exe = $exe; Args = $c.Args; Version = $line }
                }
            }
        } catch {
            continue
        }
    }
    return $null
}

function Find-Ollama {
    $cmd = Get-Command ollama -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $fallback = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
    if (Test-Path $fallback) { return $fallback }
    return $null
}

function Test-Endpoint([string]$url, [int]$timeoutSec = 3) {
    try {
        $null = Invoke-RestMethod $url -TimeoutSec $timeoutSec
        return $true
    } catch {
        return $false
    }
}

Write-Host ''
Write-Host '  YT Audio Translator - local services installer' -ForegroundColor White
Write-Host '  ------------------------------------------------' -ForegroundColor DarkGray
Write-Info "install dir : $InstallDir"
Write-Info "asr model   : $AsrModel ($Threads threads, port 8000)"
Write-Info "ollama      : $OllamaModel (port 11434)"

# ---------------------------------------------------------------- directories
Write-Step 'Preparing install directory'
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$venvDir = Join-Path $InstallDir 'venv'
$hfHome = Join-Path $InstallDir 'hf-cache'
New-Item -ItemType Directory -Force -Path $hfHome | Out-Null
Write-Ok $InstallDir

# --------------------------------------------------------------------- ASR
if (-not $SkipAsr) {
    Write-Step 'Locating Python 3.9+'
    $py = Find-Python
    if (-not $py) {
        Write-Warn2 'Python 3.9+ not found.'
        Write-Info 'Install it from https://www.python.org/downloads/ (tick "Add to PATH"),'
        Write-Info 'then run this script again.'
        throw 'Python is required for the speech recognition service.'
    }
    Write-Ok "$($py.Version)  ($($py.Exe))"

    $venvPython = Join-Path $venvDir 'Scripts\python.exe'
    if (-not (Test-Path $venvPython)) {
        Write-Step 'Creating virtual environment'
        & $py.Exe @($py.Args) -m venv $venvDir
        if (-not (Test-Path $venvPython)) { throw "venv creation failed at $venvDir" }
        Write-Ok $venvDir
    } else {
        Write-Step 'Virtual environment already exists'
        Write-Ok $venvDir
    }

    Write-Step 'Installing Python dependencies (this can take a few minutes)'
    & $venvPython -m pip install --quiet --upgrade pip 2>&1 | Out-Null
    $pipOut = & $venvPython -m pip install --quiet faster-whisper fastapi uvicorn python-multipart 2>&1
    if ($LASTEXITCODE -ne 0) {
        $pipOut | Select-Object -Last 15 | ForEach-Object { Write-Info "$_" }
        throw 'pip install failed'
    }
    Write-Ok 'faster-whisper, fastapi, uvicorn, python-multipart'

    Write-Step 'Placing the ASR server'
    $serverPath = Join-Path $InstallDir 'asr_server.py'
    $localCopy = Join-Path $PSScriptRoot 'tools\asr_server.py'
    if (Test-Path $localCopy) {
        Copy-Item $localCopy $serverPath -Force
        Write-Ok "copied from tools\asr_server.py"
    } else {
        try {
            Invoke-WebRequest $script:RawUrl -OutFile $serverPath -UseBasicParsing -TimeoutSec 60
            Write-Ok 'downloaded asr_server.py'
        } catch {
            throw "cannot obtain asr_server.py: $($_.Exception.Message)"
        }
    }

    Write-Step "Downloading the '$AsrModel' model (first run only, ~150-500 MB)"
    $env:HF_HOME = $hfHome
    $env:HF_HUB_DISABLE_SYMLINKS_WARNING = '1'
    $env:WHISPER_MODEL = $AsrModel
    $warm = @"
import os
from faster_whisper import WhisperModel
m = WhisperModel(os.environ['WHISPER_MODEL'], device='cpu', compute_type='int8')
print('model ready')
"@
    & $venvPython -c $warm 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'model download failed' }
    Write-Ok "whisper model '$AsrModel' cached in $hfHome"
}

# ------------------------------------------------------------------ start scripts
Write-Step 'Writing start scripts'
$startAsr = @'
# Start the local speech recognition service (port 8000)
param([string]$Model = "MODEL_PLACEHOLDER", [int]$Threads = THREADS_PLACEHOLDER, [int]$Port = 8000)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$python = Join-Path $here "venv\Scripts\python.exe"
if (-not (Test-Path $python)) { throw "venv missing, run install.ps1 again" }
$env:HF_HOME = Join-Path $here "hf-cache"
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"
$env:WHISPER_MODEL = $Model
$env:WHISPER_THREADS = "$Threads"
$env:WHISPER_PORT = "$Port"
Write-Host "starting ASR: model=$Model threads=$Threads port=$Port" -ForegroundColor Cyan
& $python (Join-Path $here "asr_server.py")
'@
$startAsr = $startAsr.Replace('MODEL_PLACEHOLDER', $AsrModel).Replace('THREADS_PLACEHOLDER', $Threads)
$startAsrPath = Join-Path $InstallDir 'start-asr.ps1'
Set-Content -Path $startAsrPath -Value $startAsr -Encoding ASCII
Write-Ok $startAsrPath

$startAll = @'
# Start both local services and wait until they answer.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

function Test-Url([string]$url) {
    try { $null = Invoke-RestMethod $url -TimeoutSec 4; return $true } catch { return $false }
}

if (-not (Test-Url 'http://127.0.0.1:8000/health')) {
    Write-Host 'starting speech recognition...' -ForegroundColor Cyan
    Start-Process powershell -ArgumentList '-NoExit', '-File', ('"' + (Join-Path $here 'start-asr.ps1') + '"') -WindowStyle Minimized
} else {
    Write-Host 'speech recognition already running' -ForegroundColor Green
}

if (-not (Test-Url 'http://127.0.0.1:11434/api/tags')) {
    Write-Host 'starting Ollama...' -ForegroundColor Cyan
    $ollama = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
    if (Test-Path $ollama) { Start-Process $ollama -ArgumentList 'serve' -WindowStyle Hidden }
    else { Write-Host 'Ollama not found; start it from the Start Menu.' -ForegroundColor Yellow }
} else {
    Write-Host 'Ollama already running' -ForegroundColor Green
}

for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 2
    $asr = Test-Url 'http://127.0.0.1:8000/health'
    $llm = Test-Url 'http://127.0.0.1:11434/api/tags'
    if ($asr -and $llm) { Write-Host 'both services ready' -ForegroundColor Green; break }
    Write-Host ("  asr={0} llm={1}" -f $asr, $llm) -ForegroundColor DarkGray
}
Write-Host ''
Write-Host '  speech : http://127.0.0.1:8000/v1/audio/transcriptions'
Write-Host '  translate : http://127.0.0.1:11434/v1/chat/completions'
'@
$startAllPath = Join-Path $InstallDir 'start-all.ps1'
Set-Content -Path $startAllPath -Value $startAll -Encoding ASCII
Write-Ok $startAllPath

# ------------------------------------------------------------------- Ollama
if (-not $SkipOllama) {
    Write-Step 'Configuring Ollama'
    $ollama = Find-Ollama
    if (-not $ollama) {
        Write-Warn2 'Ollama not found - download it from https://ollama.com/download'
        Write-Info 'After installing it, run: ollama pull ' + $OllamaModel
    } else {
        Write-Ok "found $ollama"

        $current = [Environment]::GetEnvironmentVariable('OLLAMA_ORIGINS', 'User')
        if ($current -eq '*') {
            Write-Ok 'OLLAMA_ORIGINS already allows extension origins'
        } else {
            [Environment]::SetEnvironmentVariable('OLLAMA_ORIGINS', '*', 'User')
            $env:OLLAMA_ORIGINS = '*'
            Write-Ok 'set OLLAMA_ORIGINS=* (user scope)'
            Write-Info 'A running Ollama must be restarted to pick this up.'
        }

        $online = Test-Endpoint 'http://127.0.0.1:11434/api/tags'
        if (-not $online) {
            Write-Warn2 'Ollama server is not answering on 11434'
            Write-Info 'Start Ollama, then run: ollama pull ' + $OllamaModel
        } else {
            Write-Step "Pulling the model '$OllamaModel'"
            & $ollama pull $OllamaModel
            if ($LASTEXITCODE -eq 0) { Write-Ok "$OllamaModel ready" }
            else { Write-Warn2 "ollama pull failed (exit $LASTEXITCODE)" }
        }
    }
}

# ------------------------------------------------------------------ start now
if (-not $NoStart -and -not $SkipAsr) {
    Write-Step 'Starting the speech recognition service'
    if (Test-Endpoint 'http://127.0.0.1:8000/health') {
        Write-Ok 'already running on 8000'
    } else {
        Start-Process powershell -ArgumentList '-NoExit', '-File', ('"' + $startAsrPath + '"') -WindowStyle Minimized
        $ready = $false
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Seconds 2
            if (Test-Endpoint 'http://127.0.0.1:8000/health') { $ready = $true; break }
        }
        if ($ready) { Write-Ok 'listening on http://127.0.0.1:8000' }
        else { Write-Warn2 'did not answer within 60s - check the window it opened' }
    }
}

# ------------------------------------------------------------------- summary
Write-Step 'Summary'
Write-Info "install dir : $InstallDir"
Write-Info "start all   : & '$startAllPath'"
Write-Info "start asr   : & '$startAsrPath'"
Write-Host ''
Write-Host ("  {0} checks passed, {1} warnings" -f $script:Ok, $script:Warn) -ForegroundColor $(if ($script:Warn) { 'Yellow' } else { 'Green' })
Write-Host ''
Write-Host '  Next: load the extension in chrome://extensions (Developer mode ->' -ForegroundColor White
Write-Host '  Load unpacked -> pick the folder containing manifest.json).' -ForegroundColor White
Write-Host ''
exit 0
