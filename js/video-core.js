(function (root) {
    'use strict';

    const MAGIC = Uint8Array.from([0x45, 0x43, 0x52, 0x56, 0x49, 0x44, 0x31, 0x00]);
    const VERSION = 1;
    const KEY_MODE_BUILTIN = 0;
    const KDF_HKDF_SHA256 = 1;
    const CIPHER_AES_256_GCM = 1;
    const HEADER_SIZE = 160;
    const CHUNK_SIZE = 1024 * 1024;
    const AUTH_TAG_SIZE = 16;
    const SALT_SIZE = 16;
    const WRAP_NONCE_SIZE = 12;
    const NONCE_PREFIX_SIZE = 8;
    const KEY_ID_SIZE = 8;
    const CONTENT_KEY_SIZE = 32;
    const WRAPPED_KEY_SIZE = CONTENT_KEY_SIZE + AUTH_TAG_SIZE;
    const WRAPPED_KEY_OFFSET = 96;
    const MANIFEST_LIMIT = 64 * 1024;
    const MAX_TOTAL_BYTES = 64 * 1024 * 1024 * 1024;
    const EXTENSION = 'emp4';
    const MIME_TYPE = 'application/vnd.ecryptees.emp4';
    const VIDEO_MIME_TYPE = 'video/mp4';
    const HKDF_INFO = new TextEncoder().encode('Ecryptees Video KEK v1');

    class VideoError extends Error {
        constructor(code, message) {
            super(message);
            this.name = 'VideoError';
            this.code = code;
        }
    }

    function getCrypto() {
        if (!root.crypto?.subtle) {
            throw new VideoError('CRYPTO_UNAVAILABLE', '当前环境不支持 Web Crypto');
        }
        return root.crypto;
    }

    function asBytes(value, length, label = '字段') {
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || 0);
        if (length !== undefined && bytes.length !== length) {
            throw new VideoError('INVALID_FIELD', `${label}长度无效`);
        }
        return bytes;
    }

    function equalBytes(left, right) {
        if (left.length !== right.length) return false;
        let different = 0;
        for (let index = 0; index < left.length; index++) different |= left[index] ^ right[index];
        return different === 0;
    }

    function allZero(bytes) {
        let combined = 0;
        for (const byte of bytes) combined |= byte;
        return combined === 0;
    }

    function setUint64(view, offset, value) {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new VideoError('INVALID_SIZE', '视频大小无效');
        }
        view.setUint32(offset, Math.floor(value / 0x100000000), false);
        view.setUint32(offset + 4, value >>> 0, false);
    }

    function getUint64(view, offset) {
        const value = view.getUint32(offset, false) * 0x100000000 + view.getUint32(offset + 4, false);
        if (!Number.isSafeInteger(value)) throw new VideoError('INVALID_SIZE', '视频大小超出支持范围');
        return value;
    }

    function normalizeName(value, fallback) {
        const name = String(value || fallback).replace(/[\\/:*?"<>|\u0000-\u001F\u007F]/g, '_').trim();
        return Array.from(name || fallback).slice(0, 180).join('');
    }

    function getChunkCount(size, chunkSize = CHUNK_SIZE) {
        return Math.ceil(size / chunkSize);
    }

    function getChunkPlainLength(totalSize, chunkIndex, chunkSize = CHUNK_SIZE) {
        if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= getChunkCount(totalSize, chunkSize)) {
            throw new VideoError('INVALID_CHUNK', '视频分块序号无效');
        }
        return Math.min(chunkSize, totalSize - chunkIndex * chunkSize);
    }

    function createManifest(file, title = '') {
        const size = Number(file?.size);
        if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_TOTAL_BYTES) {
            throw new VideoError('INVALID_SIZE', 'MP4 不能为空或超过 64 GiB');
        }
        const originalName = normalizeName(file?.name, 'video.mp4');
        return Object.freeze({
            version: VERSION,
            title: normalizeName(title || originalName.replace(/\.mp4$/i, ''), '视频'),
            originalName: /\.mp4$/i.test(originalName) ? originalName : `${originalName}.mp4`,
            mime: VIDEO_MIME_TYPE,
            size,
            lastModified: Number.isSafeInteger(file?.lastModified) && file.lastModified >= 0 ? file.lastModified : 0,
            createdAt: Date.now(),
            chunkCount: getChunkCount(size)
        });
    }

    function encodeManifest(manifest) {
        const bytes = new TextEncoder().encode(JSON.stringify(manifest));
        if (!bytes.length || bytes.length > MANIFEST_LIMIT) {
            throw new VideoError('INVALID_MANIFEST', '视频清单大小无效');
        }
        return bytes;
    }

    function decodeManifest(value) {
        try {
            return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(asBytes(value)));
        } catch (error) {
            throw new VideoError('INVALID_MANIFEST', '视频清单已损坏');
        }
    }

    function encodeHeader(options) {
        const keyMode = Number(options.keyMode);
        if (keyMode !== KEY_MODE_BUILTIN) throw new VideoError('INVALID_KEY_MODE', '仅支持内置密钥模式');
        const totalPlainSize = Number(options.totalPlainSize);
        const manifestCipherLength = Number(options.manifestCipherLength);
        const chunkCount = getChunkCount(totalPlainSize);
        const iterations = 0;
        if (!Number.isSafeInteger(totalPlainSize) || totalPlainSize <= 0 || totalPlainSize > MAX_TOTAL_BYTES) {
            throw new VideoError('INVALID_SIZE', '视频大小无效');
        }
        if (!Number.isInteger(manifestCipherLength)
            || manifestCipherLength <= AUTH_TAG_SIZE
            || manifestCipherLength > MANIFEST_LIMIT + AUTH_TAG_SIZE) {
            throw new VideoError('INVALID_MANIFEST', '视频清单长度无效');
        }
        const header = new Uint8Array(HEADER_SIZE);
        const view = new DataView(header.buffer);
        header.set(MAGIC, 0);
        view.setUint8(8, VERSION);
        view.setUint8(9, keyMode);
        view.setUint8(10, KDF_HKDF_SHA256);
        view.setUint8(11, CIPHER_AES_256_GCM);
        view.setUint32(12, 0, false);
        view.setUint32(16, HEADER_SIZE, false);
        view.setUint32(20, CHUNK_SIZE, false);
        view.setUint32(24, manifestCipherLength, false);
        view.setUint32(28, chunkCount, false);
        setUint64(view, 32, totalPlainSize);
        view.setUint32(40, iterations, false);
        header.set(asBytes(options.salt, SALT_SIZE, 'salt'), 48);
        header.set(asBytes(options.wrapNonce, WRAP_NONCE_SIZE, '包装 nonce'), 64);
        header.set(asBytes(options.noncePrefix, NONCE_PREFIX_SIZE, '内容 nonce'), 80);
        header.set(asBytes(options.keyId, KEY_ID_SIZE, 'keyId'), 88);
        header.set(asBytes(options.wrappedKey || new Uint8Array(WRAPPED_KEY_SIZE), WRAPPED_KEY_SIZE, '包装密钥'), WRAPPED_KEY_OFFSET);
        return header;
    }

    function decodeHeader(value) {
        const source = asBytes(value);
        if (source.length < HEADER_SIZE) throw new VideoError('TRUNCATED_HEADER', '.emp4 文件头不完整');
        const bytes = source.slice(0, HEADER_SIZE);
        if (!equalBytes(bytes.subarray(0, MAGIC.length), MAGIC)) {
            throw new VideoError('BAD_MAGIC', '这不是有效的 Ecryptees 视频文件');
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const keyMode = view.getUint8(9);
        if (view.getUint8(8) !== VERSION) throw new VideoError('UNSUPPORTED_VERSION', '不支持该 .emp4 版本');
        if (keyMode !== KEY_MODE_BUILTIN
            || view.getUint8(10) !== KDF_HKDF_SHA256 || view.getUint8(11) !== CIPHER_AES_256_GCM) {
            throw new VideoError('UNSUPPORTED_CRYPTO', '不支持该 .emp4 加密参数');
        }
        if (view.getUint32(12, false) !== 0
            || view.getUint32(16, false) !== HEADER_SIZE
            || view.getUint32(20, false) !== CHUNK_SIZE
            || !allZero(bytes.subarray(44, 48))
            || !allZero(bytes.subarray(76, 80))
            || !allZero(bytes.subarray(144, 160))) {
            throw new VideoError('UNSUPPORTED_OPTIONS', '不支持该 .emp4 容器参数');
        }
        const manifestCipherLength = view.getUint32(24, false);
        const chunkCount = view.getUint32(28, false);
        const totalPlainSize = getUint64(view, 32);
        const iterations = view.getUint32(40, false);
        if (manifestCipherLength <= AUTH_TAG_SIZE || manifestCipherLength > MANIFEST_LIMIT + AUTH_TAG_SIZE
            || totalPlainSize <= 0 || totalPlainSize > MAX_TOTAL_BYTES
            || chunkCount !== getChunkCount(totalPlainSize)
            || iterations !== 0) {
            throw new VideoError('INVALID_HEADER', '.emp4 文件头参数无效');
        }
        return Object.freeze({
            bytes,
            version: VERSION,
            keyMode,
            iterations,
            manifestCipherLength,
            chunkCount,
            totalPlainSize,
            salt: bytes.slice(48, 64),
            wrapNonce: bytes.slice(64, 76),
            noncePrefix: bytes.slice(80, 88),
            keyId: bytes.slice(88, 96),
            wrappedKey: bytes.slice(96, 144),
            dataOffset: HEADER_SIZE + manifestCipherLength
        });
    }

    function createWrapAad(headerValue) {
        const aad = asBytes(headerValue, HEADER_SIZE, 'header').slice();
        aad.fill(0, WRAPPED_KEY_OFFSET, WRAPPED_KEY_OFFSET + WRAPPED_KEY_SIZE);
        return aad;
    }

    function createNonce(prefix, counter) {
        if (!Number.isInteger(counter) || counter < 0 || counter > 0xFFFFFFFF) {
            throw new VideoError('INVALID_COUNTER', '视频分块计数器无效');
        }
        const nonce = new Uint8Array(12);
        nonce.set(asBytes(prefix, NONCE_PREFIX_SIZE, 'nonce'), 0);
        new DataView(nonce.buffer).setUint32(8, counter, false);
        return nonce;
    }

    function createChunkAad(headerValue, counter, plainLength) {
        if (!Number.isInteger(plainLength) || plainLength < 0
            || plainLength > (counter === 0 ? MANIFEST_LIMIT : CHUNK_SIZE)) {
            throw new VideoError('INVALID_CHUNK', '视频分块长度无效');
        }
        const header = asBytes(headerValue, HEADER_SIZE, 'header');
        const aad = new Uint8Array(HEADER_SIZE + 8);
        aad.set(header);
        const view = new DataView(aad.buffer);
        view.setUint32(HEADER_SIZE, counter, false);
        view.setUint32(HEADER_SIZE + 4, plainLength, false);
        return aad;
    }

    async function getBuiltinKeyId(source) {
        const digest = new Uint8Array(await getCrypto().subtle.digest('SHA-256', asBytes(source)));
        return digest.slice(0, KEY_ID_SIZE);
    }

    async function deriveKek(options) {
        const cryptoProvider = getCrypto();
        if (options.keyMode !== KEY_MODE_BUILTIN) {
            throw new VideoError('INVALID_KEY_MODE', '仅支持内置密钥模式');
        }
        const source = asBytes(options.builtinSource);
        if (!source.length) throw new VideoError('KEY_UNAVAILABLE', '内置密钥材料不可用');
        const material = await cryptoProvider.subtle.importKey('raw', source, 'HKDF', false, ['deriveKey']);
        return cryptoProvider.subtle.deriveKey({
            name: 'HKDF', hash: 'SHA-256', salt: asBytes(options.salt, SALT_SIZE, 'salt'), info: HKDF_INFO
        }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    }

    async function wrapContentKey(kek, rawKey, headerValue, wrapNonce) {
        const result = await getCrypto().subtle.encrypt({
            name: 'AES-GCM', iv: asBytes(wrapNonce, WRAP_NONCE_SIZE, '包装 nonce'),
            additionalData: createWrapAad(headerValue), tagLength: 128
        }, kek, asBytes(rawKey, CONTENT_KEY_SIZE, '内容密钥'));
        return new Uint8Array(result);
    }

    async function unwrapContentKey(kek, header) {
        try {
            const result = await getCrypto().subtle.decrypt({
                name: 'AES-GCM', iv: header.wrapNonce,
                additionalData: createWrapAad(header.bytes), tagLength: 128
            }, kek, header.wrappedKey);
            return new Uint8Array(result);
        } catch (error) {
            throw new VideoError('KEY_MISMATCH', '内置密钥不匹配或 .emp4 文件已损坏');
        }
    }

    function importContentKey(rawKey) {
        return getCrypto().subtle.importKey(
            'raw', asBytes(rawKey, CONTENT_KEY_SIZE, '内容密钥'),
            { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
        );
    }

    async function cryptChunk(operation, key, header, counter, value, plainLength) {
        const bytes = asBytes(value);
        if (operation === 'decrypt' && bytes.length !== plainLength + AUTH_TAG_SIZE) {
            throw new VideoError('INVALID_CHUNK', '视频加密分块长度不完整');
        }
        try {
            const result = await getCrypto().subtle[operation]({
                name: 'AES-GCM', iv: createNonce(header.noncePrefix, counter),
                additionalData: createChunkAad(header.bytes, counter, plainLength), tagLength: 128
            }, key, bytes);
            return new Uint8Array(result);
        } catch (error) {
            throw new VideoError(operation === 'decrypt' ? 'AUTH_FAILED' : 'ENCRYPT_FAILED',
                operation === 'decrypt' ? '视频分块校验失败，文件可能已损坏' : '视频分块加密失败');
        }
    }

    function encryptChunk(key, header, counter, plaintext) {
        const bytes = asBytes(plaintext);
        return cryptChunk('encrypt', key, header, counter, bytes, bytes.length);
    }

    function decryptChunk(key, header, counter, ciphertext, plainLength) {
        return cryptChunk('decrypt', key, header, counter, ciphertext, plainLength);
    }

    function validateManifest(manifest, header, archiveSize) {
        if (!manifest || manifest.version !== VERSION || manifest.mime !== VIDEO_MIME_TYPE
            || manifest.size !== header.totalPlainSize || manifest.chunkCount !== header.chunkCount) {
            throw new VideoError('INVALID_MANIFEST', '视频清单内容无效');
        }
        const expectedSize = header.dataOffset + header.totalPlainSize + header.chunkCount * AUTH_TAG_SIZE;
        if (archiveSize !== expectedSize) {
            throw new VideoError('INVALID_ARCHIVE_SIZE', '.emp4 长度不完整或包含多余数据');
        }
        return Object.freeze({
            version: VERSION,
            title: normalizeName(manifest.title, '视频'),
            originalName: normalizeName(manifest.originalName, 'video.mp4'),
            mime: VIDEO_MIME_TYPE,
            size: header.totalPlainSize,
            chunkCount: header.chunkCount,
            lastModified: Number.isSafeInteger(manifest.lastModified) ? manifest.lastModified : 0,
            createdAt: Number.isSafeInteger(manifest.createdAt) ? manifest.createdAt : 0,
            expectedSize
        });
    }

    function getChunkCipherOffset(header, chunkIndex) {
        return header.dataOffset + chunkIndex * (CHUNK_SIZE + AUTH_TAG_SIZE);
    }

    function parseRangeHeader(value, totalSize) {
        const text = String(value || '').trim();
        if (!text) return { start: 0, end: totalSize - 1, partial: false };
        const match = /^bytes=(\d*)-(\d*)$/i.exec(text);
        if (!match || (!match[1] && !match[2])) throw new VideoError('INVALID_RANGE', '不支持该视频读取范围');
        let start;
        let end;
        if (!match[1]) {
            const suffix = Number(match[2]);
            if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new VideoError('INVALID_RANGE', '视频读取范围无效');
            start = Math.max(0, totalSize - suffix);
            end = totalSize - 1;
        } else {
            start = Number(match[1]);
            end = match[2] ? Number(match[2]) : totalSize - 1;
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
            || start < 0 || start >= totalSize || end < start) {
            throw new VideoError('INVALID_RANGE', '视频读取范围超出文件长度');
        }
        return { start, end: Math.min(end, totalSize - 1), partial: true };
    }

    function isMp4Prefix(value) {
        const bytes = asBytes(value);
        let offset = 0;
        while (offset + 8 <= bytes.length && offset < 4096) {
            const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
            const size = view.getUint32(0, false);
            const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
            if (type === 'ftyp') return size >= 8;
            if (size < 8 || offset + size > bytes.length) break;
            offset += size;
        }
        return false;
    }

    root.Ecryptees = root.Ecryptees || {};
    root.Ecryptees.video = Object.freeze({
        VideoError,
        format: Object.freeze({
            MAGIC, VERSION, KEY_MODE_BUILTIN, KDF_HKDF_SHA256, CIPHER_AES_256_GCM,
            HEADER_SIZE, CHUNK_SIZE, AUTH_TAG_SIZE, MANIFEST_LIMIT, MAX_TOTAL_BYTES,
            EXTENSION, MIME_TYPE, VIDEO_MIME_TYPE,
            createManifest, encodeManifest, decodeManifest, encodeHeader, decodeHeader,
            validateManifest, getChunkCount, getChunkPlainLength, getChunkCipherOffset,
            parseRangeHeader, isMp4Prefix
        }),
        crypto: Object.freeze({
            getBuiltinKeyId, deriveKek, wrapContentKey, unwrapContentKey, importContentKey,
            createNonce, createChunkAad, encryptChunk, decryptChunk
        })
    });
})(typeof globalThis !== 'undefined' ? globalThis : self);
