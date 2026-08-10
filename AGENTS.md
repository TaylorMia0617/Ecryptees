# Repository Guidelines

## Project Structure & Module Organization

This is a dependency-free static browser application.

- `index.html` contains the semantic shell and ordered resource references.
- `css/styles.css` contains responsive/component styles; `assets/` contains local images.
- `js/core.js` and `js/app.js` own the legacy text/image formats and interface.
- `js/comic-core.js` defines `.ecomic` v1, limits, and cryptography; `js/history-core.js` validates shelf records.
- `js/comic-worker.js` performs streaming archive, PNG, and storage work. `js/comic-app.js` owns comic controls, directory integration, shelf cards, and the modal reader.
- `tests/*.test.js` contains Node regressions; `design-qa.md` records browser evidence.

Keep processing local. Do not add remote assets, frameworks, analytics, or build dependencies.

## Build, Test, and Development Commands

No installation or build is required.

- `node --test tests/*.test.js` runs all format and static integration tests.
- `node --check js/comic-app.js` validates one script; repeat for every changed JavaScript file.
- `python -m http.server 8000` serves the Worker/OPFS path at `http://localhost:8000/`.
- Open `index.html` directly to exercise the `file://` IndexedDB fallback.
- `git diff --check` finds whitespace errors and conflict markers.

## Coding Style & Boundaries

Use four-space indentation, `camelCase` for functions/DOM IDs, `UPPER_SNAKE_CASE` for constants, and kebab-case CSS classes. Prefer `const`, explicit control flow, accessible labels, visible focus, and `addEventListener`.

Core files must not access the DOM. Controllers own UI state and Blob URL cleanup. Preserve classic-script order: core, comic core, history core, app, worker, comic app. Do not use ES modules because direct local loading must work. Never change the text codebook, image v1–v3 payloads, or `.ecomic` v1 unintentionally.

## Shelf Storage Rules

Browser storage is a rebuildable cache. A connected shelf directory stores `books/<32-char-id>/archive.ecomic` plus optional `long.png`, `cover.jpg`, and `metadata.json`. Write binary files before metadata so incomplete folders are ignored. Reconnecting the same directory must work after browser data is cleared or in another supported browser. Never delete directory files merely because browser cache is cleared.

## Testing and Change Submission

Use Node's `node:test` and `node:assert/strict`. Cover byte-exact round trips, authentication failures, 80-page/500 MiB boundaries, history validation, directory migration, and script order. Browser-test direct-file and HTTP flows, refresh persistence, PNG output, cancellation, deletion choices, keyboard use, and 390 px layout. Keep loaded reader images alive until the session closes.

Recent commits use short, direct Chinese summaries without prefixes. Keep commits focused. Pull requests should describe format, privacy, and compatibility effects; list checks; link issues; and include desktop/mobile screenshots for visual changes.
