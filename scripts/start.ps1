<#
    sh-agent — one command to put the local model on the phone.

    Brings up, in order:
      1. the LM Studio OpenAI-compatible server   (localhost:1234)
      2. the relay                                (localhost:8787, token gated)
      3. a Cloudflare quick tunnel                (https://<random>.trycloudflare.com)

    Then prints a pairing link for https://jacky92q.github.io/sh-agent/.
    Ctrl+C tears everything back down.
#>

[CmdletBinding()]
param(
    [int]$RelayPort = 8787,
    [int]$LmsPort = 1234,
    [string]$PagesUrl = 'https://jacky92q.github.io/sh-agent/',
    [switch]$NoTunnel,      # LAN only: skip cloudflared, print the local address
    [switch]$NewKey,        # rotate the access key
    [switch]$Restart        # stop a session that is already running and start fresh
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $root '.sh-agent'
$keyFile = Join-Path $stateDir 'access.key'
# Per-run name: a tunnel from an earlier run keeps its own log file open, and
# Windows will not let us delete or reuse it while that process lives.
$tunnelLog = Join-Path $stateDir "tunnel-$PID.log"
$sessionFile = Join-Path $stateDir 'session.json'
$procs = @()

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Step($text) { Write-Host ''; Write-Host "  $text" -ForegroundColor White }

if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Path $stateDir | Out-Null }

function Test-RelayUp($port) {
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3 | Out-Null
        return $true
    } catch { return $false }
}

function Write-PairingLink($url, $key) {
    $payload = "{""e"":""$url"",""t"":""$key""}"
    $blob = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    $link = "$($PagesUrl.TrimEnd('/'))/#c=$blob"
    Write-Host ''
    Write-Host '  ─────────────────────────────────────────────' -ForegroundColor DarkGray
    Write-Host '   폰에서 이 링크를 한 번만 열면 연결됩니다' -ForegroundColor White
    Write-Host ''
    Write-Host "   $link" -ForegroundColor Cyan
    Write-Host ''
    Write-Host "   서버 주소   $url" -ForegroundColor DarkGray
    Write-Host "   액세스 키   $key" -ForegroundColor DarkGray
    Write-Host '  ─────────────────────────────────────────────' -ForegroundColor DarkGray
    Write-Host ''
    try { Set-Clipboard -Value $link } catch { }
    return $link
}

# ------------------------------------------------------- already running?
# Starting twice used to fail deep in the script with EADDRINUSE, after the
# health probe had been fooled by the *previous* relay answering on the port.
if (Test-RelayUp $RelayPort) {
    $prev = $null
    if (Test-Path $sessionFile) {
        try { $prev = Get-Content $sessionFile -Raw | ConvertFrom-Json } catch { $prev = $null }
    }

    if ($Restart) {
        Say "  실행 중인 세션을 종료합니다..." 'Yellow'
        if ($prev) {
            foreach ($id in @($prev.relayPid, $prev.tunnelPid)) {
                if ($id) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
            }
        } else {
            # No session file (an older run, or one killed uncleanly). Stop
            # exactly whoever holds the port rather than guessing by name.
            $owner = Get-NetTCPConnection -LocalPort $RelayPort -State Listen -ErrorAction SilentlyContinue |
                Select-Object -ExpandProperty OwningProcess -Unique
            foreach ($id in $owner) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
            $strays = @(Get-Process cloudflared -ErrorAction SilentlyContinue)
            if ($strays.Count) {
                Say "  cloudflared $($strays.Count)개가 남아있습니다. 이전 실행의 터널이면 종료하세요:" 'Yellow'
                Say "    Stop-Process -Name cloudflared -Force" 'DarkGray'
            }
        }
        Remove-Item $sessionFile -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 900
        if (Test-RelayUp $RelayPort) {
            Say "  :$RelayPort 를 아직 누군가 쓰고 있습니다. 해당 프로세스를 직접 종료해 주세요." 'Red'
            exit 1
        }
    } elseif ($prev -and $prev.url) {
        Say '  이미 실행 중입니다. 기존 주소를 그대로 씁니다.' 'Green'
        Write-PairingLink $prev.url $prev.token | Out-Null
        Say '  링크를 클립보드에 복사했습니다.'
        Say '  다시 띄우려면  -Restart  옵션을 붙여 실행하세요.' 'DarkGray'
        exit 0
    } else {
        Say "  :$RelayPort 가 이미 사용 중입니다 (이 스크립트가 띄운 게 아닙니다)." 'Red'
        Say '  해당 프로세스를 종료하거나 -RelayPort 로 다른 포트를 쓰세요.' 'Red'
        exit 1
    }
}

# --------------------------------------------------------------- access key
if ($NewKey -and (Test-Path $keyFile)) { Remove-Item $keyFile -Force }
if (-not (Test-Path $keyFile)) {
    $bytes = New-Object byte[] 16
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $key = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    Set-Content -Path $keyFile -Value $key -Encoding ascii -NoNewline
}
$token = (Get-Content $keyFile -Raw).Trim()

# ------------------------------------------------------------- LM Studio up
Step 'LM Studio'
$lms = Join-Path $env:USERPROFILE '.lmstudio\bin\lms.exe'
if (-not (Test-Path $lms)) {
    $found = Get-Command lms -ErrorAction SilentlyContinue
    if ($found) { $lms = $found.Source } else { $lms = $null }
}

$lmsUp = $false
try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$LmsPort/v1/models" -TimeoutSec 3 | Out-Null
    $lmsUp = $true
} catch { $lmsUp = $false }

if (-not $lmsUp) {
    if (-not $lms) {
        Say '    lms CLI를 찾지 못했습니다. LM Studio에서 Developer > Start Server를 켜주세요.' 'Yellow'
    } else {
        Say "    서버 시작 중 (port $LmsPort)..."
        & $lms server start --port $LmsPort | Out-Null
        Start-Sleep -Milliseconds 1500
    }
}

$models = @()
try {
    $res = Invoke-RestMethod -Uri "http://127.0.0.1:$LmsPort/v1/models" -TimeoutSec 5
    $models = $res.data | ForEach-Object { $_.id }
    Say "    online · $($models -join ', ')" 'Green'
} catch {
    Say '    LM Studio 서버에 연결하지 못했습니다. 앱을 켜고 다시 실행하세요.' 'Red'
    exit 1
}

# ------------------------------------------------------------------- relay
Step 'Relay'
$env:RELAY_TOKEN = $token
$env:RELAY_PORT = "$RelayPort"
$env:LMS_URL = "http://127.0.0.1:$LmsPort"
# The tunnel reaches the relay over loopback; binding wider would only invite a
# firewall prompt. LAN mode is the one case that needs a routable interface.
if ($NoTunnel) { $env:RELAY_HOST = '0.0.0.0' } else { $env:RELAY_HOST = '127.0.0.1' }

$relay = Start-Process -FilePath 'node' -ArgumentList (Join-Path $root 'server\relay.mjs') `
    -WorkingDirectory $root -NoNewWindow -PassThru
$procs += $relay
Start-Sleep -Milliseconds 900

try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$RelayPort/health" -TimeoutSec 5
    Say "    listening on :$RelayPort · upstream $($health.upstream)" 'Green'
} catch {
    Say '    릴레이가 뜨지 않았습니다.' 'Red'
    $procs | ForEach-Object { if (-not $_.HasExited) { Stop-Process -Id $_.Id -Force } }
    exit 1
}

# ------------------------------------------------------------------ tunnel
$publicUrl = "http://localhost:$RelayPort"
$tunnel = $null

if (-not $NoTunnel) {
    Step 'Tunnel'
    # winget updates the machine PATH, which an already-open shell will not see,
    # so fall back to the places the MSI actually puts it.
    $cfPath = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
    if (-not $cfPath) {
        $cfPath = @(
            (Join-Path $env:ProgramFiles 'cloudflared\cloudflared.exe'),
            (Join-Path ${env:ProgramFiles(x86)} 'cloudflared\cloudflared.exe')
        ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    }
    if (-not $cfPath) {
        Say '    cloudflared가 없습니다. 아래 명령으로 설치한 뒤 다시 실행하세요:' 'Yellow'
        Say '      winget install --id Cloudflare.cloudflared' 'White'
        Say '    (설치 없이 같은 Wi-Fi에서만 쓰려면 -NoTunnel 옵션을 사용하세요.)'
        $procs | ForEach-Object { if (-not $_.HasExited) { Stop-Process -Id $_.Id -Force } }
        exit 1
    }

    # Best effort: a log still held open by an earlier tunnel is not our problem.
    Get-ChildItem (Join-Path $stateDir 'tunnel-*.log*') -ErrorAction SilentlyContinue |
        ForEach-Object { try { Remove-Item $_.FullName -Force -ErrorAction Stop } catch { } }
    $tunnel = Start-Process -FilePath $cfPath `
        -ArgumentList @('tunnel', '--no-autoupdate', '--url', "http://localhost:$RelayPort") `
        -NoNewWindow -PassThru -RedirectStandardError $tunnelLog -RedirectStandardOutput "$tunnelLog.out"
    $procs += $tunnel

    Say '    주소를 받아오는 중...'
    $deadline = (Get-Date).AddSeconds(40)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path $tunnelLog) {
            $hit = Select-String -Path $tunnelLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if ($hit) { $publicUrl = $hit.Matches[0].Value; break }
        }
        Start-Sleep -Milliseconds 700
    }

    if ($publicUrl -like 'http://localhost*') {
        Say '    터널 주소를 받지 못했습니다. .sh-agent\tunnel.log 를 확인하세요.' 'Red'
    } else {
        Say "    $publicUrl" 'Green'
    }
}

if ($NoTunnel) {
    $lan = (Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
        Select-Object -First 1).IPAddress
    if ($lan) { $publicUrl = "http://${lan}:$RelayPort" }
}

# ----------------------------------------------------------------- pairing
Write-PairingLink $publicUrl $token | Out-Null
Say '  링크를 클립보드에 복사했습니다. Ctrl+C 로 종료.'

# Lets a second run recognise this session instead of colliding with it.
$session = [ordered]@{
    url       = $publicUrl
    token     = $token
    port      = $RelayPort
    relayPid  = $relay.Id
    tunnelPid = $null
    startedAt = (Get-Date).ToString('s')
}
if ($tunnel) { $session.tunnelPid = $tunnel.Id }
$session | ConvertTo-Json | Set-Content -Path $sessionFile -Encoding utf8

if ($NoTunnel) {
    Say '  주의: GitHub Pages(HTTPS)에서는 http:// 주소를 호출할 수 없습니다.' 'Yellow'
    Say '        -NoTunnel 모드는 PC에서 로컬로 web/ 을 열어 쓸 때만 동작합니다.' 'Yellow'
}

# ---------------------------------------------------------------- babysit
try {
    while ($true) {
        Start-Sleep -Seconds 2
        foreach ($p in $procs) {
            if ($p.HasExited) { throw "프로세스가 종료되었습니다 (pid $($p.Id))" }
        }
    }
} finally {
    Write-Host ''
    Say '  정리 중...'
    foreach ($p in $procs) {
        if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    }
    Remove-Item $sessionFile -Force -ErrorAction SilentlyContinue
    Remove-Item "$tunnelLog*" -Force -ErrorAction SilentlyContinue
}
