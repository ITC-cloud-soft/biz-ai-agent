param([string]$Deck, [string]$OutDir, [string]$Only = "")
# Renders every slide (or the comma-separated slide numbers in -Only) of a .pptx to PNG with PowerPoint itself.
New-Item -ItemType Directory -Force $OutDir | Out-Null
$app = New-Object -ComObject PowerPoint.Application
try {
  $p = $app.Presentations.Open((Resolve-Path $Deck).Path, -1, 0, 0)
  $want = if ($Only) { $Only.Split(',') | ForEach-Object { [int]$_ } } else { 1..$p.Slides.Count }
  foreach ($i in $want) {
    $f = Join-Path $OutDir ("slide-{0:D2}.png" -f $i)
    $p.Slides.Item($i).Export($f, "PNG", 1600, 900)
    Write-Output $f
  }
  $p.Close()
} finally { $app.Quit() }

