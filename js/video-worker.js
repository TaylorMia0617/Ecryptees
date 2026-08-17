'use strict';

importScripts('core.js', 'video-core.js');

const core = self.Ecryptees.core;
const video = self.Ecryptees.video;
const { format, crypto: videoCrypto, VideoError } = video;
const cancelled = new Set();
const BUILTIN_KEY_SOURCE = new TextEncoder().encode(core.config.imageCodebook.join(''));
const CONTENT_ID_PREFIX = new TextEncoder().encode('Ecryptees video content v1\0');

function post(id, type, payload = {}, transfer = []) {
    self.postMessage({ id, type, ...payload }, transfer);
}

function checkCancelled(id) {
    if (cancelled.has(id)) throw new VideoError('CANCELLED', '操作已取消');
}

async function getRoot() {
    if (!self.navigator.storage?.getDirectory) {
        throw new VideoError('STORAGE_UNAVAILABLE', '当前环境不支持视频所需的本地流式存储');
    }
    return self.navigator.storage.getDirectory();
}

async function removeEntry(name) {
    if (!name) return;
    try {
        await (await getRoot()).removeEntry(name);
    } catch (error) {
        if (error?.name !== 'NotFoundError') throw error;
    }
}

async function openStoredFile(name) {
    return (await (await getRoot()).getFileHandle(name)).getFile();
}

async function createWriter(name) {
    const root = await getRoot();
    const handle = await root.getFileHandle(name, { create: true });
    return { root, handle, writable: await handle.createWritable() };
}

class ContentFingerprinter {
    constructor(size) {
        this.size = size;
        this.digests = [];
    }

    async add(bytes) {
        const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        this.digests.push(new Uint8Array(await self.crypto.subtle.digest('SHA-256', view)));
    }

    async finish() {
        const descriptor = new Uint8Array(CONTENT_ID_PREFIX.length + 12 + this.digests.length * 32);
        descriptor.set(CONTENT_ID_PREFIX, 0);
        const data = new DataView(descriptor.buffer);
        const offset = CONTENT_ID_PREFIX.length;
        data.setUint32(offset, Math.floor(this.size / 0x100000000), false);
        data.setUint32(offset + 4, this.size >>> 0, false);
        data.setUint32(offset + 8, this.digests.length, false);
        this.digests.forEach((digest, index) => descriptor.set(digest, offset + 12 + index * 32));
        const digest = new Uint8Array(await self.crypto.subtle.digest('SHA-256', descriptor));
        return `sha256-tree-v1:${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
    }
}

async function fingerprintBlob(id, file, emitProgress = true) {
    const fingerprinter = new ContentFingerprinter(file.size);
    let processed = 0;
    for (let offset = 0; offset < file.size; offset += format.CHUNK_SIZE) {
        checkCancelled(id);
        const bytes = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + format.CHUNK_SIZE)).arrayBuffer());
        await fingerprinter.add(bytes);
        processed += bytes.byteLength;
        if (emitProgress) post(id, 'progress', { processed, total: file.size, message: '正在建立视频内容索引…' });
    }
    return fingerprinter.finish();
}

async function copyToStorage(id, source, targetName) {
    if (!(source instanceof Blob) || !source.size) throw new VideoError('INVALID_FILE', '待保存的 .emp4 文件无效');
    const { handle, writable } = await createWriter(targetName);
    let writer = writable;
    try {
        const fingerprinter = new ContentFingerprinter(source.size);
        let written = 0;
        for (let offset = 0; offset < source.size; offset += format.CHUNK_SIZE) {
            checkCancelled(id);
            const bytes = new Uint8Array(await source.slice(offset, Math.min(source.size, offset + format.CHUNK_SIZE)).arrayBuffer());
            await writer.write(bytes);
            await fingerprinter.add(bytes);
            written += bytes.byteLength;
            post(id, 'progress', { processed: written, total: source.size, message: '正在保存原始 MP4…' });
        }
        await writer.close();
        writer = null;
        return { file: await handle.getFile(), contentId: await fingerprinter.finish() };
    } catch (error) {
        try { await writer?.abort(error); } catch (abortError) { /* Preserve original failure. */ }
        await removeEntry(targetName);
        throw error;
    }
}

async function createKeyContext(header) {
    const expected = await videoCrypto.getBuiltinKeyId(BUILTIN_KEY_SOURCE);
    if (!expected.every((value, index) => value === header.keyId[index])) {
        throw new VideoError('KEY_MISMATCH', '该 .emp4 使用了不同版本的内置密钥');
    }
    const kek = await videoCrypto.deriveKek({
        keyMode: header.keyMode,
        builtinSource: BUILTIN_KEY_SOURCE,
        salt: header.salt
    });
    const rawKey = await videoCrypto.unwrapContentKey(kek, header);
    return { rawKey, key: await videoCrypto.importContentKey(rawKey) };
}

async function openArchiveData(id, file) {
    if (!(file instanceof Blob) || file.size < format.HEADER_SIZE + format.AUTH_TAG_SIZE) {
        throw new VideoError('TRUNCATED_ARCHIVE', '.emp4 文件不完整');
    }
    const header = format.decodeHeader(new Uint8Array(await file.slice(0, format.HEADER_SIZE).arrayBuffer()));
    const context = await createKeyContext(header);
    checkCancelled(id);
    const manifestCipher = new Uint8Array(await file.slice(format.HEADER_SIZE, header.dataOffset).arrayBuffer());
    const manifestBytes = await videoCrypto.decryptChunk(
        context.key, header, 0, manifestCipher, header.manifestCipherLength - format.AUTH_TAG_SIZE
    );
    const manifest = format.validateManifest(format.decodeManifest(manifestBytes), header, file.size);
    return { header, manifest, ...context };
}

async function encryptArchive(id, payload) {
    const file = payload.file;
    if (!(file instanceof Blob)) throw new VideoError('INVALID_FILE', '请选择 MP4 视频');
    const prefix = new Uint8Array(await file.slice(0, Math.min(4096, file.size)).arrayBuffer());
    if (!format.isMp4Prefix(prefix)) throw new VideoError('INVALID_MP4', '文件不是有效的 MP4 容器');
    const manifest = format.createManifest(file, payload.title);
    const manifestBytes = format.encodeManifest(manifest);
    const keyMode = format.KEY_MODE_BUILTIN;
    const salt = self.crypto.getRandomValues(new Uint8Array(16));
    const wrapNonce = self.crypto.getRandomValues(new Uint8Array(12));
    const noncePrefix = self.crypto.getRandomValues(new Uint8Array(8));
    const rawKey = self.crypto.getRandomValues(new Uint8Array(32));
    const keyId = await videoCrypto.getBuiltinKeyId(BUILTIN_KEY_SOURCE);
    const headerOptions = {
        keyMode,
        iterations: 0,
        totalPlainSize: file.size,
        manifestCipherLength: manifestBytes.length + format.AUTH_TAG_SIZE,
        salt,
        wrapNonce,
        noncePrefix,
        keyId
    };
    const draftHeader = format.encodeHeader(headerOptions);
    const kek = await videoCrypto.deriveKek({
        keyMode, builtinSource: BUILTIN_KEY_SOURCE, salt
    });
    headerOptions.wrappedKey = await videoCrypto.wrapContentKey(kek, rawKey, draftHeader, wrapNonce);
    const headerBytes = format.encodeHeader(headerOptions);
    const header = format.decodeHeader(headerBytes);
    const key = await videoCrypto.importContentKey(rawKey);
    const encryptedManifest = await videoCrypto.encryptChunk(key, header, 0, manifestBytes);
    const targetName = String(payload.opfsName || `ecryptees-video-${id}.emp4`);
    const { handle, writable } = await createWriter(targetName);
    let writer = writable;
    try {
        await writer.write(headerBytes);
        await writer.write(encryptedManifest);
        const parallelism = Math.max(1, Math.min(2, Number(payload.parallelism) || 2));
        const pending = [];
        let nextChunk = 0;
        const start = chunkIndex => (async () => {
            const plainLength = format.getChunkPlainLength(file.size, chunkIndex);
            const plain = new Uint8Array(await file.slice(
                chunkIndex * format.CHUNK_SIZE,
                chunkIndex * format.CHUNK_SIZE + plainLength
            ).arrayBuffer());
            checkCancelled(id);
            return {
                chunkIndex,
                plainLength,
                encrypted: await videoCrypto.encryptChunk(key, header, chunkIndex + 1, plain)
            };
        })();
        while (nextChunk < header.chunkCount && pending.length < parallelism) pending.push(start(nextChunk++));
        let processed = 0;
        while (pending.length) {
            checkCancelled(id);
            const result = await pending.shift();
            await writer.write(result.encrypted);
            processed += result.plainLength;
            if (nextChunk < header.chunkCount) pending.push(start(nextChunk++));
            post(id, 'progress', { processed, total: file.size, message: '正在加密 MP4…' });
        }
        await writer.close();
        writer = null;
        const stored = await handle.getFile();
        const rawKeyBuffer = rawKey.slice().buffer;
        post(id, 'encrypted', {
            file: stored,
            opfsName: targetName,
            headerBytes,
            manifest,
            rawKey: rawKeyBuffer,
            keyMode,
            archiveSize: stored.size
        }, [rawKeyBuffer]);
    } catch (error) {
        try { await writer?.abort(error); } catch (abortError) { /* Preserve original failure. */ }
        await removeEntry(targetName);
        throw error;
    }
}

async function openArchive(id, payload) {
    const result = await openArchiveData(id, payload.file);
    const rawKeyBuffer = result.rawKey.buffer.slice(
        result.rawKey.byteOffset, result.rawKey.byteOffset + result.rawKey.byteLength
    );
    post(id, 'opened', {
        headerBytes: result.header.bytes,
        manifest: result.manifest,
        rawKey: rawKeyBuffer,
        keyMode: result.header.keyMode
    }, [rawKeyBuffer]);
}

async function writePlainArchive(id, file, header, key, targetName) {
    const { handle, writable } = await createWriter(targetName);
    let writer = writable;
    const fingerprinter = new ContentFingerprinter(header.totalPlainSize);
    try {
        let processed = 0;
        for (let chunkIndex = 0; chunkIndex < header.chunkCount; chunkIndex++) {
            checkCancelled(id);
            const plainLength = format.getChunkPlainLength(header.totalPlainSize, chunkIndex);
            const offset = format.getChunkCipherOffset(header, chunkIndex);
            const encrypted = new Uint8Array(await file.slice(
                offset, offset + plainLength + format.AUTH_TAG_SIZE
            ).arrayBuffer());
            const plain = await videoCrypto.decryptChunk(key, header, chunkIndex + 1, encrypted, plainLength);
            await writer.write(plain);
            await fingerprinter.add(plain);
            processed += plainLength;
            post(id, 'progress', { processed, total: header.totalPlainSize, message: '正在解密原始 MP4…' });
        }
        await writer.close();
        writer = null;
        return { file: await handle.getFile(), contentId: await fingerprinter.finish() };
    } catch (error) {
        try { await writer?.abort(error); } catch (abortError) { /* Preserve original failure. */ }
        await removeEntry(targetName);
        throw error;
    }
}

async function decryptArchive(id, payload) {
    const file = payload.file;
    const header = format.decodeHeader(payload.headerBytes);
    const rawKey = new Uint8Array(payload.rawKey);
    const key = await videoCrypto.importContentKey(rawKey);
    const targetName = String(payload.opfsName || `ecryptees-video-export-${id}.mp4`);
    const output = await writePlainArchive(id, file, header, key, targetName);
    post(id, 'decrypted', { file: output.file, opfsName: targetName, size: output.file.size, contentId: output.contentId });
}

async function importArchive(id, payload) {
    const file = payload.file;
    const targetName = String(payload.opfsName || `ecryptees-video-import-${id}.mp4`);
    const result = await openArchiveData(id, file);
    const output = await writePlainArchive(id, file, result.header, result.key, targetName);
    const prefix = new Uint8Array(await output.file.slice(0, Math.min(4096, output.file.size)).arrayBuffer());
    if (!format.isMp4Prefix(prefix)) {
        await removeEntry(targetName);
        throw new VideoError('INVALID_MP4', '解密结果不是有效的 MP4 容器');
    }
    post(id, 'imported', {
        file: output.file,
        opfsName: targetName,
        size: output.file.size,
        contentId: output.contentId,
        manifest: result.manifest
    });
}

self.addEventListener('message', event => {
    const message = event.data || {};
    const id = String(message.id || '');
    if (message.type === 'cancel') {
        cancelled.add(id);
        return;
    }
    (async () => {
        try {
            if (message.type === 'encrypt') await encryptArchive(id, message.payload || {});
            else if (message.type === 'open') await openArchive(id, message.payload || {});
            else if (message.type === 'import') await importArchive(id, message.payload || {});
            else if (message.type === 'decrypt') await decryptArchive(id, message.payload || {});
            else if (message.type === 'fingerprint') {
                const file = message.payload?.file instanceof Blob
                    ? message.payload.file
                    : await openStoredFile(message.payload?.opfsName);
                post(id, 'fingerprinted', { contentId: await fingerprintBlob(id, file), size: file.size });
            }
            else if (message.type === 'persist') {
                const result = await copyToStorage(id, message.payload?.file, message.payload?.opfsName);
                post(id, 'persisted', { file: result.file, contentId: result.contentId, opfsName: message.payload?.opfsName });
            } else if (message.type === 'getStored') {
                post(id, 'stored', { file: await openStoredFile(message.payload?.opfsName) });
            } else if (message.type === 'remove') {
                await removeEntry(message.payload?.opfsName);
                post(id, 'removed');
            } else {
                throw new VideoError('UNKNOWN_OPERATION', '未知视频任务');
            }
        } catch (error) {
            post(id, 'error', {
                code: error?.code || error?.name || 'VIDEO_ERROR',
                message: error?.message || '视频任务失败'
            });
        } finally {
            cancelled.delete(id);
        }
    })();
});
