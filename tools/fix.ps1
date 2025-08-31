$ErrorActionPreference = 'Stop'

$path = Join-Path $PSScriptRoot "..\criticalmoment.html"
$content = Get-Content -Raw -Encoding UTF8 $path

# 1) Fix the broken const sign line inside formatDelta
$pattern = 'const\s+sign\s*=\s*cp[^\r\n;]*;'
$replacement = "const sign = cp >= 0 ? '' : '-';"
$content = [System.Text.RegularExpressions.Regex]::Replace($content, $pattern, $replacement)

# 2) Clean mojibake for engine loading text
$content = $content -replace 'loading�','loading...'
$content = $content -replace 'Loading engine�','Loading engine...'

# 3) Replace PIECES_UNICODE mapping with proper chess glyphs
$patternPU = 'const\s+PIECES_UNICODE\s*=\s*\{[\s\S]*?\};'
$replacementPU = @"
const PIECES_UNICODE = {
  'P':'♙','N':'♘','B':'♗','R':'♖','Q':'♕','K':'♔',
  'p':'♟','n':'♞','b':'♝','r':'♜','q':'♛','k':'♚'
};
"@
$content = [System.Text.RegularExpressions.Regex]::Replace($content, $patternPU, $replacementPU)

# 4) Add global error handlers after setStatus definition to surface JS errors in UI
$setStatusLine = "function setStatus(msg){ $('#status').textContent = msg; }"
$inject = @"
window.addEventListener('error', (e) => {
  try { setStatus('JS error: ' + (e.message || (e.error && e.error.message) || 'unknown')); } catch {}
});
window.addEventListener('unhandledrejection', (e) => {
  try { setStatus('Promise error: ' + ((e.reason && (e.reason.message || e.reason)) || 'unknown')); } catch {}
});
"@
if($content -match [System.Text.RegularExpressions.Regex]::Escape($setStatusLine)){
  $content = $content -replace [System.Text.RegularExpressions.Regex]::Escape($setStatusLine), ($setStatusLine + "`r`n" + $inject)
}

# If not injected (pattern didn't match), append error handlers before closing </script>
if(-not ($content -like "*window.addEventListener('error'*")){
  $inject2 = @"
window.addEventListener('error', (e) => {
  try { setStatus('JS error: ' + (e.message || (e.error && e.error.message) || 'unknown')); } catch {}
});
window.addEventListener('unhandledrejection', (e) => {
  try { setStatus('Promise error: ' + ((e.reason && (e.reason.message || e.reason)) || 'unknown')); } catch {}
});
"@
  $content = $content -replace "</script>", ($inject2 + "</script>")
}

Set-Content -Encoding UTF8 $path $content
