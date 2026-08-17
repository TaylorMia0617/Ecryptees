$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$previousBuildJobs = $env:CARGO_BUILD_JOBS
$env:CARGO_BUILD_JOBS = '1'

Push-Location $repositoryRoot
try {
    & npx.cmd tauri build
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri build failed with exit code $LASTEXITCODE. Review the compiler output above; close memory-heavy applications only when it reports an allocation failure."
    }

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'verify-desktop.ps1')
    if ($LASTEXITCODE -ne 0) {
        throw "Desktop installer verification failed with exit code $LASTEXITCODE."
    }
} finally {
    Pop-Location
    $env:CARGO_BUILD_JOBS = $previousBuildJobs
}
