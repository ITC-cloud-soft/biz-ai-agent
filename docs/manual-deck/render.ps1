param([string]$Deck, [string]$OutDir, [string]$Only = "")
# Renders every slide (or the comma-separated slide numbers in -Only) of a .pptx to PNG with PowerPoint itself.
# PowerPoint is single-instance: a PowerPoint that was already running (the user's own windows) is left running,
# and only the deck this script opened is closed.
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $OutDir | Out-Null
$wasRunning = [bool](Get-Process POWERPNT -ErrorAction SilentlyContinue)
$app = New-Object -ComObject PowerPoint.Application
$p = $null
try {
  $p = $app.Presentations.Open((Resolve-Path $Deck).Path, -1, 0, 0)  # ReadOnly, Untitled=false, WithWindow=false
  $want = if ($Only) { $Only.Split(',') | ForEach-Object { [int]$_ } } else { 1..$p.Slides.Count }
  foreach ($i in $want) {
    $f = Join-Path $OutDir ("slide-{0:D2}.png" -f $i)
    $p.Slides.Item($i).Export($f, "PNG", 1600, 900)
    Write-Output $f
  }
} finally {
  if ($p) { $p.Close() }
  # leave a PowerPoint that was already open (the user's) running
  if (-not $wasRunning -and $app.Presentations.Count -eq 0) { $app.Quit() }
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null
}
