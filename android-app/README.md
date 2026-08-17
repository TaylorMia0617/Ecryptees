# Offline Android APK

This wrapper packages the repository's offline-first web application into one APK. It loads the split web assets through Android's internal HTTPS asset origin, uses the system document picker for local imports, streams Blob downloads into Storage Access Framework destinations, and exposes a bounded HTTPS bridge only for user-triggered webpage import.

## Build

The local toolchain lives on `D:\Android`; no Android Studio or emulator is required.

```powershell
powershell -ExecutionPolicy Bypass -File .\android-app\build-apk.ps1
```

The resulting sideloadable release packages are the versioned `dist/Ecryptees-v<version>.apk` and the stable alias `dist/Ecryptees.apk`. The build verifies that the filename version, APK metadata, and release certificate agree. It synchronizes `index.html`, `css/`, `js/`, `assets/`, the manifest, and the Service Worker into generated Android assets. Do not edit generated files under `app/build/`.

Keep `D:\Android\signing\ecryptees-release.p12` and `ecryptees-signing.properties` backed up together. Android requires future APK updates to be signed by the same key; deleting it forces users to uninstall the existing app before installing a differently signed build.

## Runtime boundaries

- Minimum Android version: Android 8.0 (API 26).
- `INTERNET` is declared for webpage import. No broad storage permission is declared.
- Cold start, local imports, reading, shelf operations, and exports do not use the network. A request begins only after the user opens “网页链接” and presses “分析网页”.
- Remote requests accept HTTPS only, use system TLS validation, omit cookies and authorization state, and stream through at most two native tasks. HTML is capped at 5 MiB and image bytes remain subject to the 500 MiB comic limit.
- Android System WebView must be current enough to provide Web Crypto, workers, IndexedDB, and image codecs.
- The app-private shelf stores original pages, covers, metadata, reading progress, and lightweight folder assignments. It does not persist `.ecomic` archives or generated long PNGs; both are created temporarily on explicit export.
- The app-private shelf survives ordinary cache cleanup and in-place APK updates, but is removed if the user clears app data or uninstalls the APK. Exported files remain in the user-selected document location.
- The activity accepts single-file `ACTION_VIEW` and `ACTION_SEND` handoffs from other apps. Broad candidate registration is followed by strict `.ecomic` filename, size, magic, and archive-authentication checks.
- Video assets store their original MP4 bytes in app-private storage, matching the comic shelf's original-page model. `.emp4` is decrypted on import and generated temporarily only for explicit export.
- The activity accepts both `.ecomic` and `.emp4` handoffs. Video handoffs are capped independently and keep all Android transfers chunked.
- Future channel, server, and peer-to-peer concepts are not implemented. The current network bridge is scoped to static webpage/image import and must not be reused for background sync without a separate architecture and privacy review.
