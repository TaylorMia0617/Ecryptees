(function (root) {
    'use strict';

    const core = root.Ecryptees && root.Ecryptees.core;
    if (!core) {
        throw new Error('Ecryptees core must load before the comic core.');
    }

    const MAGIC = Uint8Array.from([0x45, 0x43, 0x52, 0x43, 0x4F, 0x4D, 0x31, 0x00]);
    const VERSION = 1;
    const KEY_MODE_BUILTIN = 0;
    const KDF_HKDF_SHA256 = 1;
    const CIPHER_AES_256_GCM = 1;
    const HEADER_SIZE = 64;
    const CHUNK_SIZE = 4 * 1024 * 1024;
    const AUTH_TAG_SIZE = 16;
    const SALT_SIZE = 16;
    const NONCE_PREFIX_SIZE = 8;
    const KEY_ID_SIZE = 8;
    const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
    const MAX_PAGES = 80;
    const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
    const STORAGE_RESERVE_BYTES = 64 * 1024 * 1024;
    const EXTENSION = 'ecomic';
    const HKDF_INFO = new TextEncoder().encode('Ecryptees Comic v1');
    const BUILTIN_KEY_SOURCE = new TextEncoder().encode(core.config.imageCodebook.join(''));
    const SUPPORTED_MIME_TYPES = Object.freeze(Object.keys(core.config.IMAGE_FORMATS));

    class ComicError extends Error {
        constructor(code, message) {
            super(message);
            this.name = 'ComicError';
            this.code = code;
        }
    }

    function getCrypto() {
        const cryptoProvider = root.crypto;
        if (!cryptoProvider || !cryptoProvider.subtle) {
            throw new ComicError('CRYPTO_UNAVAILABLE', '当前环境不支持 Web Crypto');
        }
        return cryptoProvider;
    }

    function ensureUint8Array(value, expectedLength, label) {
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
        if (expectedLength !== undefined && bytes.length !== expectedLength) {
            throw new ComicError('INVALID_FIELD', `${label}长度无效`);
        }
        return bytes;
    }

    function setUint64(view, offset, value) {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new ComicError('INVALID_SIZE', '归档大小无效');
        }
        const high = Math.floor(value / 0x100000000);
        const low = value >>> 0;
        view.setUint32(offset, high, false);
        view.setUint32(offset + 4, low, false);
    }

    function getUint64(view, offset) {
        const value = view.getUint32(offset, false) * 0x100000000 + view.getUint32(offset + 4, false);
        if (!Number.isSafeInteger(value)) {
            throw new ComicError('INVALID_SIZE', '归档大小超出支持范围');
        }
        return value;
    }

    function bytesEqual(left, right) {
        if (left.length !== right.length) {
            return false;
        }
        for (let index = 0; index < left.length; index++) {
            if (left[index] !== right[index]) {
                return false;
            }
        }
        return true;
    }

    function getChunkCount(size) {
        return Math.ceil(size / CHUNK_SIZE);
    }

    function estimateDataCipherBytes(pages) {
        return pages.reduce((total, page) => total + page.size + page.chunkCount * AUTH_TAG_SIZE, 0);
    }

    function normalizePageName(name, index) {
        const fallback = `page-${String(index + 1).padStart(4, '0')}`;
        const normalized = String(name || fallback)
            .replace(/[\\/:*?"<>|\u0000-\u001F\u007F]/g, '_')
            .trim();
        return Array.from(normalized || fallback).slice(0, 240).join('');
    }

    function createManifest(fileRecords, createdAt = Date.now()) {
        if (!Array.isArray(fileRecords) || fileRecords.length === 0) {
            throw new ComicError('EMPTY_ARCHIVE', '请至少选择一张图片');
        }
        if (fileRecords.length > MAX_PAGES) {
            throw new ComicError('TOO_MANY_PAGES', `漫画最多包含 ${MAX_PAGES} 张图片`);
        }

        let totalSize = 0;
        let firstChunk = 1;
        let cipherOffset = 0;
        const pages = fileRecords.map((record, index) => {
            const size = Number(record.size);
            if (!Number.isSafeInteger(size) || size <= 0) {
                throw new ComicError('INVALID_PAGE_SIZE', '图片文件不能为空');
            }
            if (!SUPPORTED_MIME_TYPES.includes(record.type)) {
                throw new ComicError('UNSUPPORTED_TYPE', '漫画包含不支持的图片格式');
            }

            const chunkCount = getChunkCount(size);
            const page = {
                name: normalizePageName(record.name, index),
                type: record.type,
                size,
                lastModified: Number.isSafeInteger(record.lastModified) && record.lastModified >= 0
                    ? record.lastModified
                    : 0,
                firstChunk,
                chunkCount,
                cipherOffset
            };
            totalSize += size;
            firstChunk += chunkCount;
            cipherOffset += size + chunkCount * AUTH_TAG_SIZE;
            return page;
        });

        if (totalSize > MAX_TOTAL_BYTES) {
            throw new ComicError('TOTAL_TOO_LARGE', '漫画原图总体积不能超过 500 MiB');
        }

        return {
            version: VERSION,
            createdAt: Number.isSafeInteger(createdAt) && createdAt >= 0 ? createdAt : Date.now(),
            totalSize,
            pages
        };
    }

    function encodeManifest(manifest) {
        const bytes = new TextEncoder().encode(JSON.stringify(manifest));
        if (bytes.length > MAX_MANIFEST_BYTES) {
            throw new ComicError('MANIFEST_TOO_LARGE', '漫画清单过大');
        }
        return bytes;
    }

    function decodeManifest(bytes) {
        let manifest;
        try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            manifest = JSON.parse(text);
        } catch (error) {
            throw new ComicError('INVALID_MANIFEST', '漫画清单已损坏');
        }
        return manifest;
    }

    function encodeHeader(options) {
        const salt = ensureUint8Array(options.salt, SALT_SIZE, 'salt');
        const noncePrefix = ensureUint8Array(options.noncePrefix, NONCE_PREFIX_SIZE, 'nonce');
        const keyId = ensureUint8Array(options.keyId, KEY_ID_SIZE, 'keyId');
        const manifestCipherLength = Number(options.manifestCipherLength);
        const totalPlainSize = Number(options.totalPlainSize);
        if (!Number.isSafeInteger(manifestCipherLength)
            || manifestCipherLength <= AUTH_TAG_SIZE
            || manifestCipherLength > MAX_MANIFEST_BYTES + AUTH_TAG_SIZE) {
            throw new ComicError('INVALID_MANIFEST_SIZE', '漫画清单长度无效');
        }
        if (!Number.isSafeInteger(totalPlainSize) || totalPlainSize <= 0 || totalPlainSize > MAX_TOTAL_BYTES) {
            throw new ComicError('INVALID_SIZE', '漫画原图总体积无效');
        }

        const header = new Uint8Array(HEADER_SIZE);
        header.set(MAGIC, 0);
        const view = new DataView(header.buffer);
        view.setUint8(8, VERSION);
        view.setUint8(9, KEY_MODE_BUILTIN);
        view.setUint8(10, KDF_HKDF_SHA256);
        view.setUint8(11, CIPHER_AES_256_GCM);
        view.setUint32(12, 0, false);
        view.setUint32(16, CHUNK_SIZE, false);
        view.setUint32(20, manifestCipherLength, false);
        setUint64(view, 24, totalPlainSize);
        header.set(salt, 32);
        header.set(noncePrefix, 48);
        header.set(keyId, 56);
        return header;
    }

    function decodeHeader(value) {
        const bytes = ensureUint8Array(value);
        if (bytes.length < HEADER_SIZE) {
            throw new ComicError('TRUNCATED_HEADER', '漫画归档头不完整');
        }
        const header = bytes.slice(0, HEADER_SIZE);
        if (!bytesEqual(header.subarray(0, MAGIC.length), MAGIC)) {
            throw new ComicError('BAD_MAGIC', '这不是有效的 Ecryptees 漫画归档');
        }

        const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
        if (view.getUint8(8) !== VERSION) {
            throw new ComicError('UNSUPPORTED_VERSION', '不支持该漫画归档版本');
        }
        if (view.getUint8(9) !== KEY_MODE_BUILTIN) {
            throw new ComicError('UNSUPPORTED_KEY_MODE', '该归档需要当前版本不支持的密码本');
        }
        if (view.getUint8(10) !== KDF_HKDF_SHA256 || view.getUint8(11) !== CIPHER_AES_256_GCM) {
            throw new ComicError('UNSUPPORTED_CRYPTO', '不支持该漫画归档的加密算法');
        }
        if (view.getUint32(12, false) !== 0 || view.getUint32(16, false) !== CHUNK_SIZE) {
            throw new ComicError('UNSUPPORTED_OPTIONS', '不支持该漫画归档参数');
        }

        const manifestCipherLength = view.getUint32(20, false);
        const totalPlainSize = getUint64(view, 24);
        if (manifestCipherLength <= AUTH_TAG_SIZE || manifestCipherLength > MAX_MANIFEST_BYTES + AUTH_TAG_SIZE) {
            throw new ComicError('INVALID_MANIFEST_SIZE', '漫画清单长度无效');
        }
        if (totalPlainSize <= 0 || totalPlainSize > MAX_TOTAL_BYTES) {
            throw new ComicError('INVALID_SIZE', '漫画原图总体积无效');
        }

        return Object.freeze({
            bytes: header,
            version: VERSION,
            keyMode: KEY_MODE_BUILTIN,
            manifestCipherLength,
            totalPlainSize,
            salt: header.slice(32, 48),
            noncePrefix: header.slice(48, 56),
            keyId: header.slice(56, 64),
            dataOffset: HEADER_SIZE + manifestCipherLength
        });
    }

    async function getBuiltinKeyId() {
        const digest = new Uint8Array(await getCrypto().subtle.digest('SHA-256', BUILTIN_KEY_SOURCE));
        return digest.slice(0, KEY_ID_SIZE);
    }

    async function deriveBuiltinKey(salt) {
        const cryptoProvider = getCrypto();
        const material = await cryptoProvider.subtle.importKey('raw', BUILTIN_KEY_SOURCE, 'HKDF', false, ['deriveKey']);
        return cryptoProvider.subtle.deriveKey(
            { name: 'HKDF', hash: 'SHA-256', salt: ensureUint8Array(salt, SALT_SIZE, 'salt'), info: HKDF_INFO },
            material,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    function createNonce(prefix, counter) {
        if (!Number.isInteger(counter) || counter < 0 || counter > 0xFFFFFFFF) {
            throw new ComicError('INVALID_COUNTER', '漫画分块序号无效');
        }
        const nonce = new Uint8Array(12);
        nonce.set(ensureUint8Array(prefix, NONCE_PREFIX_SIZE, 'nonce'), 0);
        new DataView(nonce.buffer).setUint32(8, counter, false);
        return nonce;
    }

    function createAad(headerBytes, counter, plainLength) {
        const maximumLength = counter === 0 ? MAX_MANIFEST_BYTES : CHUNK_SIZE;
        if (!Number.isInteger(plainLength) || plainLength < 0 || plainLength > maximumLength) {
            throw new ComicError('INVALID_CHUNK', '漫画分块长度无效');
        }
        const header = ensureUint8Array(headerBytes, HEADER_SIZE, 'header');
        const aad = new Uint8Array(HEADER_SIZE + 8);
        aad.set(header, 0);
        const view = new DataView(aad.buffer);
        view.setUint32(HEADER_SIZE, counter, false);
        view.setUint32(HEADER_SIZE + 4, plainLength, false);
        return aad;
    }

    async function encryptChunk(key, header, noncePrefix, counter, plaintext) {
        const bytes = ensureUint8Array(plaintext);
        const result = await getCrypto().subtle.encrypt({
            name: 'AES-GCM',
            iv: createNonce(noncePrefix, counter),
            additionalData: createAad(header, counter, bytes.length),
            tagLength: 128
        }, key, bytes);
        return new Uint8Array(result);
    }

    async function decryptChunk(key, header, noncePrefix, counter, ciphertext, plainLength) {
        const bytes = ensureUint8Array(ciphertext);
        if (bytes.length !== plainLength + AUTH_TAG_SIZE) {
            throw new ComicError('INVALID_CHUNK', '漫画分块长度不完整');
        }
        try {
            const result = await getCrypto().subtle.decrypt({
                name: 'AES-GCM',
                iv: createNonce(noncePrefix, counter),
                additionalData: createAad(header, counter, plainLength),
                tagLength: 128
            }, key, bytes);
            return new Uint8Array(result);
        } catch (error) {
            throw new ComicError('AUTH_FAILED', '漫画归档校验失败，内容可能已损坏');
        }
    }

    function validateManifest(manifest, header, archiveSize) {
        if (!manifest || manifest.version !== VERSION || !Array.isArray(manifest.pages)) {
            throw new ComicError('INVALID_MANIFEST', '漫画清单格式无效');
        }
        if (manifest.pages.length === 0 || manifest.pages.length > MAX_PAGES) {
            throw new ComicError('INVALID_MANIFEST', '漫画页数无效');
        }

        let totalSize = 0;
        let expectedChunk = 1;
        let expectedCipherOffset = 0;
        const pages = manifest.pages.map((page, index) => {
            const size = Number(page.size);
            const chunkCount = getChunkCount(size);
            if (!Number.isSafeInteger(size) || size <= 0
                || !SUPPORTED_MIME_TYPES.includes(page.type)
                || page.firstChunk !== expectedChunk
                || page.chunkCount !== chunkCount
                || page.cipherOffset !== expectedCipherOffset) {
                throw new ComicError('INVALID_MANIFEST', '漫画页面清单无效');
            }
            const normalized = Object.freeze({
                name: normalizePageName(page.name, index),
                type: page.type,
                size,
                lastModified: Number.isSafeInteger(page.lastModified) && page.lastModified >= 0
                    ? page.lastModified
                    : 0,
                firstChunk: page.firstChunk,
                chunkCount,
                cipherOffset: page.cipherOffset
            });
            totalSize += size;
            expectedChunk += chunkCount;
            expectedCipherOffset += size + chunkCount * AUTH_TAG_SIZE;
            return normalized;
        });

        const expectedArchiveSize = header.dataOffset + expectedCipherOffset;
        if (totalSize !== header.totalPlainSize
            || manifest.totalSize !== totalSize
            || archiveSize !== expectedArchiveSize) {
            throw new ComicError('INVALID_ARCHIVE_SIZE', '漫画归档长度不完整或包含多余数据');
        }

        return Object.freeze({
            version: VERSION,
            createdAt: Number.isSafeInteger(manifest.createdAt) ? manifest.createdAt : 0,
            totalSize,
            pages: Object.freeze(pages),
            expectedArchiveSize
        });
    }

    function getPageChunkPlainLength(page, localChunkIndex) {
        const offset = localChunkIndex * CHUNK_SIZE;
        return Math.min(CHUNK_SIZE, page.size - offset);
    }

    function getPageChunkCipherOffset(header, page, localChunkIndex) {
        return header.dataOffset + page.cipherOffset + localChunkIndex * (CHUNK_SIZE + AUTH_TAG_SIZE);
    }

    function estimateArchiveSize(manifest, manifestPlainLength) {
        return HEADER_SIZE + manifestPlainLength + AUTH_TAG_SIZE + estimateDataCipherBytes(manifest.pages);
    }

    const format = Object.freeze({
        MAGIC,
        VERSION,
        KEY_MODE_BUILTIN,
        KDF_HKDF_SHA256,
        CIPHER_AES_256_GCM,
        HEADER_SIZE,
        CHUNK_SIZE,
        AUTH_TAG_SIZE,
        MAX_TOTAL_BYTES,
        MAX_PAGES,
        MAX_MANIFEST_BYTES,
        STORAGE_RESERVE_BYTES,
        EXTENSION,
        SUPPORTED_MIME_TYPES,
        createManifest,
        encodeManifest,
        decodeManifest,
        encodeHeader,
        decodeHeader,
        validateManifest,
        estimateArchiveSize,
        getPageChunkPlainLength,
        getPageChunkCipherOffset
    });
    const crypto = Object.freeze({
        getBuiltinKeyId,
        deriveBuiltinKey,
        createNonce,
        createAad,
        encryptChunk,
        decryptChunk
    });

    root.Ecryptees.comic = Object.freeze({ ComicError, format, crypto });
})(globalThis);
