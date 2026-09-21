[CmdletBinding()]
param(
  [switch]$Unsigned
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module Microsoft.PowerShell.Security -ErrorAction Stop

$projectRoot = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'package.json') | ConvertFrom-Json).version
$installerName = "FLAP-Fly-Agent-Setup-$version.exe"
$installerPath = Join-Path $projectRoot "out\windows\$installerName"
$appPath = Join-Path $projectRoot 'out\windows\win-unpacked\FLAPFlyAgent.exe'
$checksumPath = Join-Path $projectRoot 'out\windows\SHA256SUMS.txt'
$manifestPath = Join-Path $projectRoot 'out\windows\release-manifest.json'

if ($version -ne '4.0.0') {
  throw "This release script is frozen for 4.0.0; package.json is $version"
}
if (-not $Unsigned) {
  if (-not $env:FLAP_RELEASE_CSC_LINK) {
    throw 'FLAP_RELEASE_CSC_LINK is required. Provide the protected PFX path/link in this process only; never commit the certificate.'
  }
  if (-not $env:FLAP_RELEASE_CSC_KEY_PASSWORD) {
    throw 'FLAP_RELEASE_CSC_KEY_PASSWORD is required. Provide it in this process only; never write it to the repository or logs.'
  }
}

function Invoke-Checked([string]$FilePath, [string[]]$Arguments) {
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath failed with exit code $LASTEXITCODE"
  }
}

$oldCscLink = $env:CSC_LINK
$oldCscPassword = $env:CSC_KEY_PASSWORD
$oldIdentityDiscovery = $env:CSC_IDENTITY_AUTO_DISCOVERY
try {
  if ($Unsigned) {
    $env:CSC_LINK = $null
    $env:CSC_KEY_PASSWORD = $null
    $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  } else {
    $env:CSC_LINK = $env:FLAP_RELEASE_CSC_LINK
    $env:CSC_KEY_PASSWORD = $env:FLAP_RELEASE_CSC_KEY_PASSWORD
  }

  Push-Location $projectRoot
  try {
    Invoke-Checked -FilePath 'npm.cmd' -Arguments @('test')
    Invoke-Checked -FilePath 'npm.cmd' -Arguments @('audit', '--omit=dev', '--audit-level=low')
    Invoke-Checked -FilePath 'npm.cmd' -Arguments @('run', 'desktop:make:win')
  } finally {
    Pop-Location
  }
} finally {
  $env:CSC_LINK = $oldCscLink
  $env:CSC_KEY_PASSWORD = $oldCscPassword
  $env:CSC_IDENTITY_AUTO_DISCOVERY = $oldIdentityDiscovery
}

foreach ($path in @($appPath, $installerPath)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Expected release file is missing: $path"
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $path
  if ($Unsigned) {
    if ($signature.Status -ne 'NotSigned') {
      throw "Unsigned release validation failed for $path with status $($signature.Status)"
    }
  } elseif ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate) {
    throw "Signed release validation failed for $path with status $($signature.Status)"
  }
}

$installer = Get-Item -LiteralPath $installerPath
$signature = Get-AuthenticodeSignature -LiteralPath $installerPath
$hash = Get-FileHash -Algorithm SHA256 -LiteralPath $installerPath
$checksumLine = "$($hash.Hash.ToLowerInvariant())  $installerName"
Set-Content -LiteralPath $checksumPath -Value $checksumLine -Encoding ascii

$signerSubject = $null
$signerThumbprint = $null
$certificateNotAfter = $null
if ($signature.SignerCertificate) {
  $signerSubject = $signature.SignerCertificate.Subject
  $signerThumbprint = $signature.SignerCertificate.Thumbprint
  $certificateNotAfter = $signature.SignerCertificate.NotAfter.ToUniversalTime().ToString('o')
}

$manifest = [ordered]@{
  product = 'FLAP Fly Agent'
  version = $version
  file = $installerName
  bytes = $installer.Length
  sha256 = $hash.Hash.ToLowerInvariant()
  signatureStatus = [string]$signature.Status
  signerSubject = $signerSubject
  signerThumbprint = $signerThumbprint
  certificateNotAfter = $certificateNotAfter
  builtAt = (Get-Date).ToUniversalTime().ToString('o')
  gitCommit = (git -C $projectRoot rev-parse HEAD).Trim()
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding utf8

$releaseKind = if ($Unsigned) { 'Unsigned test release' } else { 'Signed release' }
Write-Host "$releaseKind build passed: $installerPath"
Write-Host "SHA-256: $($hash.Hash)"
Write-Host "Checksum file: $checksumPath"
Write-Host "Release manifest: $manifestPath"
