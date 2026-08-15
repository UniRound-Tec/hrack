param()

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$fontPath = Join-Path $repositoryRoot 'src\assets\fonts\ammonite\Ammonite-2.otf'
$outputRoot = Join-Path $repositoryRoot 'assets\readme'
$fontCollection = [System.Drawing.Text.PrivateFontCollection]::new()
$fontCollection.AddFontFile($fontPath)
$fontFamily = $fontCollection.Families[0]

function Write-Wordmark {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [System.Drawing.Color]$Color
  )

  $width = 746
  $height = 243
  $horizontalPadding = 24
  $verticalPadding = 18
  $bitmap = [System.Drawing.Bitmap]::new(
    $width,
    $height,
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
  )
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

  $wordmark = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $wordmark.AddString(
    'hrack',
    $fontFamily,
    [int][System.Drawing.FontStyle]::Regular,
    200,
    [System.Drawing.PointF]::new(0, 0),
    [System.Drawing.StringFormat]::GenericTypographic
  )

  $bounds = $wordmark.GetBounds()
  $scale = [Math]::Min(
    ($width - 2 * $horizontalPadding) / $bounds.Width,
    ($height - 2 * $verticalPadding) / $bounds.Height
  )
  $renderWidth = $bounds.Width * $scale
  $renderHeight = $bounds.Height * $scale
  $transform = [System.Drawing.Drawing2D.Matrix]::new()
  $transform.Scale($scale, $scale)
  $transform.Translate(
    (($width - $renderWidth) / 2) / $scale - $bounds.X,
    (($height - $renderHeight) / 2) / $scale - $bounds.Y
  )
  $wordmark.Transform($transform)

  $brush = [System.Drawing.SolidBrush]::new($Color)
  $graphics.FillPath($brush, $wordmark)
  $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)

  $brush.Dispose()
  $transform.Dispose()
  $wordmark.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}

Write-Wordmark `
  -Path (Join-Path $outputRoot 'hrack-wordmark-light.png') `
  -Color ([System.Drawing.Color]::FromArgb(255, 26, 26, 26))
Write-Wordmark `
  -Path (Join-Path $outputRoot 'hrack-wordmark-dark.png') `
  -Color ([System.Drawing.Color]::FromArgb(255, 232, 232, 232))

$fontCollection.Dispose()
Write-Host 'Generated Ammonite hrack README wordmarks.'
