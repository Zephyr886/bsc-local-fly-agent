param(
  [Parameter(Mandatory = $true)]
  [string]$RegistryAddress,
  [Parameter(Mandatory = $true)]
  [string]$Cartridge,
  [string]$VaultPath = (Join-Path $env:LOCALAPPDATA "FLAP Fly Agent\data\local-wallet.vault.json")
)

$ErrorActionPreference = "Stop"
$resolvedVault = [System.IO.Path]::GetFullPath($VaultPath)
$resolvedCartridge = [System.IO.Path]::GetFullPath($Cartridge)
if (-not [System.IO.File]::Exists($resolvedVault)) {
  throw "Encrypted local wallet vault not found: $resolvedVault"
}
if (-not [System.IO.Directory]::Exists($resolvedCartridge)) {
  throw "Cartridge directory not found: $resolvedCartridge"
}

$securePassword = Read-Host "输入 FLAP Fly Agent 本地钱包密码（不会回显）" -AsSecureString
$credential = [System.Management.Automation.PSCredential]::new("vault", $securePassword)
$plainPassword = $credential.GetNetworkCredential().Password
try {
  $env:FLAP_REGISTRY_V4_VAULT_PATH = $resolvedVault
  $env:FLAP_REGISTRY_V4_VAULT_PASSWORD = $plainPassword
  & node scripts/publish-fly-cartridge-v4-testnet.mjs --confirm-testnet `
    --address $RegistryAddress --cartridge $resolvedCartridge
  if ($LASTEXITCODE -ne 0) { throw "Registry V4 publication failed with exit code $LASTEXITCODE" }
} finally {
  $plainPassword = $null
  $credential = $null
  $securePassword.Dispose()
  Remove-Item Env:FLAP_REGISTRY_V4_VAULT_PATH -ErrorAction SilentlyContinue
  Remove-Item Env:FLAP_REGISTRY_V4_VAULT_PASSWORD -ErrorAction SilentlyContinue
}
