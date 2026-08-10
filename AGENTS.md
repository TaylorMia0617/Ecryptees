# Repository Guidelines

## Project Structure & Module Organization

This repository contains a dependency-free browser application plus an offline Android wrapper.

- `index.html` is the semantic shell; `css/styles.css` and `assets/` hold presentation resources.
- `js/core.js` and `js/app.js` own legacy text/image formats and UI.
- `js/comic-core.js` defines `.ecomic` v1. `js/comic-worker.js` owns bounded crypto/image workers, storage, and streaming PNG work; `js/comic-app.js` owns comic, reader, and shelf UI.
- `js/history-core.js` validates shelf records. `js/pwa.js` and `service-worker.js` provide the HTTPS PWA shell.
- `js/android-bridge.js` and `android-app/` package the same web assets into an offline APK, stream downloads, and run up to two tokenized HEIC/HEIF decode tasks without changing archived source bytes.
- `tests/*.test.js` contains Node regressions; `design-qa.md` records browser and package evidence.

Keep processing local. Do not add remote assets, analytics, frameworks, or unnecessary permissions.

## Build, Test, and Development Commands

- `node --test tests/*.test.js` runs format and static integration tests.
- `node --check js/comic-app.js` validates a changed script; repeat for each changed JavaScript file.
- `python -m http.server 8000` serves the browser/PWA build locally.
- `powershell -ExecutionPolicy Bypass -File .\android-app\build-apk.ps1` builds, lints, and signs the APK using the D-drive toolchain, then writes `dist/Ecryptees.apk`.
- `git diff --check` finds whitespace errors and conflict markers.

## Coding Style & Boundaries

Use four-space indentation, `camelCase` for functions/DOM IDs, `UPPER_SNAKE_CASE` for constants, and kebab-case CSS classes. Prefer `const`, accessible labels, visible focus, and `addEventListener`.

Core files must not access the DOM. Controllers own UI state and Blob URL cleanup. Comic parallelism is capped at two lanes on mobile and four on desktop; encrypted chunks must still be written by counter order. Write shelf pages directly to a generation-specific final key and commit metadata only after every page succeeds. Long PNG generation must persist to shelf application data and must never start a download automatically; only the explicit shelf “导出长图” action may download it. Preserve classic-script order and never change the text codebook, image v1–v3 payloads, or `.ecomic` v1 unintentionally. Android transfers must remain chunked.

## Storage, Testing, and Submission

Browser storage is rebuildable. The internal shelf stores original pages, cover, metadata, and the generated long PNG; deleting a book must remove all four. A connected shelf directory stores `books/<32-char-id>/archive.ecomic` plus optional PNG, cover, and metadata. APK private storage survives cache cleanup but not uninstall or “clear data”; explicitly exported documents remain external. Never enable Android cloud backup or `INTERNET` without explicit review.

Cover byte-exact round trips, parallelism 1/2/4 ordering, reader collapse persistence, HEIC/HEIF token bridging, authentication failures, 80-page/500 MiB boundaries, PWA metadata, permissions, lint, APK signing, and chunked export. Recent commits use short Chinese summaries without prefixes. Pull requests should describe format, privacy, storage, and compatibility effects and list all verification performed.
