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

## 2026-08-18 漫画多选导出、底部抽屉与页面编辑 UI

### Evidence

- Visual truth — multi-select: `C:\Users\user\.codex\generated_images\01a0120e-1c58-7802-94d2-db40c82e2342\exec-f730a45b-5e05-4069-bde5-522461bc259b.png`
- Visual truth — page editor: `C:\Users\user\.codex\generated_images\01a0120e-1c58-7802-94d2-db40c82e2342\exec-9569292f-b816-4f0a-b43e-c5636dbc08b1.png`
- Visual truth — video three-dot sheet: `C:\Users\user\AppData\Local\Temp\ecryptees-ui-reference\video-three-dot-menu.png`
- Edge implementation captures: `C:\Users\user\AppData\Local\Temp\ecryptees-ui-qa\comic-shelf.png`, `comic-selection.png`, `comic-action-sheet.png`, `comic-editor.png`, `comic-editor-confirm.png`, `comic-zip-import.png`, and `comic-shelf-desktop.png`
- Same-canvas comparisons: `C:\Users\user\AppData\Local\Temp\ecryptees-ui-qa\compare-selection.png`, `compare-editor.png`, and `compare-action-sheet.png`. Each comparison places the source on the left and the implementation on the right; mobile inputs were normalized to the same 390 × 844 canvas without changing their aspect ratio.
- Primary mobile viewport: 390 × 844 CSS/PNG px, device scale factor 1. Desktop resilience viewport: 1024 × 768 CSS/PNG px, device scale factor 1.

### Full-view comparison

- Typography: the implementation retains the product's system-font hierarchy and compact metadata treatment. Selection count, sheet actions, editor headings, summaries, and danger text match the visual references' relative emphasis.
- Spacing and geometry: mobile selection becomes a dedicated management view with a compact top bar, edge-to-edge cover rows, and a fixed export action. The editor keeps the reference's dense URL panel, page list, and fixed save area while retaining 44–48 px touch targets. The action sheet follows the video's rounded top corners, grab handle, stacked rows, separators, and isolated danger region.
- Colors: the existing Ecryptees rose accent, pale pink selection surface, neutral sheets, muted metadata, and semantic red danger treatment are reused consistently.
- Imagery and icons: QA uses the real bundled background asset as actual persisted comic covers; no placeholder boxes or fabricated assets are introduced. Existing product glyphs and controls are reused for offline compatibility.
- Copy and content: visible text is the approved UI-preview language. ZIP and editor actions explicitly state that real parsing, downloading, and storage commits are deferred, so the UI does not imply completed data operations.

### Focused state and interaction checks

- A 450 ms pointer hold enters selection with the pressed comic selected. The implementation cancels the timer when pointer movement exceeds 10 px. Ordinary clicks toggle selection while the mode is active.
- `全选当前结果`, selection count updates, exit-selection, the fixed `导出 N 本为 ZIP` preview action, and filtered-visible selection semantics are wired.
- The three-dot control opens the video-style bottom sheet. Rename, group, edit, two existing export entries, and the separate delete danger area are reachable; downward drag closes the sheet.
- The page editor opens with real page rows, URL input, preview action, staged delete/undo, all-pages deletion prevention, close-without-commit behavior, and a second save confirmation showing added/deleted counts. Confirming remains UI-only and performs no shelf write.
- The archive picker accepts `.ecomic` and `.zip`; selecting a ZIP opens a batch progress/result preview without parsing the file or modifying storage.
- Edge reported zero console exceptions/errors. Mobile document and viewport widths both remained 390 px; desktop content width remained within the 1024 px viewport. No horizontal clipping was observed in the six mobile states or the desktop shelf.

### Iteration history and remaining differences

- Pass 1 P1: selection mode still exposed the ordinary directory, sort, filter, and search controls. Fixed by switching to the dedicated selection-management surface shown by the reference.
- Pass 1 P2: the editor's URL panel and page rows were too tall. Fixed by tightening internal spacing and row density while preserving accessible touch targets.
- Pass 2: no actionable P0, P1, or P2 visual or interaction mismatch remained. P3-only differences are intentional dynamic content: QA has four real local books instead of the reference's illustrative count, and controls are slightly taller where needed for mobile touch accessibility.
- This is intentionally the UI-only milestone. Worker messages, ZIP encoding/validation, archive import, atomic generation commits, Android ZIP intent handling, and real export/storage operations are not implemented in this pass.

final result: passed

## APK 1.1.5 Android shelf durability and remote-capture hardening

- Date: 2026-08-18. The Android shelf investigation found two application-controlled ways for comic pages to appear missing. First, cold-start cleanup and a simultaneous shelf save could race while the new generation had page files but no committed metadata yet; the old cleanup treated those files as unreferenced. Second, records already identify their `opfs` or `indexeddb` backend, but page reads, exports, deletes, and cleanup previously reopened only the currently preferred backend. A WebView/OS capability change could therefore make intact files in the other backend look absent.
- Shelf mutations are now serialized. Startup waits for cleanup to finish before listing, reopening, or accepting a deferred external archive. New generations remain protected by a seven-day orphan grace period, and the prior generation is removed only after the replacement record commits. Metadata progress, rename, open, delete, save, and aggressive cleanup no longer overwrite one another through stale reads.
- Every page operation follows the record's `storageKind`. Cleanup scans both available backends and maintains a separate reference set for each. IndexedDB presence checks also verify that every declared chunk exists. A malformed record is isolated and reported instead of aborting the complete shelf listing; while any malformed record exists, orphan-history deletion is skipped so potentially recoverable source pages are retained.
- Books with missing original pages stay visible, are labeled `原页缺失`, and keep their delete action. Reading and export are disabled with a re-import instruction. Re-importing the same authenticated `.ecomic` replaces malformed metadata and commits a fresh generation.
- Data can still disappear outside the application's control after uninstall, Android “clear data”, or destructive origin-data eviction by the OS/WebView. Cache cleanup and an in-place APK update remain non-destructive. The internal shelf still does not persist `.ecomic` archives, so an external archive remains the only independent recovery copy.
- The Android rendered-page bridge now rejects Base64 text above the encoded 1 MiB chunk ceiling before decoding, rechecks decoded byte length and the declared remaining image size, bounds untrusted names/MIME/error strings, and closes partial files immediately on failure. URL trust behavior is unchanged: user-supplied HTTPS destinations are still accepted, including environments affected by Clash fake-IP handling.
- Remote capture uses the AndroidX WebKit `ecryptees-capture` profile when multi-profile support is available. Profile cookies and browsing data are cleared before and after a capture. Older providers use visited-site cleanup without globally deleting the main application's cookies or storage. A following capture cannot start until final cleanup completes.
- Node regressions passed 62/62; `node --check` passed for the changed scripts; `git diff --check` passed. Rust formatting, strict Clippy, and locked tests passed 10/10, with no Windows/Tauri source changes. Gradle `clean assembleRelease lintRelease` passed, and the build script verified the configured release certificate.
- Final APK: `dist/Ecryptees-v1.1.5.apk`, 3,526,481 bytes; SHA-256 `386D99589CB8AD85065B61BAAB826FCCF907BC0C864DD9DE96CE1F4C41C1D13E`. `dist/Ecryptees.apk` is byte-identical.

**Findings**

No actionable P1/P2 bridge bound, remote-profile isolation, shelf backend routing, cleanup ordering, build, lint, or signing issue remains in the automated review. No physical Android device or emulator is connected, so an in-place upgrade with a pre-existing OPFS/IndexedDB shelf, forced WebView provider change, Clash-enabled dynamic capture, and post-capture cookie inspection remain device-level acceptance items.

final result: passed with device coverage gap

## APK 1.1.4 asset remove-group control verification

- Date: 2026-08-17. Image, comic, and video asset cards now place a folder-minus icon immediately beside the three-dot menu. The current group name appears to the icon's left and is limited to the first three characters; ungrouped assets show `未分组` with the icon disabled.
- Activating the icon deletes only that asset's lightweight group membership. Original image bytes, comic shelf pages and archives, video files, metadata, and group definitions are unchanged.
- Node regressions passed 58/58, including direct remove-group coverage for all three asset types. JavaScript syntax checks and `git diff --check` passed.
- Gradle `clean assembleRelease lintRelease` passed. Output metadata confirmed `com.ecryptees.offline`, version 1.1.4 (code 21). The release signing certificate SHA-256 remained `91306e7c15932646a58ffbd3443f541be57401f1f64106d8dcd0e97fbc5687e8`.
- The packaged APK assets were inspected directly and contain the new controls in the comic, image, and video controllers plus the shared styling. `dist/Ecryptees-v1.1.4.apk` and `dist/Ecryptees.apk` are byte-identical, 3,518,955 bytes, with SHA-256 `FA473A506DE87467B9E09178417C4CD245BD7FF7E3D88DB5428E25B86B0CBD18`.

**Findings**

No actionable format, storage, static integration, build, lint, signing, versioning, or packaging issue remains. No physical Android device was connected, so final touch-target feel and OEM WebView rendering remain device-level acceptance coverage.

final result: passed with device coverage gap

## APK 1.1.5 remote-fetch chunk bridge verification

- Date: 2026-08-17. Fixed Android web-import failures reporting `Error invoking readRemoteFetchChunk: Method not found`. The shared frontend now calls the Android JavaScript interface with its supported two-argument signature (`token`, requested bytes), while the Windows raw IPC path retains the third byte-offset argument.
- Added a static regression that locks the Android bridge method to two parameters and independently verifies both frontend platform branches. JavaScript syntax checks, `git diff --check`, and all 59 Node regressions passed.
- Android was upgraded to version 1.1.5 (versionCode 22) for in-place updates from 1.1.4. Gradle `clean assembleRelease lintRelease` passed; output metadata confirmed `com.ecryptees.offline`, version 1.1.5 (code 22), and the build script verified the existing release certificate SHA-256 `91306e7c15932646a58ffbd3443f541be57401f1f64106d8dcd0e97fbc5687e8`.
- The offline shell cache was advanced to `ecryptees-app-v25-android-remote-chunk-fix` so an in-place APK update cannot retain the old bridge script. Packaged `assets/js/comic-app.js` and `assets/service-worker.js` were inspected directly and contain the corrected Android/Windows call split and new cache identifier. `dist/Ecryptees-v1.1.5.apk` and `dist/Ecryptees.apk` are byte-identical, 3,521,195 bytes, with SHA-256 `7FAEC591E0FABD0C5E7CD2CC6C44085C2639A3E01D06CC9B947516C0405A5D88`.

**Remaining device acceptance boundary**

No physical Android device was connected, so covering an existing 1.1.4 installation and completing a real Hitomi remote import remain device-level acceptance items. The exact failing bridge invocation is covered by source regression and packaged-asset inspection.

final result: Android bridge fix, version upgrade, regression, Release build, lint, signing, and packaging passed

## Android/Windows 1.1.5 unified network adapter and Hitomi capture verification

- Date: 2026-08-17. The Android Hitomi regression was traced to a second JavaScript-interface arity mismatch: shared `comic-app.js` passed the Windows-only interactive-verification argument to Android `beginRenderedPageCapture(String, int)`. Android rejected the call before creating its isolated WebView, while the existing fallback suppressed that failure and displayed the page's decorative static images.
- Added `js/network-adapter.js` as the only native-network contract used by the shared comic controller. It converts Android Base64 chunks to bytes, preserves Windows raw IPC bytes, maps remote-fetch and rendered-image chunk argument order, calls Android rendered capture with two arguments, and retains the Windows verification option as a third argument. Android and Windows contract tests exercise the concrete call arrays and returned bytes.
- Hitomi gallery URLs now resolve directly to the same-origin `/reader/<galleryId>.html#<page>` entry. This strategy requires dynamic results and refuses the static fallback, so a WebView failure reports its real cause instead of returning logo, navigation, cover, or advertisement images. Dynamic page selection prefers a visible page selector, which avoids choosing Hitomi's hidden desktop selector in a mobile WebView.
- The reported live gallery still returned HTTP 200. Its static detail page contained three `<img>` elements and 21 scripts, the gallery metadata contained 41 image records, and `https://hitomi.la/reader/2970668.html#1` returned HTTP 200 with the expected page selector. The shared strategy regression resolves the reported detail URL to that reader URL and locks strict dynamic fallback behavior.
- JavaScript syntax checks, `git diff --check`, and all 62 Node regressions passed. The offline shell cache advanced to `ecryptees-app-v26-network-adapter-hitomi` so in-place upgrades cannot retain either pre-adapter script.
- Android remains versionName 1.1.5 and advances to versionCode 23 so devices already running code 22 can update in place. Gradle `clean assembleRelease lintRelease` passed; output metadata confirmed `com.ecryptees.offline`, and the release certificate SHA-256 remained `91306e7c15932646a58ffbd3443f541be57401f1f64106d8dcd0e97fbc5687e8`. `dist/Ecryptees-v1.1.5.apk` and `dist/Ecryptees.apk` are byte-identical, 3,522,869 bytes, SHA-256 `6B01500316B6D7A29B5FB8ED4732001F5CF10974B4CCA87C8806F0D740323D5C`.
- The Windows 1.1.5 Release/NSIS build passed and its prepared web bundle contains the same adapter and Hitomi strategy. `dist/windows/Ecryptees-v1.1.5-x64-setup.exe` and `dist/windows/Ecryptees-Setup.exe` are byte-identical, 219,219,571 bytes, SHA-256 `A1E26F3A8454F95FB7F1FE22E238A5B0AAC7000F2DF5DFE8295A8910B5AE5000`.

**Remaining device/site acceptance boundary**

No physical Android device was connected. The bridge contract, packaged assets, live Hitomi endpoints, page count, build, lint, signing, and packaging are verified, but completing all 41 previews through an OEM Android WebView remains device-level acceptance.

final result: unified adapter, strict Hitomi reader strategy, Android code 23 package, and synchronized Windows installer passed with device coverage gap

## Windows Tauri 1.1.5 native and dynamic web import verification

- Date: 2026-08-17. Release builds use the Windows GUI subsystem while debug builds retain the console. The final `ecryptees-desktop.exe` reports PE subsystem 2 (`Windows GUI`) and file/product version 1.1.5.
- Static HTML and comic images use the Rust desktop network bridge instead of browser `fetch`. Responses stream to token-named temporary files and return to the frontend as raw IPC chunks. The main-window CSP still has no arbitrary HTTPS `connect-src` permission.
- The bridge accepts only HTTPS without embedded credentials, rejects localhost, literal Fake-IP, real private, link-local, unspecified, documentation, and other forbidden targets, and manually revalidates every redirect. Domain names resolved by Clash into `198.18.0.0/15` are classified separately and passed to the Windows network stack as TUN/Fake-IP routes. Automatic mode uses system proxy settings for public destinations and direct TUN routing for Fake-IP; explicit system-proxy and direct/TUN modes are available in Settings. Redirects remain capped at five, active tasks at two, and HTML/image payloads at 5 MiB/500 MiB. Cancellation, release, normal window destruction, and stale-startup cleanup remove owned temporary files.
- JavaScript-dependent pages normally use a hidden, unfocused, task-specific WebView2 with an independent browser-data directory. When the static response explicitly contains `Cf-Mitigated: challenge`, the isolated view first waits hidden for automatic completion and is shown after eight seconds only if interaction is still required. Capture starts after the challenge page has navigated to requested content; close and timeout paths report explicit errors. New windows, downloads, clipboard access, autofill, password saving, DevTools, context menus, and every WebView2 permission request are disabled. A native resource-request filter uses the same public/Fake-IP/private classification for document, script, XHR/Fetch, image, CDN, and other resources.
- Static and dynamic tasks expose a bounded, redacted diagnostic trace containing request phase, resource type, hostname, DNS addresses, classification, selected transport, HTTP status, and allow/reject decision. The web-import UI keeps the trace in an expandable panel without recording URL paths, queries, cookies, authorization values, or response bodies.
- The capture capability matches only `capture-*` windows and remote HTTPS pages, disables local origins, and grants only `core:event:allow-emit`. Random task tokens scope captured source URLs and blob chunks; blob data is written in 192 KiB chunks to owned temporary files and returned to the main window through fixed-size raw IPC reads. Completion, failure, timeout, cancellation, window destruction, and startup cleanup close the isolated view and retire owned data.
- The APK comic folder creation path discards UI event objects before IndexedDB persistence. Shared group management supports create, rename, and non-destructive delete for image, comic, and video groups; deleting a group removes memberships only. During this Windows-only pass, Android remained 1.1.4 / versionCode 21 and was not rebuilt; the later Android 1.1.5 bridge fix is documented above.
- Node regressions passed 59/59. JavaScript syntax checks, Rust unit tests (10/10), `cargo fmt --check`, Clippy with warnings denied, desktop asset preparation, `git diff --check`, and the optimized Tauri/NSIS build passed.
- In the active Clash TUN/Fake-IP environment, `18comic.vip`, `zh.hentaipaw.com`, and `cdn.imagedeliveries.com` resolved to `198.18.0.0/15`. A direct/TUN HTTPS probe returned HTTP 200 and 23,711 HTML characters for the reported Hentaipaw page, and its embedded `cdn.imagedeliveries.com` image returned HTTP 200 with 315,636 bytes and the page Referer. The reported 18comic page returned Cloudflare HTTP 403 and therefore exercises the isolated challenge-WebView fallback rather than HTML parsing retries.
- The final Release EXE launched from the build path with an `Ecryptees` main window and zero TCP connections during a six-second idle startup smoke test. The final Windows installer and stable alias are byte-identical, 219,215,081 bytes, SHA-256 `B3D15E7A5C9D07452A594CDC4029BBE90266153E3108C3DC47ED0FC99ACD3446`.

**Remaining device/site acceptance boundary**

No physical Windows 10/11 install/uninstall cycle or externally hosted controlled certificate/redirect fixture was available in this workspace. The Hentaipaw HTML/CDN path was verified through the current Clash Fake-IP/TUN route; final 18comic image-count/order and interactive Cloudflare behavior still require manual UI acceptance because that site actively returned a challenge during this run. URL, redirect, resource-policy, Fake-IP classification, real-private rejection, size, token, chunk, timeout, and cleanup paths are covered by static integration and Rust tests.

final result: Windows P0/P1/P2 implementation, regression, Release build, packaging, and local startup verification passed

## Windows Tauri 1.1.4 release build verification

- Date: 2026-08-17. Rustup stable MSVC was reinstalled successfully; `rustc 1.97.1`, `cargo 1.97.1`, Visual Studio Community 2026, Windows SDK, and WebView2 151 are detected by `tauri info`.
- Added the Tauri v2 shell, strict local CSP, allowlisted desktop web bundle, current-user Simplified Chinese NSIS configuration, and bundled WebView2 offline installer configuration.
- Added separate image, comic, and video disk libraries, scoped asset URLs, persisted scopes, 4 MiB raw IPC writes, 64 MiB free-space reserve, SHA-256 verification, metadata backups, migration, historical roots, and recycle-bin deletion restricted to validated asset IDs.
- Desktop IndexedDB/OPFS is treated as rebuildable cache. An unavailable root keeps cached metadata visible as unavailable and does not promote or delete cache data. Large comic/video reads stream into a rebuildable OPFS cache rather than building one JSON or base64 payload.
- JavaScript syntax checks passed. Node regressions passed 55/55 with `--test-concurrency=1`; desktop resource preparation, Cargo formatting, Cargo metadata, and Tauri environment/config inspection passed.
- The first Cargo attempt exposed host commit-memory pressure, and the first complete build exposed two recoverable environment issues: two static WebView2 loader libraries were absent from the extracted Cargo source cache, and this Windows PowerShell session did not expose `Get-FileHash`. The loader libraries were restored byte-for-byte from Cargo's already verified `.crate` archive, and artifact hashing now uses the built-in .NET SHA-256 implementation.
- The full optimized Tauri Release and x64 NSIS bundle completed. The versioned installer and stable alias are both 218,257,906 bytes and both hash to SHA-256 `c333e87a405f6270d9b68c0c307534d49053cedbd6516f31f6a8eb9cd606c0b3`. Windows file metadata reports product/file version 1.1.4.

**Findings**

Application implementation, static regressions, Rust Release compilation, NSIS generation, artifact naming, and SHA-256 verification are complete. The build remains intentionally unsigned because no code-signing certificate is installed. Installation, uninstall preservation, SmartScreen presentation, and large-file runtime stress remain manual Windows acceptance items.

final result: passed with manual Windows installation and runtime coverage gap

## APK 1.1.3 video library and responsive player UI verification

- Date: 2026-08-17. Video cards now use only the accessible 16:9 poster as the playback target; the standalone play action was removed while EMP4 and original MP4 exports remain independent.
- The video action surface is an application-owned bottom sheet with inline rename, group creation/assignment, export actions, and a separated two-step delete confirmation. No browser prompt is used for video rename or group creation.
- The custom player retains resume position, playback rate, wake lock, 10-second seeking, orientation lock, and export behavior. Portrait and landscape layouts share one control model, with text-only title marquee and responsive overlays.
- The episode drawer reuses the existing video folder and membership stores without a schema upgrade. Browser smoke covered all/ungrouped/custom groups, current-video highlighting, missing native controls, and switching between two distinct stored MP4 assets; switching closed the drawer and replaced the active Blob URL.
- Node regressions passed 52/52, `node --check js/video-app.js` and `git diff --check` passed. The browser MP4/EMP4 round trip remained byte-exact and duplicate import still kept two distinct source assets at two records/files.
- Gradle `clean assembleRelease lintRelease` passed. The build script verified version 1.1.3 (code 20), and `apksigner` verified certificate SHA-256 `91306e7c15932646a58ffbd3443f541be57401f1f64106d8dcd0e97fbc5687e8`.
- Final APK: `dist/Ecryptees-v1.1.3.apk`, 3,505,603 bytes; SHA-256 `63A40D10648793400BBD8E2D1CC2F0BB1D3E38006A9DA787C25AB4667A8687C3`.

**Findings**

No actionable format, database, storage-isolation, browser UI, lint, signing, or packaging issue remains. No Android device or `adb` executable was available, so physical touch gestures, OEM WebView fullscreen behavior, and in-place upgrade from 1.1.2 remain device-level acceptance coverage.

final result: passed with device coverage gap

## APK 1.1.1 original MP4 assets and stable reader order verification

- Date: 2026-08-16. Video assets now commit the byte-exact original MP4 to app-private OPFS and record `storageFormat: plain-mp4`; playback and original export read that file directly. `.emp4` exists only as an authenticated import or an explicit temporary export.
- Existing encrypted video assets migrate transactionally: the restored `.mp4` and new metadata must both commit before the old `.emp4` is removed. A failure preserves the legacy archive for a later retry.
- A real Chrome run stored one 4096-byte `.mp4` with an `ftyp` prefix and no persistent `.emp4`. Worker export followed by import restored every byte exactly and retained the `ECRVID1` archive magic.
- Direct `file://` loading opened the `.emp4` decode interface and completed authentication, decryption, playback setup, and original-file export without creating a Worker. Chromium denied persistent storage for the file origin, so the UI correctly reported that the restored MP4 was transient.
- The reader drawer now uses natural title ordering for Chinese numerals, Arabic digits, and English number words. Reading, progress updates, and horizontal book switching do not affect that order. Pointer/drag reordering switches to a persisted manual order, and the reset action restores natural order.
- The reader drawer has a dedicated full-screen toggle and a horizontal gesture rail: right expands and left collapses. Browser geometry verification measured 360 px collapsed and the full 758 px dialog width expanded. Long-title scrolling moved only the title by 180 px while the book row remained fixed.
- The application Service Worker no longer contains encrypted-video sessions or a plaintext Range route; it caches only the application shell.
- Node regressions passed 48/48. JavaScript syntax checks and `git diff --check` passed.
- Gradle `clean assembleRelease lintRelease` passed. The build script verified version 1.1.1 (code 18) and release certificate SHA-256 `91306e7c15932646a58ffbd3443f541be57401f1f64106d8dcd0e97fbc5687e8`.
- Final APKs: `dist/Ecryptees-v1.1.1.apk` and `dist/Ecryptees.apk`, both 3,490,248 bytes with SHA-256 `25D6552123A54353847F1E9FD28D6F8DA9612F881C2E4648136C3A0CD4BD2144`.

## APK 1.1.2 video asset isolation, deduplication, and player verification

- The asset center now has one active controller. A browser regression switched from a populated video shelf to comics and back; stale video rendering did not overwrite the comic view, and the video count remained visible.
- A browser smoke test imported an MP4, imported the same bytes under a different name, then imported an EMP4 generated from those bytes. The video database and OPFS both retained exactly one raw MP4 with the same `sha256-tree-v1` content ID.
- Video export exposes a global, cancellable progress dialog. Worker cancellation aborts and removes the temporary EMP4, while capacity checks retain a 64 MiB reserve before imports and exports.
- Playback adds resume position, 10-second seeking, six playback speeds, fullscreen landscape, screen wake lock, and Android native fullscreen/keep-screen-on fallback.
- `node --test tests/*.test.js`, JavaScript syntax checks, `git diff --check`, browser video smoke, Gradle `clean assembleRelease lintRelease`, release signing verification, and offline shell caching passed.
- Final APKs: `dist/Ecryptees-v1.1.2.apk` and `dist/Ecryptees.apk`, both 3,498,527 bytes with SHA-256 `6E2631F3A6539D4860CE027FA16563EEEEC091BC862AEDD6619706E44D24534B`.

**Findings**

No actionable raw-storage, `.emp4` round-trip, direct-HTML compatibility, reader-order, build, lint, signing, or packaging issue remains. No physical Android device was connected, so OEM WebView codec playback, external `.emp4` handoff, touch drag ordering, and in-place upgrade migration remain device-level acceptance items.

final result: passed with device coverage gap

## APK 1.1.0 `.emp4` video assets and Range playback verification

- Date: 2026-08-16. `.emp4` v1 preserves one original MP4 byte-for-byte, using a 160-byte authenticated header, an encrypted manifest, 1 MiB AES-256-GCM chunks, and a fresh random content key per archive.
- Video deliberately has no custom-password mode. The UI contains no video password controls; the worker always uses the application key material; web and Android readers reject any nonzero key-mode value, non-HKDF KDF value, or nonzero reserved field.
- Browser playback registers an in-memory Service Worker session and maps plaintext requests to authenticated encrypted chunks. A real headless Chrome run returned `206 Partial Content` for `bytes=0-23`, reported `Content-Range: bytes 0-23/4096`, and restored the original `ftyp` bytes. No plaintext video entered the application-shell cache.
- Android accepts `.emp4` view/share handoffs, streams ciphertext into a maximum of two tokenized native sessions, and serves authenticated `video/mp4` ranges through the local `WebViewClient`. The native player bridge never writes a plaintext MP4.
- Video assets store only `.emp4` ciphertext plus metadata and folder membership. Playback, encrypted export, explicit MP4 decryption export, rename, grouping, and deletion are wired into the shared asset screen.
- Web image extraction now drops repeated normalized URLs before the candidate cap and list rendering, preserving only the first occurrence and original page order. Dynamic capture results receive the same first-occurrence filtering by source URL.
- JavaScript syntax checks passed for every script. Node regressions passed 47/47, including exact-byte round trips, header rejection, corruption detection, Range parsing, storage boundaries, Service Worker wiring, and Android static integration. `git diff --check` passed.
- Gradle `clean assembleRelease lintRelease` passed with a temporary 1 GiB Gradle heap override after the default 2 GiB daemon allocation exceeded available host memory. The build script verified release certificate SHA-256 `91306e7c15932646a58ffbd3443f541be57401f1f64106d8dcd0e97fbc5687e8`.
- Final APKs: `dist/Ecryptees-v1.1.0.apk` and `dist/Ecryptees.apk`, both 3,485,540 bytes with SHA-256 `541A806D61BABE4D09498DB9DE3251894444DB380CF19660A1D2007E28F836B7`.

**Findings**

No actionable format, password-surface, browser Range, encrypted-storage, build, lint, signing, or packaging issue remains. The browser smoke uses a deliberately minimal MP4 header to verify byte-range restoration rather than codec playback. No physical Android device was connected, so OEM WebView seeking, external `.emp4` handoff, and long-duration playback remain device-level acceptance items.

final result: passed with device coverage gap

## Compact comic archive source bar verification

- Date: 2026-08-16. The comic archive source bar now exposes exactly three concise choices: `图片`, `链接`, and `解码`. The former standalone bottom `.ecomic` decode card has been folded into the same source area.
- The bar is capped at 360 px on wider layouts and uses the full available card width on mobile. At the 390 × 844 verification viewport it measured 334 px; all three controls retained 44 px touch targets.
- Runtime switching kept the three panels mutually exclusive. `链接` displayed the webpage importer while retaining the archive creation controls; `解码` displayed only the `.ecomic` picker/open action and hid the page list, archive name, security note, and creation actions.
- The mobile viewport and document widths both remained exactly 390 px with no horizontal overflow. The comic panel contained one archive card instead of separate create and decode cards.
- Browser evidence: `C:\Users\user\.codex\visualizations\2026\08\16\01a009c7-48a2-7392-9788-0f3e3eb42e6d\comic-source-image.png`, `comic-source-link.png`, `comic-source-decode.png`, and `comic-source-desktop.png`.
- `node --test tests/*.test.js` passed 38/38; `node --check js/comic-app.js` and `git diff --check` passed.

**Findings**

No actionable P0, P1, or P2 visual, interaction, or responsive-layout issue remains.

final result: passed

## Reader adaptive control layer verification

- Date: 2026-08-16.
- Source visual truth: `C:\Users\user\.codex\generated_images\019fee16-c7fa-7480-8c37-b11feea7f636\exec-d7a26ef5-10c9-493f-80c1-d3f9a0e384a0.png` (1536 × 1024 px).
- Browser-rendered implementation evidence: `C:\Users\user\.codex\visualizations\2026\08\10\019fee16-c7fa-7480-8c37-b11feea7f636\reader-normal-492.png` and `reader-drawer-final.png` (492 × 844 px, device scale factor 1).
- Combined full-view comparison: `C:\Users\user\.codex\visualizations\2026\08\10\019fee16-c7fa-7480-8c37-b11feea7f636\reader-comparison.png` (820 × 1240 px).
- The Windows Edge headless runtime enforces a 492 px minimum CSS width. Both captures remain inside the application's mobile breakpoint; the 390 px layout is additionally protected by calculated control widths and static overflow assertions.
- State: normal continuous reading with visible controls, and the same reader with the grouped comic drawer open.

**Fidelity surfaces**

- Typography: the top bar contains only a single-line ellipsized title between 44 px menu and close targets. Old page-count, file-size, storage explanation, and “连续阅读” heading content are absent.
- Spacing and layout: the reader remains full-screen; controls overlay the content and respect safe-area insets. The bottom controller retains complete previous/next targets and the page slider. The drawer measures 360 px at the captured width and uses 82vw below that maximum.
- Colors: the implementation uses the existing Ecryptees pink, warm-white drawer surface, dark translucent control layers, and high-contrast white reading controls shown in the source.
- Image quality: the implementation continues to render stored original-page Blob URLs at intrinsic aspect ratio. Test captures use existing local assets only; no remote or replacement reader asset was introduced.
- Copy: the drawer uses `选择漫画`, `全部漫画`, `未分组`, saved folder names, and a concise `当前` marker. Book rows intentionally omit the concept image's miniature progress bars because the approved specification requires only cover, title, and current-book state.

**Focused comparison and interactions**

- The lower portion of `reader-comparison.png` provides focused normal/footer and drawer/list evidence at readable scale; no additional crop was required.
- The real HTTP application initialized `reader-core.js`, set the closed reader state, and reported `漫画模式已就绪` in Edge, confirming the changed classic-script order and DOM bindings load without a startup exception.
- Node regressions cover group filtering, recent/added/title ordering, first/last boundaries, deliberate horizontal swipe thresholds, page-index clamping, and the presence of accessible range, drawer, previous-page, and next-page controls.

**Comparison history**

- Pass 1 appeared horizontally clipped because headless Edge kept a wider CSS layout while writing a 390 px crop. This was identified as capture-tool behavior, not accepted as implementation evidence.
- Pass 2 captured the complete 492 px mobile breakpoint. It confirmed the full header, both page buttons, slider, title truncation, 360 px drawer, folder counts, covers, current state, and dimmed reader backdrop.
- The implementation pass also corrected a slider edge case where releasing an unchanged thumb could otherwise leave auto-hide suspended.

**Findings**

No actionable P0, P1, or P2 visual mismatch remains. The conceptual source contains group icons and per-book progress miniatures; their omission is intentional and follows the approved lower-clutter reader specification.

final result: passed

## APK 1.0.8 strict `.ecomic` open-association verification

- Date: 2026-08-11. Android now advertises `ACTION_VIEW` for the dedicated `application/vnd.ecryptees.ecomic` MIME type and for case-bounded `content:` URI paths ending in `.ecomic`; it does not register a broad `application/octet-stream` handler.
- `MainActivity` uses `singleTop`, accepts cold-start and `onNewIntent` documents, resolves `OpenableColumns.DISPLAY_NAME`, and rejects non-`.ecomic`, empty, inaccessible, and over-limit inputs before exposing bytes to the WebView.
- Incoming documents are read sequentially through a tokenized native stream in chunks of at most 1 MiB. The web bridge writes 768 KiB chunks to a unique OPFS `ecryptees-temp-*` entry, validates the ECRCOM1 magic, and then invokes the existing authenticated import and shelf-save flow.
- New `.ecomic` exports use `application/vnd.ecryptees.ecomic`; the archive v1 bytes and cryptographic format are unchanged. The in-app picker keeps its extension filter and no longer lists `application/octet-stream` as an accepted type.
- Temporary incoming files are released after shelf save, authentication/save failure, cancellation, replacement, or unload, with cold-start cleanup as a fallback. No storage, all-files, or Internet permission was added.
- Node regressions passed 26/26; JavaScript syntax and whitespace checks passed. Gradle Java compilation, `assembleRelease`, and `lintRelease` passed. The packaged Manifest retained the escaped `.ecomic` suffix matcher and dedicated MIME.
- `aapt2` confirmed `com.ecryptees.offline`, version 1.0.8 (code 9), minSdk 26, targetSdk 36, and no `INTERNET` or storage permission. `apksigner` verified certificate SHA-256 `91306e7c15932646a58ffbd3443f541be57401f1f64106d8dcd0e97fbc5687e8`.
- Final APK: `dist/Ecryptees.apk`, 3,403,267 bytes; SHA-256 `8540535C5D2B8F53899162E04817FC0AC975E57FF3E5F086A4A87449D9E2D972`.

**Findings**

No actionable association-filter, chunk-transfer, archive-format, permission, build, lint, or signing issue remains. No Android device was attached, so chooser visibility across OEM file providers, cold/warm `ACTION_VIEW`, and a real large-file external-open run remain physical-device acceptance items.

final result: passed with device coverage gap

## APK 1.0.6 private-shelf export and update verification

- Date: 2026-08-11. The Android shelf keeps original pages, the generated long PNG, cover, metadata, and reading progress; it does not persist a `.ecomic` archive. The new shelf export action reads the stored pages in record order and reuses the existing bounded, chunked `.ecomic` v1 encryption pipeline.
- The create flow now replaces `加密并加入书架` with `下载「漫画名」.ecomic` only after the shelf commit completes. A completed archive remains available if the later shelf write fails, and selecting or changing source images resets the action for the next job.
- Android hides directory selection, connection state, and migration controls, and explains that private shelf data survives an in-place update but not uninstall or clearing app data. Desktop browsers retain the connected-directory workflow and its `archive.ecomic` protocol.
- Cold startup removes abandoned temporary and staging entries plus unreferenced history files without deleting valid shelf records. Storage details separately report original pages, long images, covers, temporary files, and total application usage. Native download success, cancellation, and failure release only the matching temporary output.
- Headless desktop and Android-user-agent smoke runs verified the runtime-specific directory UI and private-shelf wording. Node regressions passed 26/26; JavaScript syntax checks and `git diff --check` passed.
- Gradle `assembleRelease` and `lintRelease` passed. `aapt2` confirmed `com.ecryptees.offline`, version 1.0.6 (code 7), minSdk 26, targetSdk 36, and no `INTERNET` permission. `apksigner` verified certificate SHA-256 `91306e7c15932646a58ffbd3443f541be57401f1f64106d8dcd0e97fbc5687e8`.
- Final APK: `dist/Ecryptees.apk`, 3,398,331 bytes; SHA-256 `C5E4A1112C36AB6DE5187AC455E6AD60A8EBC1C1153AAEADE7E38C598CBE10DF`.

**Findings**

No actionable archive-format, storage-cleanup, browser compatibility, build, lint, permission, or signing issue remains. No Android device was connected, so the 1.0.5-to-1.0.6 in-place installation and system save-picker success/cancellation/failure paths remain physical-device acceptance items.

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

## APK 1.0.7 compact shelf and on-demand long-image verification

- Date: 2026-08-11. Shelf commits now write generation-specific original pages and a JPEG cover, then commit the unchanged schema-v1 record only after every file succeeds. Long PNG generation is no longer part of a create or import commit.
- The shelf card restores the title edit icon and exposes exactly four direct buttons: `阅读`, `导出 .ecomic`, `导出长图`, and `删除`. Visible progress and restart controls are removed while saved reading position remains active.
- Long-image export streams page strips into a temporary PNG from private original pages or a directory-only `archive.ecomic`. Existing external `long.png` files remain directly exportable; new private or directory books do not automatically persist a long PNG.
- Aggressive cold-start cleanup clears legacy private PNG references before removing the old files. Original pages, covers, titles, timestamps, and reading progress remain intact, and unreferenced files are still removed by the orphan pass.
- Storage UI now renders only `已使用` and `剩余`. Desktop and Android-user-agent HTTP Chrome smoke runs passed; the Android runtime hid directory controls and retained the in-place-update explanation.
- Node regressions passed 26/26, JavaScript syntax checks and `git diff --check` passed, and the packaged APK was confirmed to contain the new `historySave`/`historySaved` worker flow.
- Gradle `assembleRelease` and `lintRelease` passed. `aapt2` confirmed `com.ecryptees.offline`, version 1.0.7 (code 8), minSdk 26, targetSdk 36, and no `INTERNET` permission. `apksigner` verified certificate SHA-256 `91306e7c15932646a58ffbd3443f541be57401f1f64106d8dcd0e97fbc5687e8`.
- Final APK: `dist/Ecryptees.apk`, 3,397,703 bytes; SHA-256 `1C351A96F6713185DFD43713E8E48B8BE9D2BDC141D7B7CC147BCEEF3310394B`.

**Findings**

No actionable shelf-commit, temporary-output, UI, browser-runtime, build, lint, permission, or signing issue remains. No physical Android device was connected, so 1.0.5/1.0.6 in-place installation, legacy-PNG space reclamation on device, and native save-picker cancellation remain physical-device acceptance items.

final result: passed with device coverage gap

## APK 1.0.9 shelf folders and release-name verification

- Date: 2026-08-11. The shelf toolbar now places an accessible add-folder icon beside the sort selector and renders scrollable `全部`, `未分组`, and named-folder filters.
- The title edit pencil was replaced by a three-dot card menu containing `修改名称` and `添加分组`. The four direct card actions remain `阅读`, `导出 .ecomic`, `导出长图`, and `删除`.
- Folder definitions and one-folder-per-book memberships use the separate `ecryptees-groups-v1` IndexedDB database. The existing `ecryptees-library-v1` database, book schema, pages, covers, progress, and `.ecomic` v1 format are unchanged. Existing books default to `未分组`.
- Deleting a book clears its membership; deleting all books clears memberships while leaving empty folder definitions available for reuse.
- Node regressions passed 26/26, JavaScript syntax checks and `git diff --check` passed, and the packaged web assets contain the new folder controls and group database integration.
- Gradle `assembleRelease` and `lintRelease` passed. `aapt2` confirmed `com.ecryptees.offline`, version 1.0.9 (code 10), and no `INTERNET` or storage permission. `apksigner` verified certificate SHA-256 `91306e7c15932646a58ffbd3443f541be57401f1f64106d8dcd0e97fbc5687e8`.
- The build script now validates generated version metadata and writes `dist/Ecryptees-v1.0.9.apk`; the stable `dist/Ecryptees.apk` alias has identical bytes. Both are 3,406,347 bytes with SHA-256 `16FEF7A9FBB673F87037994E83B77FF136CEA42B243447E83E3BF823E36ED047`.

**Findings**

No actionable storage-compatibility, archive-format, static UI, build, lint, permission, signing, or artifact-naming issue remains. A physical Android device was not connected, so touch interaction, system font scaling, and in-place installation from the mislabeled 1.0.7 artifact remain device-level acceptance items.

final result: passed with device coverage gap

## APK 1.0.10 broad Android handoff and compact shelf menu verification

- Date: 2026-08-11. Android now advertises `ACTION_VIEW` and single-file `ACTION_SEND` for wildcard MIME data, plus a content-URI fallback for providers that omit MIME metadata. The existing custom MIME and `.ecomic` path filters remain available for precise providers.
- Incoming shares read one URI from `EXTRA_STREAM`, `ClipData`, or intent data. More than one shared item is rejected. Every candidate still requires an `.ecomic` display name, bounded size, `ECRCOM1` magic, and the existing authenticated archive verification before shelf import.
- The horizontal folder strip was removed. The shelf now exposes one `最近阅读 · 当前文件夹` dropdown containing separate sorting and folder selectors; the add-folder icon remains adjacent.
- The app-private `ecryptees-library-v1` book database and `.ecomic` v1 format remain unchanged. Folder metadata continues to use the separate `ecryptees-groups-v1` database.
- Node regressions passed 26/26, JavaScript syntax checks and `git diff --check` passed. Gradle `assembleRelease` and `lintRelease` passed.
- `aapt2` confirmed `com.ecryptees.offline`, version 1.0.10 (code 11), and no `INTERNET` or storage permission. `apksigner` verified certificate SHA-256 `91306e7c15932646a58ffbd3443f541be57401f1f64106d8dcd0e97fbc5687e8`.
- Final APK: `dist/Ecryptees-v1.0.10.apk`, 3,406,827 bytes; SHA-256 `300B7236235D7C931201990C056AF9927B6DACE65E423C3BB8F72FE06B9F3E28`.

**Findings**

No actionable archive-validation, storage-compatibility, static UI, build, lint, permission, signing, or packaging issue remains. Broad wildcard registration intentionally makes Ecryptees visible for unrelated single files; those files are rejected after selection. No physical Android device was connected, so QQ and Xiaomi intent behavior remains device-level acceptance coverage.

final result: passed with device coverage gap

## APK 1.0.11 user-triggered webpage import verification

- Date: 2026-08-12. The former top tabs now live in a focus-managed slide-out drawer. Text, image, local comic, shelf, reader, folder, export, and `.ecomic` handoff identifiers and storage formats remain unchanged.
- Comic creation keeps the existing local-image path and adds an explicit “网页链接” source. No request occurs until the user presses “分析网页”. Static HTML is parsed without executing target scripts; all `<img>` elements are considered in DOM order using lazy-source attributes, the largest `srcset` candidate, and finally `src`.
- Candidates are limited to HTTPS, capped at 500, displayed without remote thumbnails, deduplicated without reordering, and can be selected, removed, dragged, or moved before download. The completed batch is appended to the existing comic array only after every selected image passes byte-signature validation; a partial failure leaves the comic unchanged and supports retry.
- Android declares only `INTERNET` in addition to its existing internal generated permission and still has no broad storage permission. Its tokenized network bridge follows at most five validated HTTPS redirects, uses system TLS, omits cookies and authorization state, streams HTML/images through native cache files, caps HTML at 5 MiB, and runs at most two requests concurrently.
- Node regressions passed 29/29, including lazy sources, `srcset`, relative/protocol-relative URLs, duplicate handling, candidate limits, archive authentication, exact page bytes, and parallel ordering. JavaScript syntax checks and `git diff --check` passed.
- Gradle `clean assembleRelease lintRelease` passed. `aapt2` confirmed `com.ecryptees.offline`, version 1.0.11 (code 12), minSdk 26, targetSdk 36, and `android.permission.INTERNET`. `apksigner` verified certificate SHA-256 `91306e7c15932646a58ffbd3443f541be57401f1f64106d8dcd0e97fbc5687e8`.
- Final APK: `dist/Ecryptees-v1.0.11.apk`, 3,421,225 bytes; SHA-256 `4DE42251CE7DC9262911B91DAD70B4B6B5844979DAC31BCE2C92542A05213349`.

**Findings**

No actionable archive-format, database, static UI, network-boundary, build, lint, storage-permission, signing, or packaging issue remains. The optional browser QA helper was unavailable in this Windows environment, and no physical Android device was connected, so drawer touch behavior, OEM WebView networking, site-specific anti-hotlink behavior, and in-place installation remain device-level acceptance coverage.

final result: passed with device coverage gap

## APK 1.1.6 comic shelf safety and UI-preview verification

- Date: 2026-08-18. The comic shelf now exposes 450 ms long-press multi-selection, a video-style bottom action sheet, a page-editor preview, and `.zip` bundle-selection preview. These three new workflows remain UI-only and do not import, export, delete, or rewrite comic assets.
- Shelf mutations are serialized across workers and browser windows with Web Locks plus an expiring IndexedDB lease fallback. Replacement writes a new generation and commits metadata before reclaiming the previous generation; malformed metadata no longer masks storage read failures.
- Cold-start cleanup blocks shelf access until ownership checks finish, has a 15-second fail-safe that skips deletion, retains all orphans whenever metadata ownership is uncertain, and only reclaims unreferenced generations older than seven days. Legacy long-image metadata is committed before its former file is removed.
- An isolated Edge run at 390 × 844 and 1024 × 768 created four real four-page books, reloaded the shelf, and verified the invalid-metadata guard, seven-day orphan boundary, long-press movement/cancel thresholds, select-all, action sheet, editor delete/confirm/undo states, no editor metadata writes, ZIP preview isolation, and absence of console errors or horizontal overflow.
- JavaScript syntax checks, `git diff --check`, and all 62 Node tests passed. Gradle release build, lint, packaging, version verification, and APK Signature Scheme v2 verification passed.
- Final APK: `dist/Ecryptees-v1.1.6.apk` and byte-identical `dist/Ecryptees.apk`, versionCode 24, 3,536,665 bytes; SHA-256 `709805AC379C1069E6CC5787762D4CB995AA321174A1D387D460E74759180F27`. Signing certificate SHA-256 remains `91306e7c15932646a58ffbd3443f541be57401f1f64106d8dcd0e97fbc5687e8`.

**Findings**

No actionable storage, concurrency, cleanup, browser UI, build, lint, versioning, or signing issue remains. A physical Android device was not connected, so OEM WebView cleanup callbacks, touch interaction, system document handoff, and in-place installation remain device-level acceptance coverage.

final result: passed with device coverage gap

## APK 1.1.7 Android long-press, storage reporting, and video recovery verification

- Date: 2026-08-18. The comic shelf now suppresses the Android WebView native callout and context menu, retains the 450 ms/10 px gesture boundary, and requests native long-press haptic feedback only after multi-selection succeeds.
- Android capacity checks use `StatFs` free bytes from the application data filesystem. Image, video, and comic write preflights take the conservative minimum of actual device availability and the browser-origin estimate while retaining the 64 MiB reserve. Shelf summaries use decimal GB and distinguish `设备可用` from `浏览器估算可用`.
- Image assets remain atomic IndexedDB records containing both bytes and metadata. Video MP4 bytes remain in OPFS, with a schema-v1 JSON recovery sidecar added beside each committed MP4. Startup audit backfills sidecars for existing indexed videos and reconstructs a missing IndexedDB record from a retained MP4 without deleting the source file. Playback progress writes do not repeatedly rewrite the sidecar.
- The 1.1.5 and 1.1.6 packaged image/video controllers were byte-identical, and no startup path was found that deletes committed `ecryptees-video-asset-*.mp4` files. The prior empty shelf is consistent with loss of the separate video IndexedDB index; 1.1.7 can recover it only when the OPFS MP4 remains present.
- An isolated Edge test created an image and MP4, reloaded them, deleted only the video IndexedDB record, recovered the original title and index from the retained MP4, then exercised a real CDP touch long-press with no console errors or horizontal overflow.
- All 64 Node tests, JavaScript syntax checks, `git diff --check`, isolated Edge verification, Gradle `clean assembleRelease lintRelease`, APK version validation, and APK Signature Scheme v2 verification passed. Android lint reported zero errors and six pre-existing dependency/manifest-style warnings.
- `aapt2` confirmed `com.ecryptees.offline`, version 1.1.7 (code 25), minSdk 26, targetSdk 36, and no broad storage permission. Final APK: `dist/Ecryptees-v1.1.7.apk` and byte-identical `dist/Ecryptees.apk`, 3,539,197 bytes; SHA-256 `91E034C6160C8272F835A04A8A9EA02526F013F4E78C17ADB875D8706C17E757`. Signing certificate SHA-256 remains `91306e7c15932646a58ffbd3443f541be57401f1f64106d8dcd0e97fbc5687e8`.

**Findings**

No actionable deletion, capacity, long-press, archive-format, browser regression, build, lint-error, versioning, or signing issue remains. A physical Android device was not connected, so OEM WebView long-press behavior, real filesystem free-byte changes under pressure, in-place update recovery, and whether the affected device still retains its former OPFS MP4 files remain device-level acceptance items.

final result: passed with device coverage gap

## APK 1.1.8 comic bundle and page-editor verification

- Date: 2026-08-18. The comic shelf now performs real 450 ms long-press multi-selection, serial multi-book ZIP export, authenticated bundle import, and atomic page editing instead of the former preview-only flows.
- The editor displays stored page thumbnails, supports URL capture and multi-file local image append, marks removals for undo, and confirms the final added/deleted counts before committing. Local selection has no per-batch count limit; the unchanged `.ecomic` v1 whole-book limits of 80 pages and 500 MiB are enforced at save time with a visible reduction prompt.
- A successful edit writes every retained and added page into a new generation, regenerates the cover, maps reading progress, commits metadata last, clears stale long-image metadata, and only then reclaims the former generation. Cancellation and any pre-commit failure leave the original book unchanged.
- Bundle export writes `ecryptees-bundle.json` plus stored `books/<bookId>.ecomic` entries, keeps only the final ZIP and current temporary archive, and rejects 4 GiB overflow before output. Import rejects ZIP64, encrypted/compressed entries, traversal, duplicates, malformed boundaries, CRC damage, undeclared files, and unauthenticated `.ecomic` data while continuing with unaffected books.
- Android accepts `.zip` through system open/share handoff and retains chunked OPFS input plus SAF output. It adds no broad storage permission. Existing image and video recovery/storage protections from 1.1.7 remain covered by the 64-test regression suite.
- An isolated Microsoft Edge run at 439 px mobile width and 1024 px desktop width created four real four-page books, verified touch long-press and movement cancellation, edited one book from four to five pages using two locally selected images and one pending deletion, confirmed every committed page moved to the new generation, exported and replaced four books through ZIP, then damaged one archive and confirmed the other three still imported. No console errors, exceptions, or horizontal overflow occurred.
- JavaScript syntax checks, `git diff --check`, all 64 Node tests, Edge interaction verification, Gradle release build, Android lint, version validation, and APK Signature Scheme v2 verification passed.
- Final APK: `dist/Ecryptees-v1.1.8.apk` and byte-identical `dist/Ecryptees.apk`, versionCode 26, 3,552,473 bytes; SHA-256 `75B9B9CE2B2E560282E0BC59CEE5165FF5F90C98CF6149995C164D084704589F`. Signing certificate SHA-256 remains `91306e7c15932646a58ffbd3443f541be57401f1f64106d8dcd0e97fbc5687e8`.

**Findings**

No actionable editor, atomic-storage, ZIP-validation, partial-import, long-press, browser-layout, regression, build, lint, versioning, or signing issue remains. A physical Android device was not connected, so OEM document-provider ZIP handoff, sustained near-limit storage pressure, in-place update recovery, and native haptic feel remain device-level acceptance items.

final result: passed
