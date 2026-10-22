# 把 src/index.html + src/js/*.js 合并成单文件 HTML，输出到 ../outputs/
$ErrorActionPreference = 'Stop'
$root   = $PSScriptRoot
$srcDir = Join-Path $root 'src'
$jsDir  = Join-Path $srcDir 'js'
$outDir = Join-Path (Split-Path $root -Parent) 'outputs'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

$utf8 = New-Object System.Text.UTF8Encoding($false)

$html = [System.IO.File]::ReadAllText((Join-Path $srcDir 'index.html'), [System.Text.Encoding]::UTF8)

$files = Get-ChildItem -Path (Join-Path $jsDir '*.js') | Sort-Object Name
$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('<script>')
foreach ($f in $files) {
    [void]$sb.AppendLine("/* ==================== $($f.Name) ==================== */")
    [void]$sb.AppendLine([System.IO.File]::ReadAllText($f.FullName, [System.Text.Encoding]::UTF8))
}
[void]$sb.AppendLine('</script>')

$marker = '<!-- INJECT_JS -->'
if ($html.IndexOf($marker) -lt 0) { throw "index.html 中找不到注入标记 $marker" }
$out = $html.Replace($marker, $sb.ToString())

$outPath = Join-Path $outDir 'muse-eeg-pipeline.html'
[System.IO.File]::WriteAllText($outPath, $out, $utf8)

$kb = [math]::Round((Get-Item $outPath).Length / 1KB, 1)
Write-Host "built -> $outPath ($kb KB, $($files.Count) js modules)"
