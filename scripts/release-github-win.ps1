param(
  [Parameter(Mandatory = $false)]
  [string]$TagName = $env:GITHUB_REF_NAME
)

$ErrorActionPreference = 'Stop'

$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$packagePath = Join-Path $workspace 'package.json'
$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
$version = [string]$package.version
$expectedTag = "v$version"

if ([string]::IsNullOrWhiteSpace($TagName)) {
  throw 'A release tag is required. Pass -TagName vX.Y.Z or set GITHUB_REF_NAME.'
}
if ($TagName -ne $expectedTag) {
  throw "Release tag $TagName does not match package.json version $version (expected $expectedTag)."
}

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command failed with exit code $LASTEXITCODE."
  }
}

Push-Location $workspace
try {
  Invoke-Checked 'npm.cmd' @('run', 'typecheck')
  Invoke-Checked 'npm.cmd' @('run', 'release:win')

  $artifactDir = Join-Path $workspace 'artifacts'
  $installerName = "HRack-Setup-$version.exe"
  $installerPath = Join-Path $artifactDir $installerName
  $blockmapPath = "$installerPath.blockmap"
  foreach ($required in @($installerPath, $blockmapPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
      throw "Release output is missing: $required"
    }
  }

  $digest = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $checksumPath = "$installerPath.sha256"
  "$digest  $installerName" | Set-Content -LiteralPath $checksumPath -Encoding ascii

  [pscustomobject]@{
    Tag = $TagName
    Installer = $installerPath
    Blockmap = $blockmapPath
    Checksum = $checksumPath
    SHA256 = $digest
  } | Format-List
} finally {
  Pop-Location
}
