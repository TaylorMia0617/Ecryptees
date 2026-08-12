(function () {
    'use strict';

    const bridge = globalThis.AndroidFileBridge;
    if (!bridge) return;

    const ECOMIC_MIME_TYPE = 'application/vnd.ecryptees.ecomic';
    const MAX_INCOMING_ARCHIVE_BYTES = 512 * 1024 * 1024;
    const INCOMING_CHUNK_BYTES = 768 * 1024;
    const ECOMIC_MAGIC = Uint8Array.from([0x45, 0x43, 0x52, 0x43, 0x4F, 0x4D, 0x31, 0x00]);
    let statusElement = null;
    let pendingDownload = null;
    let incomingBusy = false;

    function emitDownloadResult(status, fallback = {}) {
        const download = fallback.url ? fallback : pendingDownload;
        if (!download.url) {
            return;
        }
        document.dispatchEvent(new CustomEvent('ecryptees-download-result', {
            detail: {
                url: download.url,
                name: download.name || '',
                status
            }
        }));
        if (pendingDownload?.url === download.url) {
            pendingDownload = null;
        }
    }

    function showStatus(message, kind = 'info', temporary = false) {
        if (!statusElement) {
            statusElement = document.createElement('div');
            statusElement.className = 'android-download-status';
            statusElement.setAttribute('role', 'status');
            statusElement.setAttribute('aria-live', 'polite');
            document.body.append(statusElement);
        }
        statusElement.textContent = message;
        statusElement.dataset.kind = kind;
        statusElement.hidden = false;
        if (temporary) {
            globalThis.setTimeout(() => {
                statusElement.hidden = true;
            }, 3500);
        }
    }

    function inferMimeType(name) {
        const lower = String(name || '').toLowerCase();
        if (lower.endsWith('.png')) return 'image/png';
        if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
        if (lower.endsWith('.gif')) return 'image/gif';
        if (lower.endsWith('.webp')) return 'image/webp';
        if (lower.endsWith('.bmp')) return 'image/bmp';
        if (lower.endsWith('.avif')) return 'image/avif';
        if (lower.endsWith('.heic')) return 'image/heic';
        if (lower.endsWith('.heif')) return 'image/heif';
        if (lower.endsWith('.txt')) return 'text/plain';
        if (lower.endsWith('.ecomic')) return ECOMIC_MIME_TYPE;
        return 'application/octet-stream';
    }

    function encodeBase64(bytes) {
        let binary = '';
        const step = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += step) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
        }
        return btoa(binary);
    }

    function decodeBase64(value) {
        const binary = atob(value);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) {
            bytes[index] = binary.charCodeAt(index);
        }
        return bytes;
    }

    function hasEcomicMagic(file) {
        return file.slice(0, ECOMIC_MAGIC.length).arrayBuffer().then(buffer => {
            const bytes = new Uint8Array(buffer);
            return bytes.length === ECOMIC_MAGIC.length
                && bytes.every((value, index) => value === ECOMIC_MAGIC[index]);
        });
    }

    async function receiveIncomingDocument() {
        if (incomingBusy || typeof bridge.claimIncomingDocument !== 'function') {
            return;
        }
        if (document.body.dataset.lockState !== 'unlocked') {
            const security = globalThis.EcrypteesAppSecurity;
            if (security?.whenUnlocked) {
                await security.whenUnlocked;
            } else {
                await new Promise(resolve => document.addEventListener('ecryptees-app-unlocked', resolve, { once: true }));
            }
        }
        let metadata;
        try {
            const encoded = bridge.claimIncomingDocument();
            if (!encoded) {
                return;
            }
            metadata = JSON.parse(encoded);
        } catch (error) {
            showStatus('无法读取外部漫画归档。', 'error', true);
            return;
        }
        const token = String(metadata.token || '');
        const name = String(metadata.name || '');
        const expectedSize = Number(metadata.size);
        incomingBusy = true;
        let storageRoot;
        let writable;
        let entryName = '';
        try {
            if (!token || !name.toLowerCase().endsWith('.ecomic')) {
                throw new Error('只能打开 .ecomic 文件');
            }
            if (Number.isFinite(expectedSize)
                && (expectedSize === 0 || expectedSize > MAX_INCOMING_ARCHIVE_BYTES)) {
                throw new Error('该 .ecomic 文件为空或超过大小限制');
            }
            if (!globalThis.navigator.storage?.getDirectory) {
                throw new Error('当前 Android System WebView 不支持安全导入外部归档');
            }
            storageRoot = await globalThis.navigator.storage.getDirectory();
            entryName = `ecryptees-temp-incoming-${token.replace(/[^a-z0-9-]/gi, '')}.ecomic`;
            const handle = await storageRoot.getFileHandle(entryName, { create: true });
            writable = await handle.createWritable();
            let received = 0;
            showStatus(`正在打开 ${name}…`);
            while (true) {
                const encoded = bridge.readIncomingChunk(token, INCOMING_CHUNK_BYTES);
                if (encoded === null || encoded === undefined) {
                    throw new Error('外部 .ecomic 文件读取失败');
                }
                if (!encoded) {
                    break;
                }
                const bytes = decodeBase64(encoded);
                received += bytes.byteLength;
                if (received > MAX_INCOMING_ARCHIVE_BYTES
                    || (Number.isFinite(expectedSize) && expectedSize >= 0 && received > expectedSize)) {
                    throw new Error('该 .ecomic 文件超过大小限制');
                }
                await writable.write(bytes);
                if (expectedSize > 0) {
                    showStatus(`正在打开 ${name}… ${Math.min(100, Math.round(received / expectedSize * 100))}%`);
                }
            }
            if (expectedSize >= 0 && received !== expectedSize) {
                throw new Error('外部 .ecomic 文件读取不完整');
            }
            await writable.close();
            writable = null;
            if (!bridge.finishIncomingDocument(token)) {
                throw new Error('外部 .ecomic 文件读取未完成');
            }
            const stored = await handle.getFile();
            if (!(await hasEcomicMagic(stored))) {
                throw new Error('该文件后缀为 .ecomic，但内容不是有效的漫画归档');
            }
            const file = new File([stored], name, {
                type: ECOMIC_MIME_TYPE,
                lastModified: stored.lastModified
            });
            showStatus(`正在验证 ${name}…`, 'success', true);
            document.dispatchEvent(new CustomEvent('ecryptees-open-archive', {
                detail: { file, opfsName: entryName }
            }));
            entryName = '';
        } catch (error) {
            try {
                await writable?.abort(error);
            } catch (abortError) {
                // Preserve the original import failure.
            }
            try {
                bridge.abortIncomingDocument(token);
            } catch (abortError) {
                // Android also closes the stream when the activity is destroyed.
            }
            showStatus(error.message || '无法打开外部漫画归档', 'error', true);
        } finally {
            if (storageRoot && entryName) {
                try {
                    await storageRoot.removeEntry(entryName);
                } catch (cleanupError) {
                    // Cold-start temporary cleanup is the final fallback.
                }
            }
            incomingBusy = false;
            globalThis.setTimeout(receiveIncomingDocument, 0);
        }
    }

    globalThis.EcrypteesAndroidIncoming = Object.freeze({
        receive: receiveIncomingDocument
    });

    const mediaWaiters = [];
    let activeMediaTasks = 0;

    async function acquireMediaSlot() {
        if (activeMediaTasks < 2) {
            activeMediaTasks += 1;
            return;
        }
        await new Promise(resolve => mediaWaiters.push(resolve));
        activeMediaTasks += 1;
    }

    function releaseMediaSlot() {
        activeMediaTasks = Math.max(0, activeMediaTasks - 1);
        mediaWaiters.shift()?.();
    }

    function waitForNativeStatus() {
        return new Promise(resolve => globalThis.setTimeout(resolve, 40));
    }

    function isHeicSupported() {
        try {
            return typeof bridge.isHeicDecodeSupported === 'function' && bridge.isHeicDecodeSupported();
        } catch (error) {
            return false;
        }
    }

    async function decodeHeicNow(source, options = {}) {
        if (!(source instanceof Blob) || !isHeicSupported()) {
            throw new Error('当前 Android 设备不支持 HEIC/HEIF 解码');
        }
        const name = String(options.name || source.name || 'image.heic');
        const maxDimension = Math.max(0, Math.min(4096, Math.trunc(Number(options.maxDimension) || 0)));
        const token = bridge.beginHeicDecode(name);
        if (!token) {
            throw new Error('无法启动 HEIC/HEIF 解码');
        }
        try {
            const chunkSize = 768 * 1024;
            for (let offset = 0; offset < source.size; offset += chunkSize) {
                if (options.signal?.aborted) {
                    throw new DOMException('操作已取消', 'AbortError');
                }
                const bytes = new Uint8Array(await source
                    .slice(offset, Math.min(source.size, offset + chunkSize))
                    .arrayBuffer());
                if (!bridge.writeHeicChunk(token, encodeBase64(bytes))) {
                    throw new Error('HEIC/HEIF 临时文件写入失败');
                }
            }
            if (!bridge.commitHeicDecode(token, maxDimension)) {
                throw new Error('HEIC/HEIF 解码任务提交失败');
            }
            let info;
            while (true) {
                if (options.signal?.aborted) {
                    throw new DOMException('操作已取消', 'AbortError');
                }
                info = JSON.parse(bridge.getHeicDecodeStatus(token));
                if (info.state === 'ready') {
                    break;
                }
                if (info.state === 'error' || info.state === 'cancelled' || !info.state) {
                    throw new Error(info.error || 'HEIC/HEIF 解码失败');
                }
                await waitForNativeStatus();
            }
            if (!Number.isSafeInteger(info.size) || info.size <= 0) {
                throw new Error(info.error || 'HEIC/HEIF 解码结果无效');
            }
            const parts = [];
            for (let offset = 0; offset < info.size; offset += chunkSize) {
                if (options.signal?.aborted) {
                    throw new DOMException('操作已取消', 'AbortError');
                }
                const encoded = bridge.readHeicChunk(token, offset, Math.min(chunkSize, info.size - offset));
                if (!encoded) {
                    throw new Error('HEIC/HEIF 解码结果读取失败');
                }
                parts.push(decodeBase64(encoded));
            }
            return {
                file: new File(parts, name.replace(/\.(?:heic|heif)$/i, '') + '.png', { type: 'image/png' }),
                width: Number(info.width) || 0,
                height: Number(info.height) || 0,
                sourceWidth: Number(info.sourceWidth) || Number(info.width) || 0,
                sourceHeight: Number(info.sourceHeight) || Number(info.height) || 0
            };
        } catch (error) {
            try {
                bridge.abortHeicDecode(token);
            } catch (abortError) {
                // Preserve the original decode failure.
            }
            throw error;
        } finally {
            try {
                bridge.releaseHeicDecode(token);
            } catch (releaseError) {
                // Android will also clean stale decode files on the next launch.
            }
        }
    }

    async function decodeHeic(source, options) {
        await acquireMediaSlot();
        try {
            return await decodeHeicNow(source, options);
        } finally {
            releaseMediaSlot();
        }
    }

    globalThis.EcrypteesAndroidMedia = Object.freeze({
        isHeicSupported,
        decodeHeic
    });

    document.addEventListener('click', event => {
        const link = event.target instanceof Element ? event.target.closest('a[download]') : null;
        if (!link || !link.href.startsWith('blob:') || link.getAttribute('aria-disabled') === 'true') {
            return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        const name = link.download || 'download.bin';
        const accepted = bridge.beginDownload(name, inferMimeType(name), link.href);
        if (accepted) {
            pendingDownload = { url: link.href, name };
        } else {
            showStatus('当前文件尚未保存完成，请稍后再试。', 'error', true);
            emitDownloadResult('failed', { url: link.href, name });
        }
    }, true);

    globalThis.EcrypteesAndroidDownload = Object.freeze({
        async stream(token, blobUrl, name) {
            let reader;
            let received = 0;
            try {
                const response = await fetch(blobUrl);
                if (!response.ok || !response.body) {
                    throw new Error('无法读取待保存文件');
                }
                const total = Number(response.headers.get('content-length')) || 0;
                reader = response.body.getReader();
                showStatus(`正在保存 ${name}…`);
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    if (!bridge.writeChunk(token, encodeBase64(value))) {
                        throw new Error('Android 文件写入失败');
                    }
                    received += value.byteLength;
                    if (total > 0) {
                        showStatus(`正在保存 ${name}… ${Math.min(100, Math.round(received / total * 100))}%`);
                    }
                }
                if (!bridge.finishDownload(token)) {
                    throw new Error('Android 文件收尾失败');
                }
                showStatus(`${name} 已保存`, 'success', true);
                emitDownloadResult('success', { url: blobUrl, name });
            } catch (error) {
                try {
                    await reader?.cancel(error);
                } catch (cancelError) {
                    // Preserve the original failure.
                }
                bridge.abortDownload(token);
                showStatus(error.message || '文件保存失败', 'error', true);
                emitDownloadResult('failed', { url: blobUrl, name });
            }
        },
        cancelled() {
            showStatus('已取消保存', 'info', true);
            emitDownloadResult('cancelled');
        },
        failed() {
            showStatus('文件保存失败，请检查剩余空间后重试。', 'error', true);
            emitDownloadResult('failed');
        }
    });
})();
