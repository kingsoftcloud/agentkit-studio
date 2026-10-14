param([Parameter(Mandatory=$true)][string]$Artifacts, [Parameter(Mandatory=$true)][string]$Version, [Parameter(Mandatory=$true)][string]$Evidence)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Evidence | Out-Null
$thumb = ($env:CERTUM_THUMBPRINT -replace '[\s:]','').ToUpperInvariant()
$installers = @(Get-ChildItem $Artifacts -File -Filter '*.exe')
if ($installers.Count -ne 1) { throw 'Exactly one NSIS installer is required' }
$installer = $installers[0]
$signature = Get-AuthenticodeSignature $installer.FullName
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $thumb -or -not $signature.TimeStamperCertificate) { throw 'Installer needs a valid timestamped signature from the configured certificate' }
if (-not (Get-ChildItem $Artifacts -Filter '*.exe.blockmap')) { throw 'Windows incremental-update blockmap is missing' }
$destination = Join-Path $env:RUNNER_TEMP 'studio-installed-proof'
if (Test-Path $destination) { throw 'Installation acceptance requires a fresh destination' }
$process = Start-Process -FilePath $installer.FullName -ArgumentList @('/S', "/D=$destination") -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "NSIS installation failed: $($process.ExitCode)" }
$app = Join-Path $destination 'AgentKit Studio.exe'
if (-not (Test-Path $app)) { throw 'Installed AgentKit Studio executable is missing' }
$appSignature = Get-AuthenticodeSignature $app
if ($appSignature.Status -ne 'Valid' -or $appSignature.SignerCertificate.Thumbprint -ne $thumb -or -not $appSignature.TimeStamperCertificate) { throw 'Installed app signature verification failed' }
$public = [ordered]@{version=$Version;installer=$installer.Name;installerSha256=(Get-FileHash $installer.FullName -Algorithm SHA256).Hash;installerSigned=$true;timestamped=$true;installed=$true;appSigned=$true;appSha256=(Get-FileHash $app -Algorithm SHA256).Hash;installedPath=$app;uiVerified=$false}
$public | ConvertTo-Json | Set-Content (Join-Path $Evidence 'windows-install.json')
"STUDIO_INSTALLED_APP=$app" | Out-File $env:GITHUB_ENV -Append
"STUDIO_SIGNED_INSTALLER=$($installer.FullName)" | Out-File $env:GITHUB_ENV -Append
Write-Host 'Actual NSIS installation and installed Authenticode signature verified; UI acceptance follows.'
