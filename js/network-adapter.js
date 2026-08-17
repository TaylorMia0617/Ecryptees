(function (root) {
    'use strict';

    const MAX_CHUNK_BYTES = 1024 * 1024;
    const isAndroidRuntime = !!root.AndroidFileBridge || /EcrypteesAndroid\//.test(root.navigator?.userAgent || '');
    const androidNetwork = isAndroidRuntime ? root.AndroidNetworkBridge : null;
    const desktopNetwork = !isAndroidRuntime && root.EcrypteesDesktopNetwork?.available
        ? root.EcrypteesDesktopNetwork
        : null;
    const backend = androidNetwork || desktopNetwork;
    const platform = androidNetwork ? 'android' : (desktopNetwork ? 'windows' : 'browser');

    function normalizeRequestedBytes(value) {
        return Math.min(MAX_CHUNK_BYTES, Math.max(1, Number(value) || MAX_CHUNK_BYTES));
    }

    function normalizeOffset(value) {
        return Math.max(0, Number(value) || 0);
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

    function decodeBase64Bytes(value) {
        const encoded = String(value || '');
        if (!encoded) {
            return new Uint8Array(0);
        }
        const binary = root.atob(encoded);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
        }
        return bytes;
    }

    function requireBackend() {
        if (!backend) {
            throw new Error('当前环境没有可用的原生网络桥');
        }
        return backend;
    }

    async function beginRemoteFetch(url, kind, referer = '') {
        return requireBackend().beginRemoteFetch(
            String(url || ''),
            String(kind || ''),
            String(referer || '')
        );
    }

    async function getRemoteFetchStatus(token) {
        return requireBackend().getRemoteFetchStatus(String(token || ''));
    }

    async function readRemoteFetchChunk(token, requestedBytes, offset) {
        const network = requireBackend();
        const length = normalizeRequestedBytes(requestedBytes);
        const position = normalizeOffset(offset);
        const value = platform === 'android'
            ? await network.readRemoteFetchChunk(String(token || ''), length)
            : await network.readRemoteFetchChunk(String(token || ''), length, position);
        return platform === 'android' ? decodeBase64Bytes(value) : normalizeBytes(value);
    }

    async function cancelRemoteFetch(token) {
        return requireBackend().cancelRemoteFetch(String(token || ''));
    }

    async function releaseRemoteFetch(token) {
        return requireBackend().releaseRemoteFetch(String(token || ''));
    }

    async function beginRenderedPageCapture(url, maximum, interactiveVerification = false) {
        const network = requireBackend();
        const limit = Math.min(80, Math.max(1, Number(maximum) || 80));
        if (platform === 'android') {
            return network.beginRenderedPageCapture(String(url || ''), limit);
        }
        return network.beginRenderedPageCapture(
            String(url || ''),
            limit,
            interactiveVerification === true
        );
    }

    async function getRenderedPageCaptureStatus(token) {
        return requireBackend().getRenderedPageCaptureStatus(String(token || ''));
    }

    async function readRenderedPageImageChunk(token, index, requestedBytes, offset) {
        const network = requireBackend();
        const imageIndex = Math.max(0, Number(index) || 0);
        const length = normalizeRequestedBytes(requestedBytes);
        const position = normalizeOffset(offset);
        const value = platform === 'android'
            ? await network.readRenderedPageImageChunk(String(token || ''), imageIndex, position, length)
            : await network.readRenderedPageImageChunk(String(token || ''), imageIndex, length, position);
        return platform === 'android' ? decodeBase64Bytes(value) : normalizeBytes(value);
    }

    async function releaseRenderedPageCapture(token) {
        return requireBackend().releaseRenderedPageCapture(String(token || ''));
    }

    root.EcrypteesNetworkAdapter = Object.freeze({
        available: !!backend,
        platform,
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
