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
    $destinationDirectory = Join-Path (Split-Path $PSScriptRoot -Parent) 'dist'
    New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
    Copy-Item -LiteralPath $source -Destination (Join-Path $destinationDirectory 'Ecryptees.apk') -Force
    Write-Host "APK: $destinationDirectory\Ecryptees.apk"
} finally {
    Pop-Location
}
