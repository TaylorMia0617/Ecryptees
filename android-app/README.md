# Offline Android APK

This wrapper packages the repository's web application into one offline APK. It loads the split web assets through Android's internal HTTPS asset origin, uses the system document picker for imports, and streams Blob downloads into Storage Access Framework destinations.

## Build

The local toolchain lives on `D:\Android`; no Android Studio or emulator is required.

```powershell
powershell -ExecutionPolicy Bypass -File .\android-app\build-apk.ps1
```

The resulting sideloadable release package is `dist/Ecryptees.apk`. The build synchronizes `index.html`, `css/`, `js/`, `assets/`, the manifest, and the Service Worker into generated Android assets. Do not edit generated files under `app/build/`.

Keep `D:\Android\signing\ecryptees-release.p12` and `ecryptees-signing.properties` backed up together. Android requires future APK updates to be signed by the same key; deleting it forces users to uninstall the existing app before installing a differently signed build.

## Runtime boundaries

- Minimum Android version: Android 8.0 (API 26).
- No `INTERNET` or broad storage permission is declared.
- Android System WebView must be current enough to provide Web Crypto, workers, IndexedDB, and image codecs.
- The app-private shelf survives ordinary cache cleanup but is removed if the user clears app data or uninstalls the APK. Exported files remain in the user-selected document location.
