param(
  [ValidateSet("testnet", "mainnet")]
  [string]$Chain = "testnet",
  [string]$VaultPath = (Join-Path $env:LOCALAPPDATA "FLAP Fly Agent\data\local-wallet.vault.json")
)

$ErrorActionPreference = "Stop"
$resolvedVault = [System.IO.Path]::GetFullPath($VaultPath)
if (-not [System.IO.File]::Exists($resolvedVault)) {
  throw "Encrypted local wallet vault not found: $resolvedVault"
}

$securePassword = Read-Host "输入 FLAP Fly Agent 本地钱包密码（不会回显）" -AsSecureString
$credential = [System.Management.Automation.PSCredential]::new("vault", $securePassword)
$plainPassword = $credential.GetNetworkCredential().Password
try {
  $env:FLAP_REGISTRY_V4_VAULT_PATH = $resolvedVault
  $env:FLAP_REGISTRY_V4_VAULT_PASSWORD = $plainPassword
  if ($Chain -eq "mainnet") {
    if ($env:FLAP_REGISTRY_V4_MAINNET_ACK -ne "DEPLOY_IMMUTABLE_V4_MAINNET") {
      throw "Mainnet still requires FLAP_REGISTRY_V4_MAINNET_ACK=DEPLOY_IMMUTABLE_V4_MAINNET"
    }
    & node scripts/deploy-fly-cartridge-v4-registry.mjs --chain mainnet --confirm-mainnet
  } else {
    & node scripts/deploy-fly-cartridge-v4-registry.mjs --chain testnet --confirm-testnet
  }
  if ($LASTEXITCODE -ne 0) { throw "Registry V4 deployment failed with exit code $LASTEXITCODE" }
} finally {
  $plainPassword = $null
  $credential = $null
  $securePassword.Dispose()
  Remove-Item Env:FLAP_REGISTRY_V4_VAULT_PATH -ErrorAction SilentlyContinue
  Remove-Item Env:FLAP_REGISTRY_V4_VAULT_PASSWORD -ErrorAction SilentlyContinue
}
