<#
  Deploy MABU to your Linux server from a Windows PC.

  Double-click "Deploy MABU.bat" (or run this script). It connects to the
  server with the SSH client built into Windows 10/11, downloads or updates
  MABU there, and runs deploy.sh, so MABU goes live at https://<your domain>.

  Answers are remembered in deploy-windows.settings.json next to this file
  (not committed), so later runs are just Enter, Enter, Enter.

  -DryRun prints the SSH command instead of running it.
#>
param([switch]$DryRun)

# Native commands (git, ssh) write to stderr in normal operation; with
# 'Stop', Windows PowerShell 5.1 would turn that into terminating errors.
$ErrorActionPreference = 'Continue'

$here = $PSScriptRoot
$settingsPath = Join-Path $here 'deploy-windows.settings.json'

function Ask([string]$prompt, [string]$default, [switch]$Required) {
    while ($true) {
        if ($default) { $answer = Read-Host "  $prompt [$default]" } else { $answer = Read-Host "  $prompt" }
        if ([string]::IsNullOrWhiteSpace($answer)) { $answer = $default }
        if ($answer -or -not $Required) { return "$answer".Trim() }
        Write-Host '  This one is required.' -ForegroundColor Yellow
    }
}

# Single-quote a value for bash: ' becomes '\''
function Quote-Bash([string]$value) {
    return "'" + ($value -replace "'", "'\''") + "'"
}

Write-Host ''
Write-Host '  MABU  -  deploy to your server' -ForegroundColor Yellow
Write-Host '  Press Enter to accept the value in [brackets].'
Write-Host ''

if (-not (Get-Command ssh.exe -ErrorAction SilentlyContinue)) {
    Write-Host '  The Windows SSH client is not installed.' -ForegroundColor Red
    Write-Host '  Turn it on in Settings > System > Optional features > Add a feature > "OpenSSH Client", then run this again.'
    exit 1
}

# Defaults come from the last run, then from this checkout's git settings.
$saved = @{}
if (Test-Path $settingsPath) {
    try {
        (Get-Content $settingsPath -Raw | ConvertFrom-Json).psobject.Properties |
            ForEach-Object { $saved[$_.Name] = [string]$_.Value }
    } catch { }
}

$gitRepo = ''
$gitBranch = ''
if (Get-Command git.exe -ErrorAction SilentlyContinue) {
    try {
        $gitRepo = "$(git -C $here remote get-url origin 2>$null)".Trim()
        $gitBranch = "$(git -C $here rev-parse --abbrev-ref HEAD 2>$null)".Trim()
    } catch { }
}
# The server may not have this PC's SSH key for GitHub, so clone over HTTPS.
if ($gitRepo -match '^git@github\.com:(.+)$') { $gitRepo = "https://github.com/$($Matches[1])" }
if (-not $gitRepo) { $gitRepo = 'https://github.com/chuddyofficial/mabu.git' }
if (-not $gitBranch -or $gitBranch -eq 'HEAD') { $gitBranch = 'main' }

function Saved([string]$name, [string]$fallback) {
    if ($saved.ContainsKey($name) -and $saved[$name]) { return $saved[$name] }
    return $fallback
}

$domain = Ask 'Domain for MABU' (Saved 'domain' 'mabu.chnexus.net') -Required
$server = Ask 'Server address (IP or hostname)' (Saved 'server' $domain) -Required
$user   = Ask 'SSH username on the server' (Saved 'user' 'root') -Required
$email  = Ask 'Email for HTTPS certificate notices (optional)' (Saved 'email' '')
$folder = Ask 'Folder for MABU on the server' (Saved 'folder' '~/mabu') -Required
$branch = Saved 'branch' $gitBranch
$repo   = Saved 'repo' $gitRepo

$settings = [ordered]@{
    domain = $domain; server = $server; user = $user; email = $email
    folder = $folder; branch = $branch; repo = $repo
}
try { $settings | ConvertTo-Json | Set-Content -Path $settingsPath -Encoding ASCII } catch { }

# Runs on the server. Kept in a single-quoted here-string so PowerShell
# doesn't expand any of the $ in it; values are substituted as bash literals.
$remote = @'
set -e
REPO=__REPO__
DIR=__DIR__
BRANCH=__BRANCH__
DOMAIN=__DOMAIN__
EMAIL=__EMAIL__
case "$DIR" in "~") DIR="$HOME" ;; "~/"*) DIR="$HOME/${DIR#\~/}" ;; esac
if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi
if ! command -v git >/dev/null 2>&1; then
  echo "[mabu] installing git"
  $SUDO apt-get update -qq && $SUDO apt-get install -y -qq git
fi
if [ ! -d "$DIR/.git" ]; then
  echo "[mabu] downloading MABU into $DIR"
  git clone "$REPO" "$DIR"
fi
cd "$DIR"
echo "[mabu] updating $DIR to branch $BRANCH"
git fetch origin
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"
chmod +x deploy.sh
if [ -n "$EMAIL" ]; then $SUDO ./deploy.sh "$DOMAIN" "$EMAIL"; else $SUDO ./deploy.sh "$DOMAIN"; fi
'@
$remote = $remote.Replace('__REPO__', (Quote-Bash $repo))
$remote = $remote.Replace('__DIR__', (Quote-Bash $folder))
$remote = $remote.Replace('__BRANCH__', (Quote-Bash $branch))
$remote = $remote.Replace('__DOMAIN__', (Quote-Bash $domain))
$remote = $remote.Replace('__EMAIL__', (Quote-Bash $email))
# Windows line endings would break bash on the server.
$remote = $remote -replace "`r", ''

# Ship the script base64-encoded (no quoting issues), write it to a temp file
# and run it from there so its prompts (sudo, admin account) read the keyboard.
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remote))
$remoteCmd = 'f=$(mktemp) && echo ' + $b64 + ' | base64 -d > $f && bash $f; rc=$?; rm -f $f; exit $rc'
$target = "$user@$server"

Write-Host ''
Write-Host "  Connecting to $target ..." -ForegroundColor Cyan
Write-Host '  You may be asked to trust the server (type yes), then for your SSH password,'
Write-Host '  your sudo password, and - the first time only - a MABU admin username and password.'
Write-Host ''

if ($DryRun) {
    Write-Host "ssh.exe -t $target `"$remoteCmd`""
    Write-Host ''
    Write-Host $remote
    exit 0
}

& ssh.exe -t $target $remoteCmd
$code = $LASTEXITCODE

Write-Host ''
if ($code -eq 0) {
    Write-Host "  Done. MABU is live at https://$domain" -ForegroundColor Green
    Start-Process "https://$domain"
} else {
    Write-Host "  The deploy stopped with an error (code $code). The lines just above say why." -ForegroundColor Red
    Write-Host '  Fix that, then double-click Deploy MABU.bat again - it picks up where it left off.'
}
exit $code
