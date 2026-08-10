(function () {
    'use strict';

    const bridge = globalThis.AndroidFileBridge;
    if (!bridge) return;

    let statusElement = null;

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
        if (lower.endsWith('.txt')) return 'text/plain';
        if (lower.endsWith('.ecomic')) return 'application/octet-stream';
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

    let mediaQueue = Promise.resolve();

    function queueMediaTask(task) {
        const result = mediaQueue.then(task, task);
        mediaQueue = result.catch(() => {});
        return result;
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
        let outputToken = '';
        try {
            const chunkSize = 768 * 1024;
            for (let offset = 0; offset < source.size; offset += chunkSize) {
                const bytes = new Uint8Array(await source
                    .slice(offset, Math.min(source.size, offset + chunkSize))
                    .arrayBuffer());
                if (!bridge.writeHeicChunk(token, encodeBase64(bytes))) {
                    throw new Error('HEIC/HEIF 临时文件写入失败');
                }
            }
            const info = JSON.parse(bridge.finishHeicDecode(token, maxDimension));
            if (!info.ok || !info.token || !Number.isSafeInteger(info.size) || info.size <= 0) {
                throw new Error(info.error || 'HEIC/HEIF 解码失败');
            }
            outputToken = info.token;
            const parts = [];
            for (let offset = 0; offset < info.size; offset += chunkSize) {
                const encoded = bridge.readHeicChunk(outputToken, offset, Math.min(chunkSize, info.size - offset));
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
            if (outputToken) {
                try {
                    bridge.releaseHeicDecode(outputToken);
                } catch (releaseError) {
                    // Android will also clean stale decode files on the next launch.
                }
            }
        }
    }

    globalThis.EcrypteesAndroidMedia = Object.freeze({
        isHeicSupported,
        decodeHeic(source, options) {
            return queueMediaTask(() => decodeHeicNow(source, options));
        }
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
        if (!accepted) {
            showStatus('当前文件尚未保存完成，请稍后再试。', 'error', true);
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
            } catch (error) {
                try {
                    await reader?.cancel(error);
                } catch (cancelError) {
                    // Preserve the original failure.
                }
                bridge.abortDownload(token);
                showStatus(error.message || '文件保存失败', 'error', true);
            }
        },
        cancelled() {
            showStatus('已取消保存', 'info', true);
        },
        failed() {
            showStatus('文件保存失败，请检查剩余空间后重试。', 'error', true);
        }
    });
})();
