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
    const { sniffImageType, isAnimatedImage } = image;
    const { formatBytes, sanitizeDownloadName } = utils;
    const androidMedia = root.EcrypteesAndroidMedia;
    const {
        LEGACY_IMAGE_VERSION,
        COMPACT_IMAGE_VERSION,
        IMAGE_VERSION,
        MAX_IMAGE_BYTES,
        MAX_COMPACT_IMAGE_CODE_LENGTH,
        MAX_IMAGE_CODE_LENGTH,
        MAX_CIPHER_TEXT_FILE_BYTES,
        legacyImageCodePrefix,
        imageCodePrefix
    } = config;

    let selectedImage = null;
    let sourceImageUrl = '';
    let cipherTextDownloadUrl = '';
    let decodedImageUrl = '';
    let decodedImageDownloadUrl = '';
    let currentImageResult = null;
    let savedImageAssetId = '';
    let imageSourceMode = 'local';

    function isHeifFormat(format) {
        return format?.mime === 'image/heic' || format?.mime === 'image/heif';
    }
    let importedImageCode = '';
    let imageBusy = false;

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
        currentImageResult = null;
        savedImageAssetId = '';

        if (message && selectedImage) {
            setImageStatus(message);
        }

        updateImageButtons();
    }

    function updateImageButtons() {
        document.getElementById('encodeImageButton').disabled = imageBusy || imageSourceMode !== 'local' || !selectedImage;
        document.getElementById('decodeImageButton').disabled = imageBusy || imageSourceMode !== 'cipher' || importedImageCode.length === 0;
        document.getElementById('imageFile').disabled = imageBusy;
        document.getElementById('imageCodeFile').disabled = imageBusy;
        document.getElementById('downloadCipherText').setAttribute('aria-disabled', String(imageBusy || !cipherTextDownloadUrl));
        document.getElementById('saveImageToAssets').disabled = imageBusy;
        document.getElementById('viewSavedImageButton').disabled = imageBusy || !savedImageAssetId;
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

    const pageTitles = Object.freeze({ text: '文本', image: '图片', comic: '漫画', history: '资产' });
    const drawer = document.getElementById('appDrawer');
    const drawerBackdrop = document.getElementById('appDrawerBackdrop');
    const menuButton = document.getElementById('appMenuButton');
    const assetGroups = document.getElementById('appDrawerAssetGroups');
    const assetGroupsToggle = document.getElementById('appDrawerAssetsToggle');

    function setAssetGroupsExpanded(expanded) {
        assetGroups.hidden = !expanded;
        assetGroupsToggle.setAttribute('aria-expanded', String(expanded));
        assetGroupsToggle.setAttribute('aria-label', expanded ? '收起资产分组' : '展开资产分组');
        assetGroupsToggle.title = expanded ? '收起资产分组' : '展开资产分组';
    }

    function openDrawer() {
        drawerBackdrop.hidden = false;
        drawer.setAttribute('aria-hidden', 'false');
        menuButton.setAttribute('aria-expanded', 'true');
        document.body.dataset.drawerOpen = 'true';
        const active = drawer.querySelector('[role="tab"][aria-selected="true"]');
        root.requestAnimationFrame(() => active?.focus());
    }

    function closeDrawer(restoreFocus = true) {
        if (drawer.getAttribute('aria-hidden') === 'true') {
            return false;
        }
        drawer.setAttribute('aria-hidden', 'true');
        drawerBackdrop.hidden = true;
        menuButton.setAttribute('aria-expanded', 'false');
        delete document.body.dataset.drawerOpen;
        if (restoreFocus) {
            menuButton.focus();
        }
        return true;
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
        document.getElementById('appPageTitle').textContent = pageTitles[activeTab.dataset.mode] || 'Ecryptees';
        const webComicPanel = document.getElementById('webComicSourcePanel');
        document.getElementById('appModeBadge').textContent = activeTab.dataset.mode === 'comic' && webComicPanel && !webComicPanel.hidden
            ? '网页导入需联网'
            : '本地处理';

        if (focusTab) {
            activeTab.focus();
        }
    }

    function extensionForFormat(format) {
        return format?.extension || ({
            'image/png': 'png',
            'image/jpeg': 'jpg',
            'image/gif': 'gif',
            'image/webp': 'webp',
            'image/bmp': 'bmp',
            'image/avif': 'avif',
            'image/heic': 'heic',
            'image/heif': 'heif'
        }[format?.mime] || 'img');
    }

    function originalDownloadName(name, format) {
        const extension = extensionForFormat(format);
        const baseName = String(name || 'image').replace(/\.[^.]*$/, '') || 'image';
        return sanitizeDownloadName(`${baseName}.${extension}`, extension);
    }

    function triggerBlobDownload(link) {
        if (link?.href?.startsWith('blob:')) {
            link.click();
        }
    }

    async function saveCurrentImageResult() {
        if (!currentImageResult || savedImageAssetId || !document.getElementById('saveImageToAssets').checked) {
            return savedImageAssetId;
        }
        if (!root.EcrypteesImageAssets) {
            throw new Error('图片资产功能不可用');
        }
        const asset = await root.EcrypteesImageAssets.saveImageAsset({
            blob: currentImageResult.blob,
            fileName: currentImageResult.fileName,
            mime: currentImageResult.format.mime,
            width: currentImageResult.width,
            height: currentImageResult.height
        });
        savedImageAssetId = asset.assetId;
        document.dispatchEvent(new CustomEvent('ecryptees-image-asset-saved', { detail: { asset } }));
        updateImageButtons();
        return savedImageAssetId;
    }

    function setImageSourceMode(mode) {
        const nextMode = mode === 'cipher' ? 'cipher' : 'local';
        const changed = nextMode !== imageSourceMode;
        if (changed) {
            currentImageResult = null;
            savedImageAssetId = '';
            document.getElementById('saveImageToAssets').checked = false;
            document.getElementById('decodedImageCard').hidden = true;
        }
        imageSourceMode = nextMode;
        const local = imageSourceMode === 'local';
        document.getElementById('localImageSourcePanel').hidden = !local;
        document.getElementById('sourceImageCard').hidden = !local || !selectedImage;
        document.getElementById('cipherImageSourcePanel').hidden = local;
        document.getElementById('encodeImageButton').hidden = !local;
        document.getElementById('decodeImageButton').hidden = local;
        if (local) {
            document.getElementById('decodedImageCard').hidden = true;
        }
        document.getElementById('localImageSourceButton').classList.toggle('is-active', local);
        document.getElementById('localImageSourceButton').setAttribute('aria-pressed', String(local));
        document.getElementById('cipherImageSourceButton').classList.toggle('is-active', !local);
        document.getElementById('cipherImageSourceButton').setAttribute('aria-pressed', String(!local));
        updateImageButtons();
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
                throw new Error('不支持该图片格式，请选择 PNG、JPEG、GIF、WebP、BMP、AVIF、HEIC 或 HEIF');
            }

            const animated = isAnimatedImage(bytes, format);
            let processingFile = file;
            let nativeImage = null;
            if (isHeifFormat(format) && androidMedia?.isHeicSupported()) {
                setImageStatus('正在使用 Android 系统解码 HEIC/HEIF…');
                nativeImage = await androidMedia.decodeHeic(file, { name: file.name });
                processingFile = nativeImage.file;
            }

            if (sourceImageUrl) {
                URL.revokeObjectURL(sourceImageUrl);
            }

            sourceImageUrl = URL.createObjectURL(processingFile);
            const preview = document.getElementById('sourceImagePreview');
            preview.src = sourceImageUrl;
            try {
                await preview.decode();
            } catch (error) {
                throw new Error(isHeifFormat(format)
                    ? '当前浏览器无法解码 HEIC/HEIF；请使用 Android APK 或 Safari 17 以上版本'
                    : '浏览器无法解码该图片');
            }
            const width = nativeImage?.sourceWidth || preview.naturalWidth;
            const height = nativeImage?.sourceHeight || preview.naturalHeight;
            selectedImage = { file: processingFile, sourceFile: file, bytes, format, animated, width, height };
            const dimensions = width && height ? ` · ${width}×${height}` : '';
            document.getElementById('sourceImageMeta').textContent = `${file.name} · ${format.label} · ${formatBytes(file.size)}${dimensions}${animated ? ' · 动画' : ''}`;
            document.getElementById('sourceImageCard').hidden = false;
            clearCipherTextDownload();
            currentImageResult = null;
            savedImageAssetId = '';
            document.getElementById('saveImageToAssets').checked = false;
            resetImageProgress();
            setImageStatus(animated
                ? '图片已准备好；动画及原始字节将无损写入密文。'
                : '图片已准备好，将保持原始格式和画质生成密文。');
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
            currentImageResult = null;
            savedImageAssetId = '';
            document.getElementById('saveImageToAssets').checked = false;
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
            const sourceName = selectedImage.sourceFile?.name || selectedImage.file.name;
            const originalImage = {
                file: selectedImage.sourceFile || selectedImage.file,
                bytes: selectedImage.bytes,
                format: selectedImage.format,
                metadata: {
                    name: sourceName,
                    type: selectedImage.format.mime,
                    size: selectedImage.bytes.length,
                    source: {
                        name: sourceName,
                        type: selectedImage.format.mime,
                        size: selectedImage.bytes.length,
                        width: selectedImage.width || null,
                        height: selectedImage.height || null,
                        animated: selectedImage.animated
                    }
                }
            };
            setImageProgress(10);
            setImageStatus('图片验证完成，正在计算完整性校验… 10%');
            const imageCrc32 = await calculateCrc32Chunked(originalImage.bytes, progress => {
                const overallProgress = 10 + Math.round(progress * 0.2);
                setImageProgress(overallProgress);
                setImageStatus(`正在校验原始图片… ${overallProgress}%`);
            });
            const prefix = buildImagePrefix(originalImage, imageCrc32);
            const encoded = await encodeImageByteSegmentsChunked([prefix, originalImage.bytes], progress => {
                const overallProgress = 30 + Math.round(progress * 0.67);
                setImageProgress(overallProgress);
                setImageStatus(`正在编码图片… ${overallProgress}%`);
            });

            setImageProgress(98);
            setImageStatus('正在生成密文 TXT 文件… 98%');
            await waitForNextFrame();
            const textFile = createCipherTextDownload(encoded, sourceName);
            currentImageResult = {
                blob: new Blob([selectedImage.bytes], { type: selectedImage.format.mime }),
                fileName: sourceName,
                format: selectedImage.format,
                width: selectedImage.width,
                height: selectedImage.height
            };
            await saveCurrentImageResult();
            setImageProgress(100, 'success');
            document.getElementById('imageCodeFileMeta').textContent = `${textFile.fileName} · ${formatBytes(textFile.byteLength)} · ${encoded.length.toLocaleString()} 字符`;
            setImageStatus(savedImageAssetId
                ? `无损编码完成并已保存到资产：${formatBytes(selectedImage.bytes.length)}。`
                : `无损编码完成：保留 ${formatBytes(selectedImage.bytes.length)} 原始图片字节。`, 'success');
            triggerBlobDownload(document.getElementById('downloadCipherText'));
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
            setImageStatus('正在准备原始图片… 98%');
            const originalBlob = new Blob([result.imageBytes], { type: result.format.mime });
            let previewBlob = originalBlob;
            if (isHeifFormat(result.format) && androidMedia?.isHeicSupported()) {
                previewBlob = (await androidMedia.decodeHeic(originalBlob, { name: result.metadata.name })).file;
            }
            const nextUrl = URL.createObjectURL(previewBlob);
            const downloadName = originalDownloadName(result.metadata.name, result.format);

            if (decodedImageUrl) {
                URL.revokeObjectURL(decodedImageUrl);
            }
            if (decodedImageDownloadUrl) {
                URL.revokeObjectURL(decodedImageDownloadUrl);
            }

            decodedImageUrl = nextUrl;
            decodedImageDownloadUrl = URL.createObjectURL(originalBlob);
            document.getElementById('decodedImagePreview').src = decodedImageUrl;
            document.getElementById('decodedImageMeta').textContent = `${downloadName} · ${result.format.label} · ${formatBytes(originalBlob.size)}`;
            const download = document.getElementById('downloadImage');
            download.href = decodedImageDownloadUrl;
            download.download = downloadName;
            document.getElementById('decodedImageCard').hidden = false;
            currentImageResult = {
                blob: originalBlob,
                fileName: downloadName,
                format: result.format,
                width: Number(result.metadata?.source?.width) || 0,
                height: Number(result.metadata?.source?.height) || 0
            };
            await saveCurrentImageResult();
            setImageProgress(100, 'success');
            setImageStatus(savedImageAssetId ? '图片认证成功、已按原始字节保存到资产。' : '图片认证成功，已恢复原始格式和字节。', 'success');
            triggerBlobDownload(download);
        } catch (error) {
            document.getElementById('imageProgressGroup').dataset.kind = 'error';
            setImageStatus(error.message || '图片解码失败', 'error');
        } finally {
            setImageBusy(false);
        }
    }

    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    tabs.forEach((tab, index) => {
        tab.addEventListener('click', () => {
            switchTab(tab.dataset.mode);
            closeDrawer();
        });
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
    menuButton.addEventListener('click', () => {
        if (drawer.getAttribute('aria-hidden') === 'true') {
            openDrawer();
        } else {
            closeDrawer();
        }
    });
    assetGroupsToggle.addEventListener('click', () => {
        setAssetGroupsExpanded(assetGroupsToggle.getAttribute('aria-expanded') !== 'true');
    });
    document.getElementById('drawerComicAssetsButton').addEventListener('click', () => {
        document.getElementById('assetTypeComicButton').click();
        closeDrawer();
    });
    document.getElementById('drawerImageAssetsButton').addEventListener('click', () => {
        document.getElementById('historyTab').click();
        document.getElementById('assetTypeImageButton').click();
        closeDrawer();
    });
    drawerBackdrop.addEventListener('click', () => closeDrawer());
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && closeDrawer()) {
            event.preventDefault();
        }
    });
    root.EcrypteesAppNavigation = Object.freeze({ closeDrawer });

    const imageFileInput = document.getElementById('imageFile');
    imageFileInput.addEventListener('change', handleImageSelection);
    document.querySelector('.file-picker').addEventListener('keydown', event => {
        if ((event.key === 'Enter' || event.key === ' ') && !imageFileInput.disabled) {
            event.preventDefault();
            imageFileInput.click();
        }
    });

    document.getElementById('localImageSourceButton').addEventListener('click', () => setImageSourceMode('local'));
    document.getElementById('cipherImageSourceButton').addEventListener('click', () => setImageSourceMode('cipher'));
    document.getElementById('saveImageToAssets').addEventListener('change', async event => {
        if (!event.currentTarget.checked || !currentImageResult || savedImageAssetId) {
            updateImageButtons();
            return;
        }
        try {
            setImageBusy(true);
            await saveCurrentImageResult();
            setImageStatus('图片已保存到资产。', 'success');
        } catch (error) {
            event.currentTarget.checked = false;
            setImageStatus(error.message || '图片资产保存失败', 'error');
        } finally {
            setImageBusy(false);
        }
    });
    document.getElementById('viewSavedImageButton').addEventListener('click', () => {
        if (savedImageAssetId) {
            root.EcrypteesImageAssetsUI?.openAsset(savedImageAssetId);
        }
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
        if (cipherTextDownloadUrl) {
            URL.revokeObjectURL(cipherTextDownloadUrl);
        }
        if (decodedImageUrl) {
            URL.revokeObjectURL(decodedImageUrl);
        }
        if (decodedImageDownloadUrl) {
            URL.revokeObjectURL(decodedImageDownloadUrl);
        }
    });

    document.getElementById('copyTextCodeButton').addEventListener('click', () => {
        copyCipherText('inputCode', 'copyTextCodeButton', '文本密文');
    });
    document.getElementById('encodeTextButton').addEventListener('click', encode);
    document.getElementById('decodeTextButton').addEventListener('click', decode);
    document.getElementById('encodeImageButton').addEventListener('click', encodeImage);
    document.getElementById('decodeImageButton').addEventListener('click', decodeImage);
    setImageSourceMode('local');
    updateImageButtons();
})(globalThis);
