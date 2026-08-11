$ErrorActionPreference = 'Stop'

$androidRoot = 'D:\Android'
$env:ANDROID_SDK_ROOT = "$androidRoot\Sdk"
$env:ANDROID_HOME = $env:ANDROID_SDK_ROOT
$env:ANDROID_USER_HOME = "$androidRoot\android-home"
$env:GRADLE_USER_HOME = "$androidRoot\gradle-home"
$env:TEMP = "$androidRoot\temp"
$env:TMP = $env:TEMP

New-Item -ItemType Directory -Force -Path $env:GRADLE_USER_HOME, $env:ANDROID_USER_HOME, $env:TEMP | Out-Null
$sdkProperty = $env:ANDROID_SDK_ROOT.Replace('\', '\\').Replace(':', '\:')
[IO.File]::WriteAllText(
    "$PSScriptRoot\local.properties",
    "sdk.dir=$sdkProperty`n",
    [Text.UTF8Encoding]::new($false)
)

Push-Location $PSScriptRoot
try {
    $signingProperties = "$androidRoot\signing\ecryptees-signing.properties"
    if (-not (Test-Path -LiteralPath $signingProperties)) {
        throw "Missing release signing configuration: $signingProperties"
    }
    $installedGradle = "$androidRoot\gradle-9.1.0\bin\gradle.bat"
    $gradleCommand = if (Test-Path -LiteralPath $installedGradle) {
        $installedGradle
    } else {
        "$PSScriptRoot\gradlew.bat"
    }
    & $gradleCommand --no-daemon clean assembleRelease lintRelease
    if ($LASTEXITCODE -ne 0) {
        throw "Android build failed with exit code $LASTEXITCODE"
    }
    $source = "$PSScriptRoot\app\build\outputs\apk\release\app-release.apk"
    $buildToolsDirectory = Get-ChildItem -LiteralPath "$env:ANDROID_SDK_ROOT\build-tools" -Directory |
        Sort-Object { [version]$_.Name } -Descending |
        Select-Object -First 1
    if (-not $buildToolsDirectory) {
        throw 'Android build-tools are unavailable for APK signature verification'
    }
    $apkSigner = Join-Path $buildToolsDirectory.FullName 'apksigner.bat'
    $signatureOutput = & $apkSigner verify --print-certs $source 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "APK signature verification failed:`n$($signatureOutput -join "`n")"
    }
    $expectedCertificate = '91306e7c15932646a58ffbd3443f541be57401f1f64106d8dcd0e97fbc5687e8'
    $signatureText = $signatureOutput -join "`n"
    if ($signatureText -notmatch [regex]::Escape($expectedCertificate)) {
        throw "Unexpected release signing certificate. Expected SHA-256 $expectedCertificate"
    }
    $destinationDirectory = Join-Path (Split-Path $PSScriptRoot -Parent) 'dist'
    New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
    Copy-Item -LiteralPath $source -Destination (Join-Path $destinationDirectory 'Ecryptees.apk') -Force
    Write-Host "APK: $destinationDirectory\Ecryptees.apk"
} finally {
    Pop-Location
}
