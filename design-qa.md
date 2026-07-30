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
- Lossy v3 fixture results for the same image: clear 63,826 ciphertext characters, balanced 49,461, and extreme 26,673
- Animated-image fixture: generated two-frame 2 × 2 GIF (111 bytes), used to verify animation detection and frame-preserving default behavior
- Stability/progress evidence: `C:\Users\user\AppData\Local\Temp\msbt-progress-regression-4NZEAi\encoding-progress.png` and `encoding-complete.png`
- Memory regression evidence: pre-fix `C:\Users\user\AppData\Local\Temp\msbt-memory-diag-cyVgDj`; post-fix `C:\Users\user\AppData\Local\Temp\msbt-memory-diag-WLtBae`
- Desktop viewport and captures: 1440 × 900 CSS px and PNG px; device scale factor 1
- Mobile viewport and captures: 390 × 844 CSS px and PNG px; device scale factor 1
- Copy reference comparison: source 687 × 540 px and implementation 689 × 540 CSS/PNG px at device scale factor 1. They were placed side by side without scaling in a 1402 × 582 comparison canvas; the two-pixel source-width difference is retained and documented rather than stretched.
- States: unchanged text workflow, image upload/encoded state, TXT download state, TXT import state, decoded success/download state, and text-copy disabled/enabled/success states

The original page is the visual baseline for typography, spacing, colors, imagery, controls, and text behavior. The new tab and image workflow are intentional additions defined by the approved feature specification, so their new content is reviewed for consistency rather than false pixel equivalence with a state that did not previously exist.

## Full-view comparison

- Fonts and typography: title, labels, text areas, buttons, metadata, hints, status messages, and responsive wrapping remain consistent with the source hierarchy.
- Spacing and layout rhythm: the 800 px desktop card, 20 px outer inset, 16 px radius, shadows, and button spacing are preserved. The tab control and image cards use the same spacing scale. The text cipher retains its aligned 40 × 40 px copy action; the image workflow now uses a dedicated TXT file card with download and upload actions. At 390 px the card remains 350 px wide and document scroll width remains exactly 390 px.
- Colors and tokens: tabs, upload control, dashed boundary, image cards, success/error text, download action, and copy action reuse the existing pink palette and surface colors. Successful copying temporarily uses the existing semantic green.
- Image quality and asset fidelity: the embedded source background is unchanged. Uploaded and decoded previews use intrinsic sizing with `max-width`/`max-height`, preserve aspect ratio, and avoid upscaling small images. The copy glyph is the official Google Material `content_copy` icon, embedded as a PNG data URL so offline use remains intact.
- Copy and content: the image page names all six supported formats, states the 15 MiB limit, and makes local-only processing explicit. Text copy retains its concise label and `已复制` confirmation. Image ciphertext is no longer inserted into the page or clipboard; it is exported as UTF-8 TXT and imported through a TXT file picker.

## Focused comparisons

- Desktop decoded-result evidence: `image-result-desktop.png` confirms the encoded field, action buttons, success message, restored preview, file metadata, and download action in one state.
- Mobile decoded-result evidence: `image-result-mobile.png` confirms the same core journey at 390 × 844 without horizontal clipping.
- `compare-text.png` confirms that the original text controls, copy, background crop, and visual tokens remain intact; the vertical shift is the intentional tab insertion.
- `compare-copy-button.png` places the user's annotated 687 × 540 source beside the 689 × 540 implementation. The requested right-side placement is present, the icon remains outside the text area, and the success feedback does not cover the field label or cipher text.
- `image-copy-mobile.png` is retained as historical evidence for the superseded image-copy control. Current 390 × 844 runtime inspection confirms the TXT download/upload card has no horizontal overflow.
- `encoding-progress.png` captures the provided 1280 × 720 PNG at a genuinely intermediate 78% state: controls are disabled, the bar is partially filled, and the status text matches the bar. `encoding-complete.png` captures the same state at green 100% with the full cipher present.

## Interaction and runtime checks

- Text regression passed for empty text, ASCII, Chinese, emoji, mixed text, odd length, illegal characters, and non-fatal UTF-8 replacement behavior.
- PNG, JPEG, animated GIF, WebP, BMP, and AVIF each passed signature detection, encoding, decoding, browser preview, original filename restoration, MIME restoration, and byte-exact CRC comparison.
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
- The v3 compact pipeline passed in real Chrome with the provided 1280 × 720 PNG. Clear mode produced a 62.0 KiB WebP and 63,826 ciphertext characters; balanced produced a 47.9 KiB WebP and 49,461 characters; extreme produced a 25.7 KiB 960 × 540 WebP and 26,673 characters.
- Balanced mode reduced the provided image bytes by 94.0% and ciphertext length by approximately 97.0% compared with the legacy 1,628,802-character v1 output.
- The v3 payload decoded to a valid WebP preview and restored the `-compressed.webp` download name, compression label, MIME type, and CRC32-protected bytes.
- Compact v2 compatibility passed by decoding a v2 payload through the same 256-character family; the supplied 45,530-character v1 attachment also decoded to its original 22.1 KiB PNG and filename.
- A generated two-frame GIF was detected as animated, exposed the explicit first-frame option, and preserved all frames and original GIF bytes when that option remained off.
- The compression UI completed three consecutive mode changes and encodes without a reload. Observed painted progress states included 0%, 13%, 75%, 97%, 98%, and 100%, corresponding to validation/compression, CRC, character mapping, field write, and completion.
- At 390 × 844 the document and viewport widths both remained 390 px, the card remained 350 px wide, and the three compression choices collapsed to one column without horizontal overflow.
- The balanced v3 result exported as `d79afbd80e767f7033fc631f1b942c7e_720-msbt-v3.txt`: 49,461 ciphertext characters and 148,208 UTF-8 bytes (144.7 KiB), with no BOM added.
- Re-importing that TXT with a deliberately added UTF-8 BOM and trailing CRLF restored the 47.9 KiB WebP successfully. The importer strips only the leading BOM and surrounding whitespace, validates the code prefix and character limit, and keeps malformed/non-TXT files out of the decoder.
- The image page contains no image-cipher copy button and no large ciphertext textarea. This avoids clipboard limits and removes the browser cost of painting tens of thousands of cipher characters.

## Findings

No actionable P0, P1, or P2 issues remain.

## Comparison history

- Pass 1: a P2 preview-quality issue was found because very small images were enlarged to the full card width.
- Fix: changed previews to intrinsic width with `max-width: 100%`, `max-height: 280px`, and centered layout.
- Pass 2: desktop and mobile captures with a 640 × 360 image confirmed correct aspect ratio, sharpness, and no overflow. The 15 MiB copy and boundary behavior were also revalidated.
- Pass 3: the requested copy controls were implemented on both cipher fields. The source annotation and implementation were compared side by side; desktop and mobile captures confirmed right-edge alignment, a clear disabled/active/success state, a 40 px target, and zero horizontal overflow. Clipboard equality and console checks passed with no P0–P2 findings.
- Pass 4: user-reported P1 intermittent renderer crashes and P2 fake progress were reproduced. The old 1 MiB chunk made the provided 814,296-byte image report only 100%, and repeated 15 MiB encoding doubled live heap to about 317 MiB. The encoder now clears stale output before work, computes CRC in painted 128 KiB chunks, writes the versioned payload from separate prefix/image segments without a full payload copy, and uses bounded UTF-16 buffers instead of million-entry string arrays. Post-fix captures show 78% and 100% states, repeated encoding remains stable, and no P0–P2 finding remains.
- Pass 5: image output moved to a v3 lossy pipeline with clear, balanced, and extreme WebP presets, up to five adaptive quality/size passes, a 256-character one-byte codebook, animation-aware behavior, compact v2 and legacy v1 decode compatibility, and a 40-megapixel decode guard. Real Chrome exercised all three presets, v1/v2/v3 decode paths, animation preservation, progress, output activation, and the 390 px mobile layout with zero console errors.
- Pass 6: removed the image ciphertext textarea and image-copy action. Encoding now creates an offline UTF-8 TXT Blob and activates only the download action; decoding requires a selected TXT file. Real Chrome completed encode → TXT download → BOM/CRLF-tolerant TXT import → image decode, then repeated the import path with the supplied legacy v1 ciphertext. Mobile width remained exact and console errors remained zero.

## Follow-up polish

- P3: an animated image kept in its original format, or a static image that is already smaller than every WebP candidate, can still produce a comparatively long compact ciphertext. The explicit first-frame option trades animation for a much shorter result when desired.

final result: passed
