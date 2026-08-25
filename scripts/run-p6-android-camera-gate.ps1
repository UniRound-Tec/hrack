param(
  [string]$RelayBase = 'https://hrack.modplex.app',
  [string]$Adb = 'C:\Users\Jesse\AppData\Local\Android\Sdk\platform-tools\adb.exe',
  [string]$Emulator = 'C:\Users\Jesse\AppData\Local\Android\Sdk\emulator\emulator.exe',
  [string]$Avd = 'nuva_x64'
)

$ErrorActionPreference = 'Stop'
$appArtifacts = [IO.Path]::GetFullPath(
  (Join-Path $PSScriptRoot '..\remotes\app\artifacts\android')
)
$qrPath = [IO.Path]::GetFullPath(
  (Join-Path $appArtifacts 'p6-private-camera-qr.png')
)
if (-not $qrPath.StartsWith($appArtifacts + [IO.Path]::DirectorySeparatorChar)) {
  throw 'Refusing to place the private QR outside the App artifact directory'
}

$room = Invoke-RestMethod `
  -Method Post `
  -Uri "$RelayBase/remote/v1/rooms" `
  -ContentType 'application/json' `
  -Body '{}'
$testExit = 1

try {
  $env:HRACK_CAMERA_JOIN_URL = $room.joinUrl
  $env:HRACK_CAMERA_QR_OUTPUT = $qrPath
  node scripts/write-camera-qr.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Failed to generate private camera QR' }

  & $Adb emu kill 2>$null | Out-Null
  $stopDeadline = (Get-Date).AddSeconds(25)
  while ((& $Adb devices | Select-String 'emulator-\d+\s+device') -and
    (Get-Date) -lt $stopDeadline) {
    Start-Sleep -Milliseconds 500
  }

  $cameraSource = 'imagefile:' + $qrPath.Replace('\', '/')
  Start-Process `
    -FilePath $Emulator `
    -ArgumentList @(
      '-avd', $Avd,
      '-no-window',
      '-no-snapshot-load',
      '-no-metrics',
      '-no-boot-anim',
      '-gpu', 'swiftshader_indirect',
      '-camera-back', $cameraSource
    ) `
    -WindowStyle Hidden

  & $Adb wait-for-device
  $bootDeadline = (Get-Date).AddMinutes(2)
  do {
    $booted = (& $Adb shell getprop sys.boot_completed 2>$null).Trim()
    if ($booted -eq '1') { break }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $bootDeadline)
  if ($booted -ne '1') { throw 'Android QR emulator did not boot' }

  & $Adb shell input keyevent 82
  & $Adb shell input swipe 540 1800 540 400 300

  $env:HRACK_REMOTE_P6_URL = "$RelayBase/"
  $env:HRACK_ANDROID_ADB = $Adb
  $env:HRACK_REMOTE_P6_JOIN_URL = $room.joinUrl
  $env:HRACK_REMOTE_P6_REVOKE_TOKEN = $room.revokeToken
  $env:HRACK_ANDROID_CAMERA_QR = '1'
  npx playwright test e2e/remote-p6-android-live.spec.ts
  $testExit = $LASTEXITCODE
} finally {
  try {
    Invoke-WebRequest `
      -Method Delete `
      -Uri "$RelayBase/remote/v1/rooms/$($room.roomId)" `
      -Headers @{ Authorization = "Bearer $($room.revokeToken)" } | Out-Null
  } catch {
    # The test normally revokes the room before this cleanup runs.
  }
  if (Test-Path -LiteralPath $qrPath) {
    Remove-Item -LiteralPath $qrPath -Force
  }
}

exit $testExit
