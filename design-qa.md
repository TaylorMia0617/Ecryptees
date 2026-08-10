# Design QA

## Evidence

- Existing visual baseline: `C:\Users\user\AppData\Local\Temp\msbt-qa-iUou9X\source-desktop.png`
- Final text state: `C:\Users\user\AppData\Local\Temp\msbt-visual-5aDpqG\text-desktop.png`
- Final image states: `C:\Users\user\AppData\Local\Temp\msbt-visual-5aDpqG\image-desktop.png`, `image-result-desktop.png`, `image-mobile.png`, and `image-result-mobile.png`
- Combined comparison evidence: `C:\Users\user\AppData\Local\Temp\msbt-visual-5aDpqG\compare-text.png`, `compare-image-desktop.png`, and `compare-image-mobile.png`
- Copy-button source visual truth: `C:\Users\user\AppData\Local\Temp\codex-clipboard-0764b590-d30c-47e8-b75f-b58c2563790b.png`
- Historical copy-button implementation evidence: `C:\Users\user\AppData\Local\Temp\msbt-copy-qa-DROUtp\text-copy-desktop.png`, `image-copy-reference-size.png`, and `image-copy-mobile.png`; the image-copy control was intentionally replaced by TXT download/upload in Pass 6
- Copy-button combined comparison: `C:\Users\user\AppData\Local\Temp\msbt-copy-qa-DROUtp\compare-copy-button.png`
- Final interaction rerun: `C:\Users\user\AppData\Local\Temp\msbt-copy-qa-Jbs9XS` (same visual implementation plus the non-visual live-region announcement)
- Stability/progress fixture: `C:\Users\user\Pictures\Saved Pictures\d79afbd80e767f7033fc631f1b942c7e_720.png` (814,296 bytes, PNG)
- Replacement background: `C:\Users\user\Downloads\CEC610FAF2DA8457BC0B0323E45D9735.jpg` (3424 × 2422, 1,354,600 bytes), embedded byte-for-byte with SHA-256 `742807F8331C790CC92E679FF270202A614B733FB14CEEF9D5922D3EB6977505`
- Current JPG v3 fixture results for the same image: clear 106,755 ciphertext characters, balanced 83,327, and extreme 40,454
- Animated-image fixture: generated two-frame 2 × 2 GIF (111 bytes), used to verify animation detection and explicit first-frame JPG output
- Stability/progress evidence: `C:\Users\user\AppData\Local\Temp\msbt-progress-regression-4NZEAi\encoding-progress.png` and `encoding-complete.png`
- Memory regression evidence: pre-fix `C:\Users\user\AppData\Local\Temp\msbt-memory-diag-cyVgDj`; post-fix `C:\Users\user\AppData\Local\Temp\msbt-memory-diag-WLtBae`
- Desktop viewport and captures: 1440 × 900 CSS px and PNG px; device scale factor 1
- Mobile viewport and captures: 390 × 844 CSS px and PNG px; device scale factor 1
- Copy reference comparison: source 687 × 540 px and implementation 689 × 540 CSS/PNG px at device scale factor 1. They were placed side by side without scaling in a 1402 × 582 comparison canvas; the two-pixel source-width difference is retained and documented rather than stretched.
- States: unchanged text workflow, image upload/encoded state, TXT download state, TXT import state, decoded success/download state, and text-copy disabled/enabled/success states

The original page is the visual baseline for typography, spacing, colors, imagery, controls, and text behavior. The new tab and image workflow are intentional additions defined by the approved feature specification, so their new content is reviewed for consistency rather than false pixel equivalence with a state that did not previously exist.

## Multi-file refactor verification

- On 2026-08-10, the 1,879,392-byte single file was split into `index.html`, `css/styles.css`, `assets/background.jpg`, `js/core.js`, and `js/app.js`. The resulting HTML entry point is 7,685 bytes and contains no inline style block or inline event handler.
- The extracted background remains exactly 1,354,600 bytes with SHA-256 `742807F8331C790CC92E679FF270202A614B733FB14CEEF9D5922D3EB6977505`, matching the embedded source asset.
- `node --test tests/core.test.js` passed all 7 tests: text round trips, invalid text input, CRC32, v1/v2/v3 image ciphertext, malformed payloads, MIME/signature mismatch, CRC damage, and static entry-point references.
- Headless Chrome completed the same smoke suite through both `file:///D:/DevFiles/Ecryptees/index.html` and `http://127.0.0.1:8765/`. Text round trips, tab switching, external CSS/background loading, all three image compression modes, TXT export/import, decoded JPG signature, and download naming passed with no console errors.
- At 390 × 844 CSS px, both loading modes retained a 390 px document width and 350 px card width with no horizontal overflow.
- A maximum 15 MiB compact payload was CRC-checked, encoded twice, decoded, and parsed successfully in Chrome. The ciphertext contained 15,728,718 characters; 100 CRC, 200 encoding, and 100 decoding progress updates were observed over approximately 8.4 seconds.

## Full-view comparison

- Fonts and typography: title, labels, text areas, buttons, metadata, hints, status messages, and responsive wrapping remain consistent with the source hierarchy.
- Spacing and layout rhythm: the 800 px desktop card, 20 px outer inset, 16 px radius, shadows, and button spacing are preserved. The tab control and image cards use the same spacing scale. The text cipher retains its aligned 40 × 40 px copy action; the image workflow now uses a dedicated TXT file card with download and upload actions. At 390 px the card remains 350 px wide and document scroll width remains exactly 390 px.
- Colors and tokens: tabs, upload control, dashed boundary, image cards, success/error text, download action, and copy action reuse the existing pink palette and surface colors. Successful copying temporarily uses the existing semantic green.
- Image quality and asset fidelity: the requested 3424 × 2422 JPG now replaces the former background and remains embedded for offline use with full-screen centered `cover` cropping. Uploaded and decoded previews use intrinsic sizing with `max-width`/`max-height`, preserve aspect ratio, and avoid upscaling small images. The copy glyph is the official Google Material `content_copy` icon, embedded as a PNG data URL so offline use remains intact.
- Copy and content: the image page names all six supported formats, states the 15 MiB limit, and makes local-only processing explicit. Text copy retains its concise label and `已复制` confirmation. Image ciphertext is no longer inserted into the page or clipboard; it is exported as UTF-8 TXT and imported through a TXT file picker.

## Focused comparisons

- Desktop decoded-result evidence: `image-result-desktop.png` confirms the encoded field, action buttons, success message, restored preview, file metadata, and download action in one state.
- Mobile decoded-result evidence: `image-result-mobile.png` confirms the same core journey at 390 × 844 without horizontal clipping.
- `compare-text.png` remains historical evidence for the text controls and visual tokens before the requested background replacement; the current background was verified by exact embedded-byte hash and live Chrome rendering.
- `compare-copy-button.png` places the user's annotated 687 × 540 source beside the 689 × 540 implementation. The requested right-side placement is present, the icon remains outside the text area, and the success feedback does not cover the field label or cipher text.
- `image-copy-mobile.png` is retained as historical evidence for the superseded image-copy control. Current 390 × 844 runtime inspection confirms the TXT download/upload card has no horizontal overflow.
- `encoding-progress.png` captures the provided 1280 × 720 PNG at a genuinely intermediate 78% state: controls are disabled, the bar is partially filled, and the status text matches the bar. `encoding-complete.png` captures the same state at green 100% with the full cipher present.

## Interaction and runtime checks

- Text regression passed for empty text, ASCII, Chinese, emoji, mixed text, odd length, illegal characters, and non-fatal UTF-8 replacement behavior.
- PNG, JPEG, animated GIF, WebP, BMP, and AVIF each passed signature detection and CRC validation. Legacy payload bytes remain validated before the new final JPG conversion step.
- Versioned payload validation passed for odd length, illegal characters, wrong magic, unsupported version, truncation, CRC corruption, invalid metadata, and MIME/signature mismatch. Failures preserved the previous successful preview and download.
- A misleading `.jpg` filename containing PNG bytes was identified from its PNG signature rather than its extension.
- Repeated selection and decoding revoked prior Blob URLs; tab mouse and keyboard switching passed.
- The legacy v1 boundary regression used a 15 MiB PNG, produced 31,457,442 codebook characters, decoded back to 15,728,640 identical bytes, and passed CRC32. A 15 MiB + 1 byte input was rejected with `图片不能超过 15 MiB`.
- Final headless Chrome stress timing was approximately 1.9 seconds to encode and 28.8 seconds to decode the maximum-size payload; progress remains chunked and the limit is treated as an upper boundary rather than the normal case.
- Offline file loading passed with zero HTTP(S) references and the background still embedded as a JPEG data URL.
- Text copy starts disabled, activates after `A → 咕哦`, writes exactly `咕哦` to the clipboard, shows the copied state, and disables again if the generated cipher is manually edited.
- Image ciphertext copy has been removed. TXT download starts disabled, activates only after successful image encoding, and keeps decode disabled until a TXT file is explicitly imported.
- Text copy uses the modern Clipboard API where available and retains a selection-based offline fallback. The image TXT download and upload controls expose keyboard focus, disabled state, descriptive labels, and file metadata.
- The provided 814,296-byte PNG emitted 18 recorded progress updates from 0% through validation, encoding, final write, and 100%. Independent browser polling observed intermediate painted states before completion.
- The legacy v1 encoder produced 1,628,802 ciphertext characters for the provided PNG and restored all 814,296 original bytes exactly; this remains the backward-compatibility baseline for the v3 length comparison.
- Five consecutive encode operations on the provided PNG completed without a reload; heap readings stayed in a reclaimable 33.0–54.7 MiB range.
- Six-format PNG/JPEG/GIF/WebP/BMP/AVIF round trips and text fixtures (`A`, Chinese, emoji, mixed text) passed after the streaming change.
- At the 15 MiB boundary, two consecutive pre-fix encodes reached approximately 162.7 MiB and 316.7 MiB heap. The post-fix streaming path reached approximately 93.2 MiB and 94.2 MiB, while producing all progress values from 1% to 100%.
- Browser console warnings/errors: 0.
- The current v3 JPG pipeline passed in real Chrome with the provided 1280 × 720 PNG. Clear mode produced a 103.9 KiB JPG and 106,755 ciphertext characters; balanced produced an 81.0 KiB JPG and 83,327 characters; extreme produced a 39.2 KiB 960 × 540 JPG and 40,454 characters.
- Balanced mode reduced the provided image bytes by 89.8% and ciphertext length by approximately 94.9% compared with the legacy 1,628,802-character v1 output.
- The v3 payload contains a valid JPEG, decodes directly to a JPG preview/download, restores the `-compressed.jpg` name and compression label, and retains CRC32 validation.
- Compact v2 compatibility passed by decoding a v2 payload through the same 256-character family; the supplied 45,530-character v1 attachment also decoded to its original 22.1 KiB PNG and filename.
- A generated two-frame GIF was detected as animated and routed through the intentional first-frame JPG path; the page explains this conversion when the file is selected.
- The compression UI completed three consecutive mode changes and encodes without a reload. Observed painted progress states included 0%, 13%, 75%, 97%, 98%, and 100%, corresponding to validation/compression, CRC, character mapping, field write, and completion.
- At 390 × 844 the document and viewport widths both remained 390 px, the card remained 350 px wide, and the three compression choices collapsed to one column without horizontal overflow.
- The balanced JPG v3 result exported as `d79afbd80e767f7033fc631f1b942c7e_720-msbt-v3.txt`: 83,327 ciphertext characters and approximately 243.8 KiB of UTF-8 text, with no BOM added.
- Re-importing that TXT restored the 81.0 KiB JPG successfully. The importer strips only the leading BOM and surrounding whitespace, validates the code prefix and character limit, and keeps malformed/non-TXT files out of the decoder.
- The supplied legacy v1 PNG TXT decoded to `微信图片_20251226100358_162_4.jpg` (10.7 KiB), and a synthesized legacy v3 WebP payload decoded to `old-v3.jpg` (137.4 KiB). All current and legacy downloads began with the JPEG `FF D8 FF` signature.
- The image page contains no image-cipher copy button and no large ciphertext textarea. This avoids clipboard limits and removes the browser cost of painting tens of thousands of cipher characters.

## Findings

No actionable P0, P1, or P2 issues remain.

## Comparison history

- Pass 1: a P2 preview-quality issue was found because very small images were enlarged to the full card width.
- Fix: changed previews to intrinsic width with `max-width: 100%`, `max-height: 280px`, and centered layout.
- Pass 2: desktop and mobile captures with a 640 × 360 image confirmed correct aspect ratio, sharpness, and no overflow. The 15 MiB copy and boundary behavior were also revalidated.
- Pass 3: the requested copy controls were implemented on both cipher fields. The source annotation and implementation were compared side by side; desktop and mobile captures confirmed right-edge alignment, a clear disabled/active/success state, a 40 px target, and zero horizontal overflow. Clipboard equality and console checks passed with no P0–P2 findings.
- Pass 4: user-reported P1 intermittent renderer crashes and P2 fake progress were reproduced. The old 1 MiB chunk made the provided 814,296-byte image report only 100%, and repeated 15 MiB encoding doubled live heap to about 317 MiB. The encoder now clears stale output before work, computes CRC in painted 128 KiB chunks, writes the versioned payload from separate prefix/image segments without a full payload copy, and uses bounded UTF-16 buffers instead of million-entry string arrays. Post-fix captures show 78% and 100% states, repeated encoding remains stable, and no P0–P2 finding remains.
- Pass 5: image output originally moved to a v3 lossy WebP pipeline with clear, balanced, and extreme presets, up to five adaptive quality/size passes, a 256-character one-byte codebook, compact v2 and legacy v1 decode compatibility, and a 40-megapixel decode guard. This historical WebP output was superseded in Pass 7.
- Pass 6: removed the image ciphertext textarea and image-copy action. Encoding now creates an offline UTF-8 TXT Blob and activates only the download action; decoding requires a selected TXT file. Real Chrome completed encode → TXT download → BOM/CRLF-tolerant TXT import → image decode, then repeated the import path with the supplied legacy v1 ciphertext. Mobile width remained exact and console errors remained zero.
- Pass 7: replaced the embedded background byte-for-byte with the user-supplied 3424 × 2422 JPG. New image payloads now use adaptive JPEG compression, white-fill transparency, and first-frame animation conversion. TXT decoding always exposes a `.jpg` preview/download; real Chrome verified direct v3 JPEG, legacy v1 PNG, and legacy v3 WebP inputs with valid JPEG signatures and zero console errors.

## Follow-up polish

- P3: JPG improves QQ album compatibility but can produce a larger ciphertext than WebP for the same visual quality. Transparent images are composited onto white, and animated inputs intentionally export only their first frame because JPG cannot preserve transparency or animation.

final result: passed

## Independent shelf directory verification

- Date: 2026-08-10. The shelf can now connect a user-selected ordinary directory. Each book is stored under `books/<book-id>/` with `archive.ecomic`, `long.png`, `cover.jpg`, and `metadata.json`; the saved browser handle is only a reconnection convenience.
- A Chrome HTTP run encrypted one 1.29 MiB JPEG and wrote a 1,354,902-byte archive, 8,396,908-byte PNG, 21,518-byte cover, and valid metadata. After deleting only the browser cache, the directory-backed card remained visible and opened a one-page authenticated reader directly from `archive.ecomic`.
- Direct `file:///D:/DevFiles/Ecryptees/index.html` retained the local comic-ready state and connected/scanned the directory path without requiring a server. Unsupported directory-picker browsers keep the existing browser shelf/download fallback.
- At 390 × 844, viewport and document widths both remained 390 px, the main card was 350 px, and the directory panel was 320 px. The shelf controls remained usable with no horizontal overflow. Evidence: `C:\Users\user\AppData\Local\Temp\ecryptees-directory-mobile.png`.
- Both HTTP and direct-file runs reported zero console errors. Automated tests passed 19/19, all JavaScript syntax checks passed, and `git diff --check` passed.
- The headless run replaced only the operating-system directory chooser with an in-memory File System Access implementation that eagerly copied bytes. A final manual click through the native Chrome/Edge directory dialog remains advisable before distribution; Firefox/Safari directory-picker support continues to use the documented fallback.

**Findings**

No actionable P0, P1, or P2 issue remains in the tested flows. Rapid shelf refresh now delays retirement of stale cover Blob URLs, preventing newly rendered covers from losing their source while the browser is still scheduling image loads.

final result: passed with native-picker coverage gap

## Decode-to-shelf and stable mobile reading verification

- Date: 2026-08-10. Opening an `.ecomic` now starts PNG generation and shelf persistence automatically after archive authentication; the modal reader opens immediately while conversion continues. The completed PNG remains available through the download control and an automatic download is attempted.
- A one-page browser fixture completed archive creation, re-import, authenticated opening, automatic 3424 × 2422 PNG generation, and shelf commit without pressing the reader export button. The PNG was 8.01 MiB, the reader stayed open, and both success messages were visible.
- Reader pages are no longer removed by the application when they leave the prefetch window or when the page visibility changes. At 390 × 844, a loaded page retained the same Blob URL, `complete=true`, and one live image before and after a simulated hide/show cycle. Blob URLs are still revoked when the reader session closes.
- Shelf cards now expose a 44 × 44 px pencil button in the upper-right title row. Renaming `comic` to `移动端新标题` persisted through the worker-backed history store and immediately updated the card. The document width remained exactly 390 px with no horizontal overflow.
- Automated browser console errors: 0. Evidence: `C:\Users\user\AppData\Local\Temp\ecryptees-history-rename-mobile.png`.
- `node --test tests/*.test.js` passed 19 tests; JavaScript syntax checks and `git diff --check` also passed.

**Findings**

No actionable P0, P1, or P2 issues remain. The browser may still discard decoded pixel caches under severe device memory pressure, but the application no longer replaces loaded pages or re-requests their source bytes during an open reading session.

final result: passed

## Android PWA/WebAPK readiness verification

- Date: 2026-08-10. Android delivery now targets an installable HTTPS PWA/WebAPK; the former `content://` single-file compatibility package is intentionally not part of the release.
- The web app manifest passed Chrome's manifest parser with zero errors. It supplies standalone display, theme/background colors, relative scope/start URL, and 192 px/512 px maskable PNG icons.
- The install action remains hidden until `beforeinstallprompt` confirms browser eligibility. Installed standalone sessions do not show the action again.
- The root Service Worker precaches only the application shell: HTML, manifest, styles, background, icons, and seven runtime scripts. It never caches `.ecomic`, generated PNG, Blob URLs, or shelf files.
- Chrome at a 390 × 844 Android viewport registered and controlled the page, loaded all four panels, completed text encoding, and rendered the intended responsive styling.
- With network access disabled and the HTTP cache bypassed, a hard reload still restored the page title, external styling, legacy core, comic core, and PWA controller. Evidence: `C:\Users\user\AppData\Local\Temp\ecryptees-webapk-offline.png`.
- `node --test tests/*.test.js`, JavaScript syntax checks, and `git diff --check` passed. HTTPS deployment remains required before Android browsers can mint the installed WebAPK.

**Findings**

No actionable P0, P1, or P2 issues remain. WebAPK creation is performed by the Android browser after visiting the HTTPS deployment; this repository deliberately does not produce or maintain a sideloaded APK.

final result: passed

## Local comic shelf and history reader verification

- Date: 2026-08-10. A fourth `书架` tab now stores decrypted original pages, a generated cover, PNG metadata, and reading progress in browser-local IndexedDB/OPFS. The interface explicitly warns that shelf pages are plaintext, origin/device-bound browser data.
- `node --test tests/*.test.js` passed 18 tests. New coverage checks deterministic history IDs, frozen record validation, progress bounds, exact 80-page acceptance, 81-page rejection, the 500 MiB boundary, staging markers, history commands, and ordered external scripts. All legacy text/image and `.ecomic` v1 tests remain passing.
- Direct `file:///D:/DevFiles/Ecryptees/index.html` completed archive opening, automatic PNG generation/download attempt, shelf commit, page reload, search/card rendering, continued reading without the source `.ecomic`, progress restoration, duplicate conversion, and manual deletion controls through the IndexedDB fallback.
- `http://127.0.0.1:8765/` completed the same conversion and shelf flow through the native Worker/OPFS path. The completion message remained visible after the asynchronous shelf refresh, and “重新生成并下载 PNG” produced a new 3424 × 3142 PNG.
- Stored page verification reconstructed the persistent IndexedDB chunks. `comic-page.png` was 814,296 bytes with SHA-256 `0f414e40ab418fcc48ca3b47cf6dcf5f64aed2ba349c0b30113eab5be97342b1`; `background.jpg` was 1,354,600 bytes with SHA-256 `742807f8331c790cc92e679ff270202a614b733fb14ceef9d5922d3eb6977505`. Both match their original archive pages byte-for-byte.
- Reading progress saved at a 500 ms debounce, survived reload, restored the reader scroll offset, and remained at 40% after converting the same archive again. Closing the reader now flushes progress before the dialog can reset its scroll state.
- Reader images replace placeholders only after `image.decode()` resolves. A 96 MiB mobile or 256 MiB desktop decoded-pixel budget prioritizes the current page, two prior pages, and three following pages; remaining decoded pages are retained/evicted by recent use. Returning from a hidden page rebuilds Blob URLs.
- At 390 × 844, document width stayed exactly 390 px, the main card was 350 px, all four tabs fit, the shelf became a single horizontal card, and the modal remained free of horizontal overflow. Desktop 1440 × 900 used the two-column shelf grid. Evidence: `C:\Users\user\AppData\Local\Temp\ecryptees-history-mobile.png`, `ecryptees-history-reader-mobile.png`, and `ecryptees-history-desktop.png`.
- Both tested paths reported zero console warnings/errors. Automated Worker termination, quota-exhaustion prompts, a real 80-page/near-500 MiB shelf commit, Firefox, and Safari remain manual coverage gaps in this Windows environment.

**Findings**

No actionable P0, P1, or P2 issue remains in the tested Chrome paths.

final result: passed with documented coverage gaps

## Comic mode implementation verification

- On 2026-08-10, a third `漫画` tab was added with the `.ecomic` v1 archive format, 4 MiB AES-256-GCM chunks, encrypted metadata, page ordering, continuous reading, and byte-preserving ZIP export. Existing text and image v1/v2/v3 tests remained unchanged and passing.
- `node --test tests/core.test.js tests/comic-core.test.js` passed 13 tests. Coverage includes deterministic built-in-codebook key identification, unique nonces, page-aligned chunk planning, exact 500 MiB and 80-page boundaries, multi-page byte round trips, damaged headers, authentication failures, truncation, appended bytes, and external script order.
- Direct `file:///D:/DevFiles/Ecryptees/index.html` completed image selection, archive creation, `.ecomic` download/import, authenticated opening, continuous rendering, and ZIP export. This path used the IndexedDB-backed local task runner because browsers block local Worker scripts and OPFS access can fail for opaque file origins.
- `http://127.0.0.1:8765/` completed the same two-page flow through the native Worker/OPFS path. Manual down-ordering changed `background.jpg, comic-page.png` to `comic-page.png, background.jpg`, and the decrypted reader retained that order.
- ZIP verification read both entries without extraction. `comic-page.png` (814,296 bytes) and `background.jpg` (1,354,600 bytes) matched their source SHA-256 hashes exactly.
- A real 500 MiB JPEG input completed direct-file encryption in Chrome in approximately 17 seconds. The `.ecomic` Blob was 524,290,292 bytes (2,292 bytes of format/authentication overhead), progress reached 100%, and observed JS heap stayed at the same coarse 10 MB reading before and after. A 500 MiB + 1 byte input was rejected before processing.
- Chrome and Edge both opened the two-page direct-file archive with two rendered reader images and zero console errors. Edge at 390 × 844 reported zero horizontal overflow.
- Responsive evidence: `C:\Users\user\AppData\Local\Temp\ecryptees-comic-mobile.png`, `ecryptees-comic-tablet.png`, and `ecryptees-comic-desktop.png`. At 390 px, document width remained 390 px and the card remained 350 px wide.
- Firefox and Safari were not available in the Windows test environment. Their final manual acceptance remains required; the fallback uses broadly available Web Crypto, IndexedDB, Blob, and File APIs rather than Chromium-only file pickers.

## Comic reader modal verification

- Date: 2026-08-10.
- Source visual truth: `C:\Users\user\AppData\Local\Temp\codex-clipboard-94120af8-0f5d-40f1-b0a1-a9458f86f506.png` (2048 × 1196 px). It documents the unwanted state where 68 reading pages extend the main card.
- Desktop implementation: `C:\Users\user\AppData\Local\Temp\ecryptees-reader-modal-reference-size.png` (2048 × 1196 px at a 2048 × 1196 CSS viewport, device scale 1).
- Mobile implementation: `C:\Users\user\AppData\Local\Temp\ecryptees-reader-modal-mobile-final.png` (390 × 844 px at a 390 × 844 CSS viewport, device scale 1).
- Combined comparison: `C:\Users\user\AppData\Local\Temp\ecryptees-reader-modal-comparison.png`. The full-view comparison confirms the intentional structural change: the main card no longer owns the page stack, while the modal keeps the existing pink controls and centers original images on a neutral reading surface. A separate focused crop was unnecessary because the 2048 px comparison keeps header copy, button hierarchy, spacing, and image edges readable.
- Fidelity surfaces: typography continues to use the existing application family and weights; the header preserves the established pink palette, rounded controls, and shadows; spacing uses the existing 12–20 px rhythm; source image bytes and crops are unchanged; copy clearly explains long-press downloading and the close action.
- Interaction evidence: direct `file://` opening produced a two-page modal with two decoded images. Escape closed it, removed the body scroll lock, and left a compact 856 px main card. “继续阅读” reopened the same session without re-decryption. A synthetic 650 ms pointer hold invoked exactly one download and displayed `已开始下载第 1 页原图`; focusing a page and pressing Enter produced the same result. ZIP export remained available inside the modal and generated `two-pages-originals.zip`.
- Responsive evidence: the first 390 px pass reserved a 15 px scrollbar gutter (P2). The mobile rule now removes that gutter and hides only the modal scrollbar; the final reader width equals the 390 px viewport, horizontal overflow is zero, and vertical touch scrolling remains enabled through `touch-action: pan-y pinch-zoom`.
- Console errors: none in the desktop, mobile, close/reopen, long-press, keyboard-download, or ZIP-export flows.

**Findings**

No actionable P0, P1, or P2 issues remain. Firefox and Safari remain the existing manual-browser coverage gap.

final result: passed

## Comic page-limit revision

- Date: 2026-08-10. The comic import limit is now exactly 80 images while the combined input-size limit remains 500 MiB.
- The shared format constant, selection-time validation, manifest validation, visible guidance, and regression tests all use the same 80-page boundary.
- Automated coverage accepts exactly 80 entries and rejects the 81st entry.

final result: passed

## Whole-comic long-image export verification

- Date: 2026-08-10. This pass supersedes the modal-reader note that long-press downloaded one page and ZIP remained the primary whole-book export.
- The reader now generates one `.svg` image containing every page in reading order on a single vertical canvas. Original image data is embedded byte-for-byte; pages are not recompressed or passed through Canvas.
- SVG is used because a 68-page comic can exceed mobile PNG/JPEG Canvas height and memory limits. The streaming writer keeps memory bounded while allowing a very tall lossless image; the resulting file remains a standard image that opens directly in modern browsers.
- Direct `file:///D:/DevFiles/Ecryptees/index.html` testing generated `two-pages-long.svg` from a PNG and JPEG. Chrome loaded it as one image measuring 3424 × 4348 with two vertically placed page elements.
- The embedded PNG hash was `0F414E40AB418FCC48CA3B47CF6DCF5F64AED2BA349C0B30113EAB5BE97342B1`; the embedded JPEG hash was `742807F8331C790CC92E679FF270202A614B733FB14CEEF9D5922D3EB6977505`. Both exactly matched the source files.
- A synthetic 650 ms pointer hold clicked only `downloadComicLongImage` and reported `已开始下载整本单文件长图`. The former ZIP controls are absent from the reader.
- At 390 px viewport width, the modal retained zero horizontal overflow and displayed the generate, whole-image download, and close actions without clipping. Browser console errors: 0.
- Some phone gallery applications do not index SVG files; the generated long image remains viewable and downloadable through the browser without quality loss.

**Findings**

No actionable P0, P1, or P2 issues remain. Native gallery compatibility is an SVG platform limitation, not a data-loss issue.

final result: passed

## Streaming PNG long-image export verification

- Date: 2026-08-10. This pass supersedes the SVG long-image exporter; SVG remains historical QA evidence only.
- The reader now produces one gallery-friendly RGBA PNG. Pages retain their decoded pixel dimensions and reading order; narrower pages are centered with transparent side padding instead of being scaled to a common width. Animated inputs intentionally contribute their first frame.
- PNG creation does not allocate a whole-book Canvas. Each page is decrypted to temporary storage, decoded individually, read through a 16-row OffscreenCanvas strip, filtered, compressed through a streaming zlib pipeline, and written as bounded IDAT chunks.
- Direct `file:///D:/DevFiles/Ecryptees/index.html` generated `two-pages-long.png` through the IndexedDB fallback. The file was 9,325,446 bytes with the valid PNG signature `89 50 4E 47 0D 0A 1A 0A` and IHDR dimensions 3424 × 3142.
- Pixel verification compared each decoded source page with its exact rectangle in the combined PNG. Page 1 (1280 × 720, centered at x=1072) and page 2 (3424 × 2422, y=720) produced matching SHA-256 pixel hashes; no page was resized or recompressed lossily.
- `http://127.0.0.1:8765/` generated the same 3424 × 3142 PNG through the native Worker/OPFS path. Both paths completed with zero console errors.
- At a 390 × 844 viewport, the reader dialog and document both remained exactly 390 px wide with no horizontal overflow. Evidence: `C:\Users\user\AppData\Local\Temp\ecryptees-png-long-image-mobile.png`.
- The input contract remains at most 80 images and 500 MiB combined source bytes. PNG output size is not capped at 500 MiB; generation still requires enough browser storage for the actual output and one temporary decoded source file.

**Findings**

No actionable P0, P1, or P2 issues remain. Extremely large decoded pixel counts can still exceed a device's image decoder, storage quota, or gallery display limit even when the encrypted input is within 500 MiB.

final result: passed

## Encrypt-to-shelf verification

- Date: 2026-08-10. “封装并加密” is now “加密并加入书架”. One task produces the `.ecomic`, then reuses the selected source files to generate the PNG, cover, and persistent shelf pages without decrypting the newly created archive.
- The `.ecomic` download becomes available as soon as encryption finishes. PNG and shelf work continue through the second half of the same monotonic progress range; a later shelf failure does not remove the completed archive download.
- Real Chrome testing passed through both `http://127.0.0.1:8765/` (Worker/OPFS) and direct `file:///D:/DevFiles/Ecryptees/index.html` (local runner/IndexedDB). Each path encrypted a 48 × 48 PNG, exposed the archive and PNG downloads, committed the requested title to the shelf, reached 100%, and did not open the reader unexpectedly.
- Both paths generated a valid 362-byte 48 × 48 PNG and reported zero console errors. `node --test tests/*.test.js`, all JavaScript syntax checks, and `git diff --check` passed.

**Findings**

No actionable P0, P1, or P2 issues remain. Saving a book requires space for the encrypted archive, original shelf pages, and generated PNG; if shelf storage is exhausted, the already completed `.ecomic` remains downloadable.

final result: passed

## Offline Android APK verification

- Date: 2026-08-10. The Android wrapper embeds the split web project and loads it from `https://appassets.androidplatform.net/assets/index.html`; no public host or runtime network connection is required.
- The manifest targets Android 16/API 36 with a minimum of Android 8.0/API 26. It declares no `INTERNET` or broad storage permission, disables application backup, and uses Storage Access Framework destinations selected by the user.
- File inputs are handled by Android's system chooser. Blob downloads are intercepted in `js/android-bridge.js`, read as a stream, converted one browser chunk at a time, and written by the native bridge. No whole-file `arrayBuffer()`, Blob-to-Base64 conversion, or native byte accumulation is used.
- A browser bridge smoke test streamed 8,388,731 deterministic bytes across five calls. The received byte count and 32-bit checksum matched exactly, the completion state rendered at 390 × 844, and no runtime exception was reported. Evidence: `D:\Android\temp\ecryptees-android-bridge-smoke.png`.
- Gradle `assembleRelease` and `lintRelease` passed. `apksigner` verified APK Signature Scheme v2 with the dedicated 4096-bit release certificate (`CN=Ecryptees`); `aapt2` confirmed package `com.ecryptees.offline`, version 1.0.0, minSdk 26, targetSdk 36, and no Internet permission.
- The 3.23 MiB release APK contains `index.html`, CSS, background, all eight ordered scripts, Worker, manifest, and Service Worker. SHA-256: `97A87958E839FAB1246DB374A84006FDB27FD897E18BE091DDE32AE9AD90DC90`.

**Findings**

No actionable build, lint, packaging, signing, or chunk-transfer issue remains. No Android device was connected, so installation, system picker behavior, WebView OPFS availability, and a real 500 MiB phone stress run remain device-level acceptance items.

final result: passed with device coverage gap

## Mobile comic import UI verification

- Date: 2026-08-10. The 390 x 844 layout now uses a compact import area, places the archive title before the page list, and lets the document scroll naturally instead of trapping the list in a short inner scroller.
- Long filenames are limited to two lines with ellipsis. Reorder and delete controls retain at least 44 px touch targets, and encryption/clear actions stay in a single bottom action row after files are selected.
- Four synthetic pages were injected through the real file-input flow in headless Edge. The page remained 390 px wide with no horizontal clipping; cards, thumbnails, metadata, title field, and bottom actions remained usable.
- Evidence: `D:\Temp\Ecryptees-QA-20260810\comic-mobile-2.png`.

**Findings**

No actionable P0, P1, or P2 mobile layout issue remains.

final result: passed

## Android HEIC and HEIF verification

- Date: 2026-08-10. Android image and comic inputs now accept `.heic` and `.heif`. The native bridge decodes these formats for previews, compression, shelf covers, continuous reading, and whole-comic PNG generation.
- Comic archives continue to preserve each imported HEIC/HEIF file byte-for-byte. The derived PNG is used only where a browser-displayable bitmap is required; it does not replace the encrypted source page.
- Native transfers use 768 KiB chunks rather than one whole-file Base64 value. Decoding is limited to 40 million pixels and reports unsupported/corrupt files, allocation failures, and incomplete transfers explicitly.
- A real Nokia HEIF sample (`crowd.heic`, 130,358 bytes) was recognized as HEIC by the project signature detector and decoded to a valid 1,728,110-byte PNG by an independent HEIF decoder. Automated tests passed 25/25, including AVIF/HEIC/HEIF brand ordering, MIME preservation, accepted picker types, bridge wiring, and packaged script order.
- Gradle `assembleRelease` and `lintRelease` passed. `apksigner` verified APK Signature Scheme v2; `aapt2` confirmed package `com.ecryptees.offline`, version 1.0.3 (code 4), minSdk 26, and targetSdk 36. Release SHA-256: `05AB5B9B4F6DF930EAD606AAD8DAABBFC03347B5F0E2EFA70DC4328DD13978C0`.

**Findings**

No Android device was connected, so system-picker selection and native HEIC decoding still require a final physical-device smoke test. Build, packaging, signature detection, Java bridge wiring, and real-file format validation passed.

final result: passed with device coverage gap

## Internal long-image storage and explicit export verification

- Date: 2026-08-10. Automatic comic processing now writes the generated PNG to persistent shelf application data. It does not create a browser or Android download; the `.ecomic` archive remains the only immediately available archive download.
- The history record stores a validated `png.entryName` that points to a non-temporary OPFS/IndexedDB entry. Replacing or deleting a book also removes its former long-image entry.
- The reader header now contains only the reading description and `关闭阅读`; generation and download controls, long-press download handling, and hidden long-image anchors were removed.
- A real HTTP Edge run imported `assets/icon-192.png`, encrypted one page, and completed shelf persistence with zero files in the download directory. The stored PNG entry was 2,217 bytes and remained addressable from OPFS by its history key.
- The same run switched to the shelf and clicked `导出长图`. Exactly one `internal-long-qa-long.png` file was downloaded. This is now the sole long-image download path in both the web application and APK wrapper.
- Automated JavaScript tests passed 25/25. APK release 1.0.4 (code 5) is built from the same web assets, passed Gradle build/lint and APK Signature Scheme v2 verification, and has SHA-256 `6C8076626978529AE4E668630A7711EC39E95885A6F522755F3DE937848DFD6E`.

**Findings**

Existing shelf records created before persistent PNG keys were introduced remain readable but do not show the export action until re-imported. No automatic long-image download path remains.

final result: passed

## Immersive reader and bounded parallel pipeline verification

- Date: 2026-08-10. The reader header now defaults to collapsed at a 390 × 844 mobile viewport and expanded at 1280 × 800. Manual state persisted across reloads; rotation-sized metric changes did not overwrite it.
- The collapsed header measured 0 px high with no horizontal overflow. Both floating controls retained 44 × 44 px hit areas with 32 px visual pills. A real stored portrait page remained decoded after the viewport changed, and the page/within-page position ratio was identical before and after collapse (difference 0).
- Evidence: `D:\Android\temp\ecryptees-cdp\reader-mobile-collapsed.png`, `reader-mobile-expanded.png`, `reader-desktop-expanded.png`, and `reader-mobile-real-page.png`.
- HTTP Chrome testing encrypted a real image, wrote the original page and long PNG directly to generation-specific shelf entries, opened it from the shelf, and rendered it in the reader with zero console errors. Direct `file:///D:/DevFiles/Ecryptees/index.html` also encrypted the image through the compatible local pipeline, exposed the `.ecomic`, and committed one shelf book with an 864 × 1920 PNG without automatically downloading that PNG.
- AES input buffers are transferred rather than copied. A real 96 MiB archive benchmark measured 2,157 ms at one lane, 2,176 ms at two lanes, and 1,584 ms at four lanes: four lanes were 26.6% faster, while no tested mode exceeded the single-lane time by 10%.
- Node tests passed 26/26, including byte-exact archive round trips at parallelism 1, 2, and 4 with deliberately out-of-order chunk completion. JavaScript syntax checks and `git diff --check` passed.
- Android HEIC/HEIF conversion now uses a two-thread token task table. Full-size work is serialized by a decode slot; input, polling, output reads, cancellation, release, and application shutdown all address one token. Gradle release build and lint passed.
- `apksigner` verified APK Signature Scheme v2. `aapt2` confirmed `com.ecryptees.offline`, version 1.0.5 (code 6), minSdk 26, and targetSdk 36. Final APK: `dist/Ecryptees.apk`; SHA-256 `84B3D06E6F09CB1F58BFC28099B93FFA812233300C068AF045458048B7F4A7A4`.

**Findings**

No actionable browser, archive-ordering, storage-commit, build, lint, or signing issue remains. A physical Android device was not connected, so simultaneous native HEIC decoding, cancellation during native decode, and a real near-500 MiB phone memory run remain device-level acceptance items.

final result: passed with device coverage gap
