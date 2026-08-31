<#
    sh-agent — one command to put the local model on the phone.

    Brings up, in order:
      1. the Ollama OpenAI-compatible server      (localhost:11434)
      2. the relay                                (localhost:8787, token gated)
      3. a public address for it, whichever is available:
           Tailscale Funnel  https://<machine>.<tailnet>.ts.net   (fixed)
           Cloudflare quick  https://<random>.trycloudflare.com   (changes)

    Then prints a pairing link for https://jacky92q.github.io/sh-agent/.
    Ctrl+C tears everything back down.

    Ollama, not LM Studio: llama.cpp's own server (what LM Studio wraps) has
    no code path for audio input at all — see the commit that made this
    switch, or run `git log -1` on the lmstudio-backend branch, which is the
    old LM-Studio-based version of this whole script kept as a snapshot.
#>

[CmdletBinding()]
param(
    [int]$RelayPort = 8787,
    [int]$ModelPort = 11434,
    [string]$ModelName = 'gemma4:e2b',
    [string]$KeepAlive = '30m',   # how long Ollama holds the model in RAM after the last message
    [switch]$NoWarmup,            # skip preloading the model at startup
    [string]$PagesUrl = 'https://jacky92q.github.io/sh-agent/',
    [switch]$NoTunnel,      # LAN only: skip cloudflared, print the local address
    [ValidateSet('auto', 'tailscale', 'cloudflare', 'none')]
    [string]$Tunnel = 'auto',   # auto: fixed Tailscale address if available, else a random one
    [switch]$NewKey,        # rotate every key (everyone re-pairs)
    [switch]$Restart,       # stop a session that is already running and start fresh
    [string]$AddGuest,      # issue the second seat to someone, print their link
    [string]$Revoke,        # take a seat back, effective immediately
    [switch]$Seats          # list who currently holds a seat
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $root '.sh-agent'
$keyFile = Join-Path $stateDir 'access.key'   # legacy single key, migrated below
$keysFile = Join-Path $stateDir 'keys.json'
$MaxSeats = 2
# Per-run name: a tunnel from an earlier run keeps its own log file open, and
# Windows will not let us delete or reuse it while that process lives.
$tunnelLog = Join-Path $stateDir "tunnel-$PID.log"
$sessionFile = Join-Path $stateDir 'session.json'
$procs = @()

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Step($text) { Write-Host ''; Write-Host "  $text" -ForegroundColor White }

if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Path $stateDir | Out-Null }

# ------------------------------------------------------------------- seats
# Two seats, hard stop. One machine runs one model; a third person would only
# be queueing behind the other two.

function New-AccessKey {
    $bytes = New-Object byte[] 16
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Read-Seats {
    if (-not (Test-Path $keysFile)) { return @() }
    # Get-Content in 5.1 decodes BOM-less UTF-8 as ANSI, which mangles Korean
    # names and leaves ConvertFrom-Json staring at broken JSON.
    try { return @([IO.File]::ReadAllText($keysFile) | ConvertFrom-Json) } catch { return @() }
}

function Write-Seats($seats) {
    $list = @($seats)
    $json = $list | ConvertTo-Json -Depth 4
    # PowerShell 5.1 unwraps a one-element array into a bare object.
    if ($list.Count -le 1) { $json = "[$json]" }
    # Set-Content -Encoding utf8 prepends a BOM in 5.1, and JSON.parse chokes on it.
    [IO.File]::WriteAllText($keysFile, $json, (New-Object Text.UTF8Encoding $false))
}

function Initialize-Seats {
    $seats = Read-Seats
    if ($seats.Count) { return $seats }
    $mine = if (Test-Path $keyFile) { (Get-Content $keyFile -Raw).Trim() } else { New-AccessKey }
    $seats = @([pscustomobject]@{ name = '나'; key = $mine; issued = (Get-Date).ToString('s') })
    Write-Seats $seats
    return $seats
}

function Show-Seats($seats) {
    $list = @($seats)
    Write-Host ''
    Write-Host "  좌석 $($list.Count) / $MaxSeats" -ForegroundColor White
    foreach ($seat in $list) {
        Write-Host ("    {0,-10} {1}" -f $seat.name, $seat.key) -ForegroundColor DarkGray
    }
    Write-Host ''
}

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

# --------------------------------------------------------- seat management
if ($NewKey) {
    Remove-Item $keysFile, $keyFile -Force -ErrorAction SilentlyContinue
    Say '  모든 키를 폐기했습니다. 두 사람 모두 다시 페어링해야 합니다.' 'Yellow'
}
$seatList = Initialize-Seats

function Get-LiveSession {
    if (-not (Test-Path $sessionFile)) { return $null }
    try { return [IO.File]::ReadAllText($sessionFile) | ConvertFrom-Json } catch { return $null }
}

if ($Seats) {
    Show-Seats $seatList
    $live = Get-LiveSession
    if ($live) { Say "  현재 주소  $($live.url)" } else { Say '  서버가 꺼져 있습니다.' }
    exit 0
}

if ($Revoke) {
    $target = $seatList | Where-Object { $_.name -eq $Revoke }
    if (-not $target) {
        Say "  '$Revoke' 좌석이 없습니다." 'Red'
        Show-Seats $seatList
        exit 1
    }
    if ($seatList[0].name -eq $Revoke) {
        Say '  본인 좌석은 회수할 수 없습니다. 전체 교체는 -NewKey 를 쓰세요.' 'Red'
        exit 1
    }
    Write-Seats (@($seatList | Where-Object { $_.name -ne $Revoke }))
    Say "  '$Revoke' 차단 완료. 서버 재시작 없이 즉시 적용됩니다." 'Green'
    Show-Seats (Read-Seats)
    exit 0
}

if ($AddGuest) {
    if ($seatList | Where-Object { $_.name -eq $AddGuest }) {
        Say "  '$AddGuest' 은(는) 이미 좌석이 있습니다. 새 키가 필요하면 먼저 -Revoke 하세요." 'Yellow'
        Show-Seats $seatList
        exit 1
    }
    if (@($seatList).Count -ge $MaxSeats) {
        Say "  좌석이 꽉 찼습니다 (최대 ${MaxSeats}명). 한 명을 회수한 뒤 다시 시도하세요:" 'Red'
        Show-Seats $seatList
        Say "    start.ps1 -Revoke <이름>" 'DarkGray'
        exit 1
    }

    $guest = [pscustomobject]@{ name = $AddGuest; key = New-AccessKey; issued = (Get-Date).ToString('s') }
    Write-Seats (@($seatList) + $guest)
    Say "  '$AddGuest' 좌석을 발급했습니다. 서버 재시작 없이 바로 쓸 수 있습니다." 'Green'

    $live = Get-LiveSession
    if ($live -and $live.url) {
        Write-PairingLink $live.url $guest.key | Out-Null
        Say '  위 링크를 그 사람에게 보내세요. (클립보드에 복사됨)'
    } else {
        Say '  서버가 꺼져 있어 링크를 만들 수 없습니다. 서버를 켠 뒤 다시 실행하세요:' 'Yellow'
        Say "    start.ps1 -AddGuest $AddGuest" 'DarkGray'
    }
    exit 0
}

# ------------------------------------------------------- already running?
# Starting twice used to fail deep in the script with EADDRINUSE, after the
# health probe had been fooled by the *previous* relay answering on the port.
if (Test-RelayUp $RelayPort) {
    $prev = $null
    if (Test-Path $sessionFile) {
        try { $prev = [IO.File]::ReadAllText($sessionFile) | ConvertFrom-Json } catch { $prev = $null }
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
$token = $seatList[0].key

# ----------------------------------------------------------------- Ollama
Step 'Ollama'

# On a 4GB card, LM Studio's llama-server holding VRAM is exactly what once
# made Ollama's GPU discovery hang for minutes on this machine — not a bad
# install, just two backends fighting over the same GPU. Clear the way.
$gpuHogs = @(Get-Process 'llama-server', 'LM Studio' -ErrorAction SilentlyContinue)
if ($gpuHogs.Count) {
    Say "    LM Studio가 GPU를 쓰고 있어 종료합니다 (Ollama와 동시에 못 씀)..." 'Yellow'
    $gpuHogs | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
}

$ollama = (Get-Command ollama -ErrorAction SilentlyContinue).Source
if (-not $ollama) {
    $ollama = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
    if (-not (Test-Path $ollama)) { $ollama = $null }
}
if (-not $ollama) {
    Say '    ollama를 찾지 못했습니다. https://ollama.com/download 에서 설치하세요.' 'Red'
    exit 1
}

function Test-OllamaUp {
    try { Invoke-RestMethod -Uri "http://127.0.0.1:$ModelPort/api/version" -TimeoutSec 3 | Out-Null; return $true }
    catch { return $false }
}

if (-not (Test-OllamaUp)) {
    # Not the tray app: that one refuses to start a second time when an
    # earlier crashed instance is still holding its own singleton lock, and
    # that stuck lock is exactly what "Ollama won't start" usually is. The
    # CLI server is a plain child process with none of that.
    Say '    서버 시작 중...'
    Start-Process -FilePath $ollama -ArgumentList 'serve' -WindowStyle Hidden
    # First request after "Listening" can take up to ~90s (GPU/model-list
    # warm-up) even with the GPU free, so this waits rather than failing fast.
    $deadline = (Get-Date).AddSeconds(90)
    while (-not (Test-OllamaUp) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
}

if (-not (Test-OllamaUp)) {
    Say '    Ollama 서버가 응답하지 않습니다. 다른 GPU 사용 프로그램을 모두 끄고 다시 시도하세요.' 'Red'
    exit 1
}

$haveModel = $false
try {
    $tags = & $ollama list 2>&1
    $haveModel = ($tags -join "`n") -match [regex]::Escape($ModelName)
} catch { $haveModel = $false }

if (-not $haveModel) {
    Say "    $ModelName 를 받는 중 (최초 1회, 수 GB)..." 'Yellow'
    & $ollama pull $ModelName
    if ($LASTEXITCODE -ne 0) {
        Say "    $ModelName 다운로드에 실패했습니다." 'Red'
        exit 1
    }
}

$models = @()
try {
    $res = Invoke-RestMethod -Uri "http://127.0.0.1:$ModelPort/v1/models" -TimeoutSec 5
    $models = $res.data | ForEach-Object { $_.id }
    Say "    online · $($models -join ', ')" 'Green'
} catch {
    Say '    Ollama 서버에 연결하지 못했습니다.' 'Red'
    exit 1
}

# ------------------------------------------------------------------ warmup
# Ollama drops a model from memory five minutes after the last request. On a
# 4GB card a 6.8GB model sits mostly in system RAM, so reloading it means
# reading gigabytes back off disk: measured here at 97s to the first token
# cold against 0.4s warm. Five minutes is shorter than an ordinary pause
# between chat messages, which is why nearly every message after a short
# break used to stall. Loading it now means the first message from the phone
# is already fast, and the relay keeps pushing the timer out from there.
if (-not $NoWarmup) {
    Step 'Warmup'
    Say "    $ModelName 을(를) 메모리에 올리는 중... (최초 1회 1~2분)"
    $warmStart = Get-Date
    try {
        $payload = @{ model = $ModelName; keep_alive = $KeepAlive } | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri "http://127.0.0.1:$ModelPort/api/generate" -Method Post `
            -Body $payload -ContentType 'application/json' -TimeoutSec 300 | Out-Null
        $secs = [int]((Get-Date) - $warmStart).TotalSeconds
        Say "    준비됨 · ${secs}초 걸렸습니다 · 마지막 요청 뒤 $KeepAlive 동안 유지됩니다" 'Green'
    } catch {
        Say '    예열에 실패했습니다. 첫 메시지가 느릴 수 있습니다.' 'Yellow'
    }
}

# ------------------------------------------------------------------- relay
Step 'Relay'
$env:RELAY_KEYS_FILE = $keysFile
$env:RELAY_PORT = "$RelayPort"
$env:RELAY_KEEP_ALIVE = $KeepAlive
$env:MODEL_SERVER_URL = "http://127.0.0.1:$ModelPort"
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
#
# Two ways out to the internet, and they differ in one thing that matters
# daily: whether the address survives a restart.
#
#   Tailscale Funnel  https://<machine>.<tailnet>.ts.net   same every time
#   Cloudflare quick  https://<random>.trycloudflare.com   new every time
#
# The random one needs no account, which is why it shipped first, but it also
# means re-pairing the phone after every restart. Funnel is preferred when the
# tailnet has it turned on, and the quick tunnel stays as the fallback so this
# script still works on a machine with no Tailscale at all.
$publicUrl = "http://localhost:$RelayPort"
$cfTunnel = $null
$funnelOn = $false

if ($NoTunnel) { $Tunnel = 'none' }

# Windows PowerShell decodes a native exe's stdout with the console codepage
# (cp949 here), so any non-ASCII in it comes back corrupted — and this tailnet
# has a device named in Hangul, which was enough to break `status --json` into
# invalid JSON. Capturing to a file and reading it back as UTF-8 sidesteps that
# without touching [Console]::OutputEncoding, which the rest of this script's
# Korean output depends on.
function Invoke-TailscaleOut($exe, $tsArgs) {
    $out = Join-Path $stateDir "ts-$PID.out"
    try {
        Start-Process -FilePath $exe -ArgumentList $tsArgs -NoNewWindow -Wait `
            -RedirectStandardOutput $out -RedirectStandardError "$out.err" | Out-Null
        if (Test-Path $out) {
            return [IO.File]::ReadAllText($out, (New-Object Text.UTF8Encoding $false))
        }
    } catch { }
    finally { Remove-Item "$out*" -Force -ErrorAction SilentlyContinue }
    return ''
}

function Get-TailscaleExe {
    $ts = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
    if ($ts) { return $ts }
    foreach ($c in @((Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'),
                     (Join-Path ${env:ProgramFiles(x86)} 'Tailscale\tailscale.exe'))) {
        if (Test-Path $c) { return $c }
    }
    return $null
}

if ($Tunnel -eq 'auto' -or $Tunnel -eq 'tailscale') {
    $ts = Get-TailscaleExe
    if (-not $ts) {
        if ($Tunnel -eq 'tailscale') {
            Step 'Tunnel'
            Say '    tailscale이 없습니다:  winget install --id tailscale.tailscale' 'Red'
            exit 1
        }
    } else {
        Step 'Tunnel (Tailscale Funnel)'
        # PowerShell 5.1 turns anything a native exe writes to stderr into an
        # ErrorRecord, and $ErrorActionPreference is 'Stop' at the top of this
        # script — so a perfectly successful `tailscale status` was being
        # caught as a failure and read as "not logged in". Native calls in
        # this block run with that turned off.
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'

        $dns = $null
        try {
            $st = (Invoke-TailscaleOut $ts @('status', '--json')) | ConvertFrom-Json
            $dns = $st.Self.DNSName
        } catch { $dns = $null }

        if (-not $dns) {
            Say '    tailscale에 로그인되어 있지 않습니다:  tailscale up' 'Yellow'
        } else {
            $dns = $dns.TrimEnd('.')
            # Whether Funnel is allowed is a tailnet policy setting, and there
            # is no reliable flag to read for it — so just try. When it is off,
            # the command prints an enable link and then waits, which is why
            # this runs detached with a deadline instead of inline.
            $funnelLog = Join-Path $stateDir "funnel-$PID.log"
            $fp = Start-Process -FilePath $ts -ArgumentList @('funnel', '--bg', "$RelayPort") `
                -NoNewWindow -PassThru -RedirectStandardOutput $funnelLog -RedirectStandardError "$funnelLog.err"
            $deadline = (Get-Date).AddSeconds(20)
            while (-not $fp.HasExited -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
            if (-not $fp.HasExited) { Stop-Process -Id $fp.Id -Force -ErrorAction SilentlyContinue }

            $cfg = Invoke-TailscaleOut $ts @('funnel', 'status')
            if ($cfg -match [regex]::Escape("$RelayPort")) {
                $funnelOn = $true
                $publicUrl = "https://$dns"
                Say "    $publicUrl" 'Green'
                Say '    이 주소는 다시 켜도 그대로입니다 — 폰에서 재설정할 필요가 없습니다.'
            } else {
                $out = ''
                foreach ($f in @($funnelLog, "$funnelLog.err")) {
                    if (Test-Path $f) { $out += [IO.File]::ReadAllText($f, (New-Object Text.UTF8Encoding $false)) }
                }
                $link = ([regex]'https://login\.tailscale\.com/\S+').Match($out).Value
                if ($link) {
                    Say '    Funnel이 이 tailnet에서 꺼져 있습니다. 아래 주소에서 한 번 켜주세요:' 'Yellow'
                    Say "      $link" 'White'
                    Say '    켠 뒤 이 스크립트를 다시 실행하면 고정 주소를 씁니다.' 'Yellow'
                } else {
                    Say '    Funnel을 켜지 못했습니다.' 'Yellow'
                }
                if ($Tunnel -eq 'tailscale') { exit 1 }
                Say '    이번에는 임시 주소로 진행합니다.'
            }
            Remove-Item "$funnelLog*" -Force -ErrorAction SilentlyContinue
        }
        $ErrorActionPreference = $prevEAP
    }
}

if (-not $funnelOn -and $Tunnel -ne 'none') {
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
    $cfTunnel = Start-Process -FilePath $cfPath `
        -ArgumentList @('tunnel', '--no-autoupdate', '--url', "http://localhost:$RelayPort") `
        -NoNewWindow -PassThru -RedirectStandardError $tunnelLog -RedirectStandardOutput "$tunnelLog.out"
    $procs += $cfTunnel

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
    funnel    = $funnelOn
    startedAt = (Get-Date).ToString('s')
}
if ($cfTunnel) { $session.tunnelPid = $cfTunnel.Id }
[IO.File]::WriteAllText($sessionFile, ($session | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))

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
    # Funnel config lives in tailscaled, not in a process we can kill — left
    # up it would keep answering on a port with nothing behind it.
    if ($funnelOn) {
        $ts = Get-TailscaleExe
        if ($ts) {
            $ErrorActionPreference = 'Continue'
            & $ts funnel reset | Out-Null
        }
    }
}
