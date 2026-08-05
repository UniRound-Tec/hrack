$ErrorActionPreference = 'Stop'

$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$packagePath = Join-Path $workspace 'package.json'
$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
$version = [string]$package.version
$releaseDir = Join-Path $env:TEMP ("vibing-release-$version-" + [guid]::NewGuid().ToString('N'))
$artifactDir = Join-Path $workspace 'artifacts'
$installerName = "Vibing-Setup-$version.exe"
$installerPath = Join-Path $releaseDir $installerName
$blockmapPath = "$installerPath.blockmap"
$unpackedExe = Join-Path $releaseDir 'win-unpacked\Vibing.exe'
$succeeded = $false

function Assert-ReleaseConfig {
  if ($package.build.nsis.oneClick -ne $false) {
    throw 'NSIS oneClick must be false; the installer must use the guided flow.'
  }
  if ($package.build.nsis.allowToChangeInstallationDirectory -ne $true) {
    throw 'NSIS must allow the user to choose the installation directory.'
  }
  $winIcon = Join-Path $workspace ([string]$package.build.win.icon)
  if (-not (Test-Path -LiteralPath $winIcon -PathType Leaf)) {
    throw "Windows application icon is missing: $winIcon"
  }
  $afterPack = Join-Path $workspace ([string]$package.build.afterPack)
  if (-not (Test-Path -LiteralPath $afterPack -PathType Leaf)) {
    throw "afterPack validation hook is missing: $afterPack"
  }
  $trayMapping = @($package.build.extraResources) | Where-Object {
    $_.from -eq 'resources/tray' -and $_.to -eq 'tray'
  }
  if (-not $trayMapping) {
    throw 'resources/tray must be copied to the packaged resources/tray directory.'
  }
}

function Get-IconDigest([string]$Path) {
  Add-Type -AssemblyName System.Drawing
  $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($Path)
  if (-not $icon) { throw "Unable to extract icon from $Path" }
  $bitmap = $icon.ToBitmap()
  $stream = [System.IO.MemoryStream]::new()
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    return [BitConverter]::ToString($sha.ComputeHash($stream.ToArray())).Replace('-', '')
  } finally {
    $sha.Dispose()
    $stream.Dispose()
    $bitmap.Dispose()
    $icon.Dispose()
  }
}

function Get-FileSha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '')
  } finally {
    $sha.Dispose()
    $stream.Dispose()
  }
}

try {
  Assert-ReleaseConfig

  Push-Location $workspace
  try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Application build failed.' }

    & npx.cmd electron-builder --win nsis --x64 "--config.directories.output=$releaseDir"
    if ($LASTEXITCODE -ne 0) { throw 'Windows packaging failed.' }
  } finally {
    Pop-Location
  }

  foreach ($required in @($installerPath, $blockmapPath, $unpackedExe)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
      throw "Release output is missing: $required"
    }
  }

  & node (Join-Path $workspace 'scripts\verify-packaged-tray.cjs') $unpackedExe
  if ($LASTEXITCODE -ne 0) { throw 'Packaged tray runtime verification failed.' }

  $installerIcon = Get-IconDigest $installerPath
  $appIcon = Get-IconDigest $unpackedExe
  $defaultElectron = Join-Path $workspace 'node_modules\electron\dist\electron.exe'
  $defaultIcon = Get-IconDigest $defaultElectron
  if ($installerIcon -ne $appIcon) {
    throw 'Installer and packaged application icons do not match.'
  }
  if ($installerIcon -eq $defaultIcon) {
    throw 'Release still uses the default Electron icon.'
  }

  $installer = Get-Item -LiteralPath $installerPath
  if ($installer.VersionInfo.ProductVersion -ne $version) {
    throw "Installer version $($installer.VersionInfo.ProductVersion) does not match package version $version."
  }

  New-Item -ItemType Directory -Path $artifactDir -Force | Out-Null
  Copy-Item -LiteralPath $installerPath -Destination (Join-Path $artifactDir $installerName) -Force
  Copy-Item -LiteralPath $blockmapPath -Destination (Join-Path $artifactDir "$installerName.blockmap") -Force

  $finalInstaller = Join-Path $artifactDir $installerName
  $finalFile = Get-Item -LiteralPath $finalInstaller
  $signature = 'NotSigned'
  try {
    $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($finalInstaller)
    if ($certificate) {
      $signature = 'Present'
      $certificate.Dispose()
    }
  } catch {
    $signature = 'NotSigned'
  }
  [pscustomobject]@{
    Path = $finalFile.FullName
    Version = $version
    SizeMiB = [math]::Round($finalFile.Length / 1MB, 2)
    SHA256 = Get-FileSha256 $finalInstaller
    Signature = $signature
    GuidedInstaller = $true
    InstallationDirectoryChoice = $true
    TrayRuntimeVerified = $true
    CustomIconVerified = $true
  } | Format-List
  if ($signature -ne 'Present') {
    Write-Warning 'Installer is not code-signed; Windows may show a security warning.'
  }
  $succeeded = $true
} finally {
  if ($succeeded -and (Test-Path -LiteralPath $releaseDir -PathType Container)) {
    $resolvedRelease = [System.IO.Path]::GetFullPath($releaseDir)
    $resolvedTemp = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
    if ($resolvedRelease.StartsWith($resolvedTemp) -and (Split-Path $resolvedRelease -Leaf) -like 'vibing-release-*') {
      Remove-Item -LiteralPath $resolvedRelease -Recurse -Force
    }
  }
}
