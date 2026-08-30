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
    [switch]$NewKey         # rotate the access key
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $root '.sh-agent'
$keyFile = Join-Path $stateDir 'access.key'
$tunnelLog = Join-Path $stateDir 'tunnel.log'
$procs = @()

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Step($text) { Write-Host ''; Write-Host "  $text" -ForegroundColor White }

if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Path $stateDir | Out-Null }

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

if (-not $NoTunnel) {
    Step 'Tunnel'
    $cf = Get-Command cloudflared -ErrorAction SilentlyContinue
    if (-not $cf) {
        Say '    cloudflared가 없습니다. 아래 명령으로 설치한 뒤 다시 실행하세요:' 'Yellow'
        Say '      winget install --id Cloudflare.cloudflared' 'White'
        Say '    (설치 없이 같은 Wi-Fi에서만 쓰려면 -NoTunnel 옵션을 사용하세요.)'
        $procs | ForEach-Object { if (-not $_.HasExited) { Stop-Process -Id $_.Id -Force } }
        exit 1
    }

    if (Test-Path $tunnelLog) { Remove-Item $tunnelLog -Force }
    $tunnel = Start-Process -FilePath $cf.Source `
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
$payload = "{""e"":""$publicUrl"",""t"":""$token""}"
$pair = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$link = "$($PagesUrl.TrimEnd('/'))/#c=$pair"

Write-Host ''
Write-Host '  ─────────────────────────────────────────────' -ForegroundColor DarkGray
Write-Host '   폰에서 이 링크를 한 번만 열면 연결됩니다' -ForegroundColor White
Write-Host ''
Write-Host "   $link" -ForegroundColor Cyan
Write-Host ''
Write-Host "   서버 주소   $publicUrl" -ForegroundColor DarkGray
Write-Host "   액세스 키   $token" -ForegroundColor DarkGray
Write-Host '  ─────────────────────────────────────────────' -ForegroundColor DarkGray
Write-Host ''
try { Set-Clipboard -Value $link; Say '  링크를 클립보드에 복사했습니다. Ctrl+C 로 종료.' } catch { Say '  Ctrl+C 로 종료.' }

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
}
