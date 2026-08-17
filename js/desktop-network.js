(function (root) {
    'use strict';

    const tauri = root.__TAURI__;
    const available = !!root.__TAURI_INTERNALS__ && !!tauri?.core?.invoke;
    const MAX_CHUNK_BYTES = 1024 * 1024;

    function invoke(command, payload) {
        if (!available) {
            return Promise.reject(new Error('当前环境不是 Ecryptees Windows 桌面版'));
        }
        return tauri.core.invoke(command, payload);
    }

    function normalizeBytes(value) {
        if (value instanceof Uint8Array) {
            return value;
        }
        if (value instanceof ArrayBuffer) {
            return new Uint8Array(value);
        }
        if (ArrayBuffer.isView(value)) {
            return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        }
        if (Array.isArray(value)) {
            return Uint8Array.from(value);
        }
        return new Uint8Array(0);
    }

    async function beginRemoteFetch(url, kind, referer = '') {
        return invoke('begin_desktop_network_fetch', {
            url: String(url || ''),
            kind: String(kind || ''),
            referer: String(referer || '')
        });
    }

    async function getRemoteFetchStatus(token) {
        return invoke('get_desktop_network_status', { token: String(token || '') });
    }

    async function readRemoteFetchChunk(token, requestedBytes, offset) {
        const bytes = await invoke('read_desktop_network_chunk', {
            token: String(token || ''),
            offset: Math.max(0, Number(offset) || 0),
            requestedBytes: Math.min(MAX_CHUNK_BYTES, Math.max(1, Number(requestedBytes) || MAX_CHUNK_BYTES))
        });
        return normalizeBytes(bytes);
    }

    async function cancelRemoteFetch(token) {
        return invoke('cancel_desktop_network_fetch', { token: String(token || '') });
    }

    async function releaseRemoteFetch(token) {
        return invoke('release_desktop_network_fetch', { token: String(token || '') });
    }

    async function beginRenderedPageCapture(url, maximum, interactiveVerification = false) {
        return invoke('begin_desktop_rendered_page_capture', {
            url: String(url || ''),
            maximum: Math.min(80, Math.max(1, Number(maximum) || 80)),
            interactiveVerification: interactiveVerification === true
        });
    }

    async function getRenderedPageCaptureStatus(token) {
        return invoke('get_desktop_rendered_page_capture_status', { token: String(token || '') });
    }

    async function readRenderedPageImageChunk(token, index, requestedBytes, offset) {
        const bytes = await invoke('read_desktop_rendered_page_image_chunk', {
            token: String(token || ''),
            index: Math.max(0, Number(index) || 0),
            offset: Math.max(0, Number(offset) || 0),
            requestedBytes: Math.min(MAX_CHUNK_BYTES, Math.max(1, Number(requestedBytes) || MAX_CHUNK_BYTES))
        });
        return normalizeBytes(bytes);
    }

    async function releaseRenderedPageCapture(token) {
        return invoke('release_desktop_rendered_page_capture', { token: String(token || '') });
    }

    root.EcrypteesDesktopNetwork = Object.freeze({
        available,
        beginRemoteFetch,
        getRemoteFetchStatus,
        readRemoteFetchChunk,
        cancelRemoteFetch,
        releaseRemoteFetch,
        beginRenderedPageCapture,
        getRenderedPageCaptureStatus,
        readRenderedPageImageChunk,
        releaseRenderedPageCapture
    });
})(globalThis);
