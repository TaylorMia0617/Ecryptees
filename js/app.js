(function (root) {
    'use strict';

    const core = root.Ecryptees && root.Ecryptees.core;
    if (!core) {
        throw new Error('Ecryptees core must load before the application controller.');
    }

    const { codec, image, utils, config } = core;
    const {
        encodeBytes,
        decodeCode,
        waitForNextFrame,
        encodeImageByteSegmentsChunked,
        decodeImageCodeChunked,
        calculateCrc32Chunked,
        buildImagePrefix,
        parseImagePayload
    } = codec;
    const {
        sniffImageType,
        isAnimatedImage,
        createJpegDownloadBlob,
        optimizeImage
    } = image;
    const { makeJpegDownloadName, formatBytes, sanitizeDownloadName } = utils;
    const {
        LEGACY_IMAGE_VERSION,
        COMPACT_IMAGE_VERSION,
        IMAGE_VERSION,
        MAX_IMAGE_BYTES,
        MAX_COMPACT_IMAGE_CODE_LENGTH,
        MAX_IMAGE_CODE_LENGTH,
        MAX_CIPHER_TEXT_FILE_BYTES,
        COMPRESSION_PRESETS,
        legacyImageCodePrefix,
        imageCodePrefix
    } = config;

    let selectedImage = null;
    let sourceImageUrl = '';
    let compressedImageUrl = '';
    let cipherTextDownloadUrl = '';
    let decodedImageUrl = '';
    let importedImageCode = '';
    let imageBusy = false;

    function getCompressionMode() {
        return document.querySelector('input[name="compressionMode"]:checked')?.value || 'balanced';
    }

    function setImageStatus(message, kind = 'info') {
        const status = document.getElementById('imageStatus');
        status.textContent = message;
        status.dataset.kind = kind;
        status.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    }

    function setImageProgress(value, kind = 'info') {
        const normalizedValue = Math.max(0, Math.min(100, Math.round(value)));
        const group = document.getElementById('imageProgressGroup');
        const progress = document.getElementById('imageProgress');
        group.hidden = false;
        group.dataset.kind = kind;
        progress.value = normalizedValue;
        progress.setAttribute('aria-valuetext', `${normalizedValue}%`);
        document.getElementById('imageProgressText').textContent = `${normalizedValue}%`;
    }

    function resetImageProgress() {
        const group = document.getElementById('imageProgressGroup');
        group.hidden = true;
        group.dataset.kind = 'info';
        document.getElementById('imageProgress').value = 0;
        document.getElementById('imageProgressText').textContent = '0%';
    }

    function clearCompressedPreview() {
        if (compressedImageUrl) {
            URL.revokeObjectURL(compressedImageUrl);
            compressedImageUrl = '';
        }

        document.getElementById('compressedImagePreview').removeAttribute('src');
        document.getElementById('compressedImageCard').hidden = true;
        document.getElementById('compressedImageMeta').textContent = '';
    }

    function showCompressedPreview(result) {
        clearCompressedPreview();
        const blob = new Blob([result.bytes], { type: result.format.mime });
        compressedImageUrl = URL.createObjectURL(blob);
        document.getElementById('compressedImagePreview').src = compressedImageUrl;

        const reduction = selectedImage
            ? Math.max(0, (1 - result.bytes.length / selectedImage.bytes.length) * 100)
            : 0;
        const dimensions = result.width && result.height ? ` · ${result.width}×${result.height}` : '';
        const quality = result.quality === null ? '' : ` · 质量 ${Math.round(result.quality * 100)}%`;
        document.getElementById('compressedImageMeta').textContent = `${result.outputName} · ${formatBytes(result.bytes.length)}${dimensions}${quality} · 缩减 ${reduction.toFixed(1)}%`;
        document.getElementById('compressedImageCard').hidden = false;
    }

    function clearCipherTextDownload() {
        if (cipherTextDownloadUrl) {
            URL.revokeObjectURL(cipherTextDownloadUrl);
            cipherTextDownloadUrl = '';
        }

        const download = document.getElementById('downloadCipherText');
        download.href = '#';
        download.removeAttribute('download');
        download.setAttribute('aria-disabled', 'true');
    }

    function createCipherTextDownload(encoded, sourceName) {
        clearCipherTextDownload();
        const baseName = String(sourceName || 'image').replace(/\.[^.]*$/, '') || 'image';
        const fileName = sanitizeDownloadName(`${baseName}-msbt-v3.txt`, 'txt');
        const blob = new Blob([encoded], { type: 'text/plain;charset=utf-8' });
        cipherTextDownloadUrl = URL.createObjectURL(blob);
        const download = document.getElementById('downloadCipherText');
        download.href = cipherTextDownloadUrl;
        download.download = fileName;
        download.setAttribute('aria-disabled', 'false');
        return { fileName, byteLength: blob.size };
    }

    function invalidateImageCipherOutput(message = '') {
        clearCipherTextDownload();
        clearCompressedPreview();

        if (message && selectedImage) {
            setImageStatus(message);
        }

        updateImageButtons();
    }

    function updateImageButtons() {
        document.getElementById('encodeImageButton').disabled = imageBusy || !selectedImage;
        document.getElementById('decodeImageButton').disabled = imageBusy || importedImageCode.length === 0;
        document.getElementById('imageFile').disabled = imageBusy;
        document.getElementById('imageCodeFile').disabled = imageBusy;
        document.getElementById('compressionPanel').disabled = imageBusy;
        document.getElementById('downloadCipherText').setAttribute('aria-disabled', String(imageBusy || !cipherTextDownloadUrl));
    }

    function updateTextCopyButton(generated = false) {
        const button = document.getElementById('copyTextCodeButton');
        button.dataset.generated = generated && document.getElementById('inputCode').value.length > 0 ? 'true' : '';
        button.disabled = !button.dataset.generated;
    }

    async function copyCipherText(inputId, buttonId, label) {
        const input = document.getElementById(inputId);
        const button = document.getElementById(buttonId);

        if (button.disabled || !input.value) {
            return;
        }

        try {
            let copied = false;

            if (navigator.clipboard && window.isSecureContext) {
                try {
                    await navigator.clipboard.writeText(input.value);
                    copied = true;
                } catch (error) {
                    copied = false;
                }
            }

            if (!copied) {
                const selectionStart = input.selectionStart;
                const selectionEnd = input.selectionEnd;
                input.focus();
                input.select();

                if (!document.execCommand('copy')) {
                    throw new Error('复制失败');
                }

                input.setSelectionRange(selectionStart, selectionEnd);
            }

            button.dataset.copied = 'true';
            button.setAttribute('aria-label', `${label}已复制`);
            button.title = `${label}已复制`;
            document.getElementById('copyStatus').textContent = `${label}已复制`;
            window.clearTimeout(button._copyResetTimer);
            button._copyResetTimer = window.setTimeout(() => {
                button.dataset.copied = 'false';
                button.setAttribute('aria-label', `复制${label}`);
                button.title = `复制${label}`;
            }, 1600);
        } catch (error) {
            alert('复制失败，请手动选择密文复制');
        }
    }

    function setImageBusy(busy) {
        imageBusy = busy;
        updateImageButtons();
    }

    function switchTab(mode, focusTab = false) {
        const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
        const activeTab = tabs.find(tab => tab.dataset.mode === mode) || tabs[0];

        tabs.forEach(tab => {
            const active = tab === activeTab;
            tab.setAttribute('aria-selected', String(active));
            tab.tabIndex = active ? 0 : -1;
            const panel = document.getElementById(tab.getAttribute('aria-controls'));
            if (panel) {
                panel.hidden = !active;
            }
        });

        if (focusTab) {
            activeTab.focus();
        }
    }

    async function handleImageSelection(event) {
        const file = event.target.files[0];

        if (!file) {
            return;
        }

        try {
            if (file.size === 0) {
                throw new Error('图片文件不能为空');
            }

            if (file.size > MAX_IMAGE_BYTES) {
                throw new Error('图片不能超过 15 MiB');
            }

            const bytes = new Uint8Array(await file.arrayBuffer());
            const format = sniffImageType(bytes);

            if (!format) {
                throw new Error('不支持该图片格式，请选择 PNG、JPEG、GIF、WebP、BMP 或 AVIF');
            }

            const animated = isAnimatedImage(bytes, format);
            selectedImage = { file, bytes, format, animated };

            if (sourceImageUrl) {
                URL.revokeObjectURL(sourceImageUrl);
            }

            sourceImageUrl = URL.createObjectURL(file);
            const preview = document.getElementById('sourceImagePreview');
            preview.onload = () => {
                if (!selectedImage || selectedImage.file !== file) {
                    return;
                }

                selectedImage.width = preview.naturalWidth;
                selectedImage.height = preview.naturalHeight;
                const dimensions = preview.naturalWidth && preview.naturalHeight ? ` · ${preview.naturalWidth}×${preview.naturalHeight}` : '';
                document.getElementById('sourceImageMeta').textContent = `${file.name} · ${format.label} · ${formatBytes(file.size)}${dimensions}${animated ? ' · 动画' : ''}`;
            };
            preview.src = sourceImageUrl;
            document.getElementById('sourceImageMeta').textContent = `${file.name} · ${format.label} · ${formatBytes(file.size)}${animated ? ' · 动画' : ''}`;
            document.getElementById('sourceImageCard').hidden = false;
            importedImageCode = '';
            document.getElementById('imageCodeFile').value = '';
            document.getElementById('imageCodeFileMeta').textContent = '尚未选择 TXT';
            clearCipherTextDownload();
            clearCompressedPreview();
            resetImageProgress();
            setImageStatus(animated
                ? '检测到动画：将取首帧压缩为 JPG 后编码。'
                : '图片已准备好，将按所选档位压缩为 JPG 后编码。');
        } catch (error) {
            event.target.value = '';
            setImageStatus(error.message, 'error');
        } finally {
            updateImageButtons();
        }
    }

    async function handleCipherTextSelection(event) {
        const file = event.target.files[0];

        if (!file) {
            return;
        }

        importedImageCode = '';
        try {
            if (file.size === 0) {
                throw new Error('密文 TXT 文件不能为空');
            }

            if (!/\.txt$/i.test(file.name)) {
                throw new Error('请选择 TXT 密文文件');
            }

            if (file.size > MAX_CIPHER_TEXT_FILE_BYTES) {
                throw new Error('密文 TXT 文件过大');
            }

            const input = (await file.text()).replace(/^\uFEFF/, '').trim();
            if (!input) {
                throw new Error('密文 TXT 文件中没有内容');
            }

            const maximumCodeLength = input.startsWith(imageCodePrefix)
                ? MAX_COMPACT_IMAGE_CODE_LENGTH
                : MAX_IMAGE_CODE_LENGTH;
            if (input.length > maximumCodeLength) {
                throw new Error('密文 TXT 内容过长，图片可能超过 15 MiB');
            }

            if (!input.startsWith(imageCodePrefix) && !input.startsWith(legacyImageCodePrefix)) {
                throw new Error('这不是本工具生成的图片密文 TXT');
            }

            importedImageCode = input;
            document.getElementById('imageCodeFileMeta').textContent = `${file.name} · ${formatBytes(file.size)} · ${input.length.toLocaleString()} 字符`;
            resetImageProgress();
            setImageStatus('密文 TXT 已读取，可以开始解码。');
        } catch (error) {
            event.target.value = '';
            document.getElementById('imageCodeFileMeta').textContent = 'TXT 读取失败';
            setImageStatus(error.message || '密文 TXT 读取失败', 'error');
        } finally {
            updateImageButtons();
        }
    }

    function encode() {
        const input = document.getElementById('inputRaw').value;
        const bytes = new TextEncoder().encode(input);
        document.getElementById('inputCode').value = encodeBytes(bytes);
        updateTextCopyButton(true);
    }

    function decode() {
        const input = document.getElementById('inputCode').value;
        let bytes;

        try {
            bytes = decodeCode(input);
        } catch (error) {
            alert(error.message);
            return;
        }

        const decoder = new TextDecoder();

        try {
            document.getElementById('inputRaw').value = decoder.decode(bytes);
        } catch (error) {
            alert('无法正确解码为UTF-8文本');
            document.getElementById('inputRaw').value = Array.from(bytes)
                .map(byte => byte.toString(16).padStart(2, '0'))
                .join(' ');
        }
    }

    async function encodeImage() {
        if (imageBusy || !selectedImage) {
            return;
        }

        setImageBusy(true);
        clearCipherTextDownload();
        setImageProgress(0);
        setImageStatus('正在准备图片密文… 0%');
        await waitForNextFrame();

        try {
            const mode = getCompressionMode();
            setImageProgress(8);
            setImageStatus('图片验证完成，正在准备压缩… 8%');
            const processedImage = await optimizeImage(selectedImage, mode, info => {
                const overallProgress = 10 + Math.round(info.percent * 0.55);
                setImageProgress(overallProgress);
                setImageStatus(`${info.message}… ${overallProgress}%`);
            });
            const imageCrc32 = await calculateCrc32Chunked(processedImage.bytes, progress => {
                const overallProgress = 65 + Math.round(progress * 0.1);
                setImageProgress(overallProgress);
                setImageStatus(`正在校验压缩结果… ${overallProgress}%`);
            });
            const prefix = buildImagePrefix(processedImage, imageCrc32);
            const encoded = await encodeImageByteSegmentsChunked([prefix, processedImage.bytes], progress => {
                const overallProgress = 75 + Math.round(progress * 0.22);
                setImageProgress(overallProgress);
                setImageStatus(`正在编码图片… ${overallProgress}%`);
            });

            setImageProgress(98);
            setImageStatus('正在生成密文 TXT 文件… 98%');
            await waitForNextFrame();
            const textFile = createCipherTextDownload(encoded, selectedImage.file.name);
            showCompressedPreview(processedImage);
            setImageProgress(100, 'success');
            const reduction = Math.max(0, (1 - processedImage.bytes.length / selectedImage.bytes.length) * 100);
            const animationNote = processedImage.animation === 'first-frame' ? '，动画已转换为首帧' : '';
            document.getElementById('imageCodeFileMeta').textContent = `${textFile.fileName} · ${formatBytes(textFile.byteLength)} · ${encoded.length.toLocaleString()} 字符`;
            setImageStatus(`编码完成：${formatBytes(selectedImage.bytes.length)} → ${formatBytes(processedImage.bytes.length)}，TXT 共 ${encoded.length.toLocaleString()} 个密文字符，图片缩减 ${reduction.toFixed(1)}%${animationNote}。请下载密文文件。`, 'success');
        } catch (error) {
            document.getElementById('imageProgressGroup').dataset.kind = 'error';
            setImageStatus(error.message || '图片编码失败', 'error');
        } finally {
            setImageBusy(false);
        }
    }

    async function decodeImage() {
        if (imageBusy) {
            return;
        }

        const input = importedImageCode;

        if (!input) {
            setImageStatus('请先选择图片密文 TXT 文件', 'error');
            return;
        }

        const maximumCodeLength = input.startsWith(imageCodePrefix)
            ? MAX_COMPACT_IMAGE_CODE_LENGTH
            : MAX_IMAGE_CODE_LENGTH;
        if (input.length > maximumCodeLength) {
            setImageStatus('图片密文过长，图片可能超过 15 MiB', 'error');
            return;
        }

        setImageBusy(true);
        setImageProgress(0);
        setImageStatus('正在读取图片密文… 0%');
        await waitForNextFrame();

        try {
            const decoded = await decodeImageCodeChunked(input, progress => {
                const overallProgress = Math.min(95, Math.round(progress * 0.95));
                setImageProgress(overallProgress);
                setImageStatus(`正在解码图片… ${overallProgress}%`);
            });
            setImageProgress(97);
            setImageStatus('正在验证图片… 97%');
            await waitForNextFrame();
            const payloadVersion = decoded.payload[8];
            const familyMatches = decoded.cipherFamily === 'legacy'
                ? payloadVersion === LEGACY_IMAGE_VERSION
                : payloadVersion === COMPACT_IMAGE_VERSION || payloadVersion === IMAGE_VERSION;
            if (!familyMatches) {
                throw new Error('图片密文版本与编码方式不一致');
            }
            const result = parseImagePayload(decoded.payload);
            setImageProgress(98);
            setImageStatus(result.format.mime === 'image/jpeg' ? '正在准备 JPG… 98%' : '正在转换为 JPG… 98%');
            const jpegBlob = await createJpegDownloadBlob(result.imageBytes, result.format.mime);
            const nextUrl = URL.createObjectURL(jpegBlob);
            const downloadName = makeJpegDownloadName(result.metadata.name);

            if (decodedImageUrl) {
                URL.revokeObjectURL(decodedImageUrl);
            }

            decodedImageUrl = nextUrl;
            document.getElementById('decodedImagePreview').src = decodedImageUrl;
            const compression = result.metadata.compression;
            const compressionLabel = compression && typeof compression.mode === 'string'
                ? ` · ${COMPRESSION_PRESETS[compression.mode]?.label || compression.mode}`
                : '';
            document.getElementById('decodedImageMeta').textContent = `${downloadName} · JPG · ${formatBytes(jpegBlob.size)}${compressionLabel}`;
            const download = document.getElementById('downloadImage');
            download.href = decodedImageUrl;
            download.download = downloadName;
            document.getElementById('decodedImageCard').hidden = false;
            setImageProgress(100, 'success');
            setImageStatus('图片解码成功，可以预览或下载。', 'success');
        } catch (error) {
            document.getElementById('imageProgressGroup').dataset.kind = 'error';
            setImageStatus(error.message || '图片解码失败', 'error');
        } finally {
            setImageBusy(false);
        }
    }

    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    tabs.forEach((tab, index) => {
        tab.addEventListener('click', () => switchTab(tab.dataset.mode));
        tab.addEventListener('keydown', event => {
            let targetIndex = null;

            if (event.key === 'ArrowRight') {
                targetIndex = (index + 1) % tabs.length;
            } else if (event.key === 'ArrowLeft') {
                targetIndex = (index - 1 + tabs.length) % tabs.length;
            } else if (event.key === 'Home') {
                targetIndex = 0;
            } else if (event.key === 'End') {
                targetIndex = tabs.length - 1;
            }

            if (targetIndex !== null) {
                event.preventDefault();
                switchTab(tabs[targetIndex].dataset.mode, true);
            }
        });
    });

    const imageFileInput = document.getElementById('imageFile');
    imageFileInput.addEventListener('change', handleImageSelection);
    document.querySelector('.file-picker').addEventListener('keydown', event => {
        if ((event.key === 'Enter' || event.key === ' ') && !imageFileInput.disabled) {
            event.preventDefault();
            imageFileInput.click();
        }
    });

    document.querySelectorAll('input[name="compressionMode"]').forEach(input => {
        input.addEventListener('change', () => {
            const preset = COMPRESSION_PRESETS[getCompressionMode()];
            document.getElementById('compressionDetail').textContent = preset.description;
            invalidateImageCipherOutput('压缩档位已改变，请重新编码图片。');
        });
    });
    const imageCodeFileInput = document.getElementById('imageCodeFile');
    imageCodeFileInput.addEventListener('change', handleCipherTextSelection);
    document.getElementById('imageCodeFilePicker').addEventListener('keydown', event => {
        if ((event.key === 'Enter' || event.key === ' ') && !imageCodeFileInput.disabled) {
            event.preventDefault();
            imageCodeFileInput.click();
        }
    });
    document.getElementById('inputCode').addEventListener('input', () => updateTextCopyButton(false));
    window.addEventListener('beforeunload', () => {
        if (sourceImageUrl) {
            URL.revokeObjectURL(sourceImageUrl);
        }
        if (compressedImageUrl) {
            URL.revokeObjectURL(compressedImageUrl);
        }
        if (cipherTextDownloadUrl) {
            URL.revokeObjectURL(cipherTextDownloadUrl);
        }
        if (decodedImageUrl) {
            URL.revokeObjectURL(decodedImageUrl);
        }
    });

    document.getElementById('copyTextCodeButton').addEventListener('click', () => {
        copyCipherText('inputCode', 'copyTextCodeButton', '文本密文');
    });
    document.getElementById('encodeTextButton').addEventListener('click', encode);
    document.getElementById('decodeTextButton').addEventListener('click', decode);
    document.getElementById('encodeImageButton').addEventListener('click', encodeImage);
    document.getElementById('decodeImageButton').addEventListener('click', decodeImage);
    updateImageButtons();
})(globalThis);
