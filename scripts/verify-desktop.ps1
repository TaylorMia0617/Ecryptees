$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$bundleRoot = Join-Path $repositoryRoot 'src-tauri\target\release\bundle\nsis'
$distributionRoot = Join-Path $repositoryRoot 'dist\windows'
$expectedName = 'Ecryptees-v1.1.4-x64-setup.exe'

if (-not (Test-Path -LiteralPath $bundleRoot)) {
    throw "Tauri NSIS output is missing: $bundleRoot"
}

$installer = Get-ChildItem -LiteralPath $bundleRoot -Filter '*-setup.exe' -File |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
if (-not $installer) {
    throw 'No NSIS setup executable was produced.'
}

New-Item -ItemType Directory -Path $distributionRoot -Force | Out-Null
$versionedPath = Join-Path $distributionRoot $expectedName
$stablePath = Join-Path $distributionRoot 'Ecryptees-Setup.exe'
Copy-Item -LiteralPath $installer.FullName -Destination $versionedPath -Force
Copy-Item -LiteralPath $installer.FullName -Destination $stablePath -Force

$sha256 = [System.Security.Cryptography.SHA256]::Create()
$stream = [System.IO.File]::OpenRead($versionedPath)
try {
    $hashBytes = $sha256.ComputeHash($stream)
} finally {
    $stream.Dispose()
    $sha256.Dispose()
}
$hashText = -join ($hashBytes | ForEach-Object { $_.ToString('x2') })
$hashLine = "$hashText  $expectedName"
Set-Content -LiteralPath (Join-Path $distributionRoot "$expectedName.sha256") -Value $hashLine -Encoding ascii

Write-Host "Installer: $versionedPath"
Write-Host "SHA-256: $hashText"
