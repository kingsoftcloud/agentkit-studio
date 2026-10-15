param(
  [Parameter(Mandatory=$true)][string]$DshRoot,
  [Parameter(Mandatory=$true)][string]$UpdateOrigin,
  [ValidateSet('stable','preview')][string]$Channel = 'preview',
  [string]$AppId = '',
  [string]$UpdateEnvironment = ''
)
$ErrorActionPreference = 'Stop'
if (-not $AppId) {
  $AppId = [string](& node (Join-Path $PSScriptRoot 'product-config.mjs') app-id)
  if ($LASTEXITCODE) { throw 'Product App ID resolution failed' }
  $AppId = $AppId.Trim()
}
if (-not $UpdateEnvironment) {
  $UpdateEnvironment = [string](& node (Join-Path $PSScriptRoot 'product-config.mjs') update-env)
  if ($LASTEXITCODE) { throw 'Product update environment resolution failed' }
  $UpdateEnvironment = $UpdateEnvironment.Trim()
}
if ($AppId -notmatch '^[A-Za-z][\w-]*(\.[A-Za-z][\w-]*)+$' -or $UpdateEnvironment -notin @('production','test')) { throw 'Invalid public product identity' }
$thumb = ($env:CERTUM_THUMBPRINT -replace '[\s:]','').ToUpperInvariant()
if ($thumb -notmatch '^[0-9A-F]{40}$') { throw 'CERTUM_THUMBPRINT must identify one signing certificate' }
$cert = Get-Item "Cert:\CurrentUser\My\$thumb"
if (-not $cert.HasPrivateKey -or $cert.NotBefore -gt (Get-Date) -or $cert.NotAfter -le (Get-Date)) { throw 'Certum signing certificate is unavailable or expired' }
$usage = @($cert.Extensions | Where-Object {$_.Oid.Value -eq '2.5.29.37'} | ForEach-Object {$_.EnhancedKeyUsages} | ForEach-Object {$_.Value})
if ('1.3.6.1.5.5.7.3.3' -notin $usage) { throw 'Certificate must have Code Signing usage' }
$uri = [Uri]$UpdateOrigin
if ($uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment) { throw 'Update origin must be an HTTPS origin' }
$tool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $tool) { throw 'Microsoft Windows SDK SignTool is missing' }
$publicCertificate = Join-Path $env:RUNNER_TEMP 'studio-code-signing.cer'
Export-Certificate -Cert $cert -FilePath $publicCertificate -Type CERT | Out-Null
$settings = @{
  DSH_DESKTOP_APP_ID = $AppId
  DSH_DESKTOP_AUTO_UPDATE_ENV = $UpdateEnvironment
  DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN = $uri.GetLeftPart([UriPartial]::Authority)
  DSH_DESKTOP_UPDATE_ORIGIN = $uri.GetLeftPart([UriPartial]::Authority)
  DSH_DESKTOP_UPDATE_CHANNEL = $Channel
  DSH_DESKTOP_WINDOWS_SIGNING_MODE = 'certificate-store'
  DSH_DESKTOP_WINDOWS_CER_FILE = $publicCertificate
  DSH_DESKTOP_WINDOWS_SIGNTOOL = $tool.FullName
  DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_DIR = (Join-Path $env:RUNNER_TEMP 'studio-signature-cache')
  DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_CONCURRENCY = '4'
}
$lines = foreach ($entry in $settings.GetEnumerator()) {
  if ($entry.Value -match "['\r\n]") { throw 'Unsupported release settings value' }
  "$($entry.Key)='$($entry.Value)'"
}
[IO.File]::WriteAllText((Join-Path $DshRoot 'apps/desktop/.env.windows'), ($lines -join "`n") + "`n", [Text.UTF8Encoding]::new($false))
Write-Host 'Prepared certificate-store signing with a verified public Code Signing certificate.'
