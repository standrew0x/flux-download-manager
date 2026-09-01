$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$size = 512
$bitmap = [System.Drawing.Bitmap]::new($size, $size)
$bitmap.SetResolution(96, 96)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)

$bounds = [System.Drawing.RectangleF]::new(16, 16, 480, 480)
$path = [System.Drawing.Drawing2D.GraphicsPath]::new()
$radius = 116
$diameter = $radius * 2
$path.AddArc($bounds.X, $bounds.Y, $diameter, $diameter, 180, 90)
$path.AddArc($bounds.Right - $diameter, $bounds.Y, $diameter, $diameter, 270, 90)
$path.AddArc($bounds.Right - $diameter, $bounds.Bottom - $diameter, $diameter, $diameter, 0, 90)
$path.AddArc($bounds.X, $bounds.Bottom - $diameter, $diameter, $diameter, 90, 90)
$path.CloseFigure()

$background = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
  $bounds,
  [System.Drawing.Color]::FromArgb(255, 20, 28, 48),
  [System.Drawing.Color]::FromArgb(255, 4, 8, 18),
  55
)
$graphics.FillPath($background, $path)

$glowBounds = [System.Drawing.RectangleF]::new(98, 66, 316, 316)
$glowPath = [System.Drawing.Drawing2D.GraphicsPath]::new()
$glowPath.AddEllipse($glowBounds)
$glowBrush = [System.Drawing.Drawing2D.PathGradientBrush]::new($glowPath)
$glowBrush.CenterColor = [System.Drawing.Color]::FromArgb(145, 61, 238, 196)
$glowBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 28, 196, 255))
$graphics.FillEllipse($glowBrush, $glowBounds)

$bolt = [System.Drawing.Drawing2D.GraphicsPath]::new()
$bolt.AddPolygon([System.Drawing.PointF[]]@(
  [System.Drawing.PointF]::new(288, 74),
  [System.Drawing.PointF]::new(148, 278),
  [System.Drawing.PointF]::new(238, 278),
  [System.Drawing.PointF]::new(207, 435),
  [System.Drawing.PointF]::new(365, 221),
  [System.Drawing.PointF]::new(269, 221)
))
$boltBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
  [System.Drawing.RectangleF]::new(148, 74, 217, 361),
  [System.Drawing.Color]::FromArgb(255, 63, 245, 190),
  [System.Drawing.Color]::FromArgb(255, 39, 167, 255),
  90
)
$graphics.FillPath($boltBrush, $bolt)

$output = Join-Path $PSScriptRoot 'icon.png'
$bitmap.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)

$boltBrush.Dispose()
$bolt.Dispose()
$glowBrush.Dispose()
$glowPath.Dispose()
$background.Dispose()
$path.Dispose()
$graphics.Dispose()
$bitmap.Dispose()

Write-Host "Created $output"
