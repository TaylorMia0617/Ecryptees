$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$destinationRoot = Join-Path $repositoryRoot 'desktop-dist'
$allowedFiles = @(
    'index.html',
    'manifest.webmanifest',
    'service-worker.js'
)
$allowedDirectories = @('assets', 'css', 'js')

if (Test-Path -LiteralPath $destinationRoot) {
    $resolvedRepository = [System.IO.Path]::GetFullPath($repositoryRoot)
    $resolvedDestination = [System.IO.Path]::GetFullPath($destinationRoot)
    if (-not $resolvedDestination.StartsWith($resolvedRepository + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clear desktop output outside the repository: $resolvedDestination"
    }
    Remove-Item -LiteralPath $resolvedDestination -Recurse -Force
}

New-Item -ItemType Directory -Path $destinationRoot | Out-Null
foreach ($relativePath in $allowedFiles) {
    Copy-Item -LiteralPath (Join-Path $repositoryRoot $relativePath) -Destination (Join-Path $destinationRoot $relativePath)
}
foreach ($relativePath in $allowedDirectories) {
    Copy-Item -LiteralPath (Join-Path $repositoryRoot $relativePath) -Destination (Join-Path $destinationRoot $relativePath) -Recurse
}

Write-Host "Desktop assets prepared at $destinationRoot"
