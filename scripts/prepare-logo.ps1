# Derive a compact mark from the supplied image without redrawing or recolouring it.
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$assets = Join-Path $root 'documentation\assets'
$public = Join-Path $root 'public'
[System.IO.Directory]::CreateDirectory($assets) | Out-Null
$source = [System.Drawing.Image]::FromFile((Join-Path $root 'logo.png'))
$mark = $null
try {
  if ($source.Width -ne 1254 -or $source.Height -ne 1254) { throw 'The supplied logo dimensions changed; review the crop before regenerating.' }
  $rectangle = New-Object System.Drawing.Rectangle(510, 410, 235, 280)
  $bitmap = New-Object System.Drawing.Bitmap($source)
  try { $mark = $bitmap.Clone($rectangle, $bitmap.PixelFormat) } finally { $bitmap.Dispose() }
  $mark.Save((Join-Path $public 'logo-mark.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  $mark.Save((Join-Path $assets 'logo-mark.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  $source.Save((Join-Path $assets 'logo.png'), [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  if ($null -ne $mark) { $mark.Dispose() }
  $source.Dispose()
}
