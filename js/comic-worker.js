'use strict';

const IS_WORKER_CONTEXT = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
if (IS_WORKER_CONTEXT) {
    importScripts('core.js', 'comic-core.js', 'history-core.js');
}

const core = self.Ecryptees.core;
const comic = self.Ecryptees.comic;
const history = self.Ecryptees.history;
const { format, crypto: comicCrypto, ComicError } = comic;
const TEMP_PREFIX = 'ecryptees-temp-';
const sessions = new Map();
const cancelledJobs = new Set();
const nativeDecodeRequests = new Map();
let nativeDecodeSequence = 0;
let messageSink = message => self.postMessage(message);
let storageBackendPromise = null;
let historyDatabasePromise = null;

function post(type, jobId, payload = {}) {
    messageSink({ type, jobId, ...payload });
}

function assertNotCancelled(jobId) {
    if (cancelledJobs.has(jobId)) {
        throw new ComicError('CANCELLED', '操作已取消');
    }
}

function toError(error) {
    return {
        code: error && error.code ? error.code : 'COMIC_ERROR',
        message: error && error.message ? error.message : '漫画处理失败'
    };
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

function requestToPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB 操作失败'));
    });
}

function transactionToPromise(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('IndexedDB 事务失败'));
        transaction.onabort = () => reject(transaction.error || new Error('IndexedDB 事务已取消'));
    });
}

function openHistoryDatabase() {
    if (!historyDatabasePromise) {
        historyDatabasePromise = new Promise((resolve, reject) => {
            const request = self.indexedDB.open(
                history.config.DATABASE_NAME,
                history.config.DATABASE_VERSION
            );
            request.onupgradeneeded = () => {
                const database = request.result;
                if (!database.objectStoreNames.contains(history.config.BOOK_STORE)) {
                    database.createObjectStore(history.config.BOOK_STORE, { keyPath: 'bookId' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('漫画书架数据库打开失败'));
        });
    }
    return historyDatabasePromise;
}

async function getHistoryRecord(bookId) {
    const database = await openHistoryDatabase();
    const transaction = database.transaction(history.config.BOOK_STORE, 'readonly');
    const record = await requestToPromise(transaction.objectStore(history.config.BOOK_STORE).get(bookId));
    await transactionToPromise(transaction);
    return record ? history.validateRecord(record) : null;
}

async function listHistoryRecords() {
    const database = await openHistoryDatabase();
    const transaction = database.transaction(history.config.BOOK_STORE, 'readonly');
    const records = await requestToPromise(transaction.objectStore(history.config.BOOK_STORE).getAll());
    await transactionToPromise(transaction);
    return records
        .map(record => history.validateRecord(record))
        .sort((left, right) => (right.lastOpenedAt || right.updatedAt) - (left.lastOpenedAt || left.updatedAt));
}

async function putHistoryRecord(record) {
    const valid = history.validateRecord(record);
    const database = await openHistoryDatabase();
    const transaction = database.transaction(history.config.BOOK_STORE, 'readwrite');
    transaction.objectStore(history.config.BOOK_STORE).put(valid);
    await transactionToPromise(transaction);
    return valid;
}

async function removeHistoryRecord(bookId) {
    const database = await openHistoryDatabase();
    const transaction = database.transaction(history.config.BOOK_STORE, 'readwrite');
    transaction.objectStore(history.config.BOOK_STORE).delete(bookId);
    await transactionToPromise(transaction);
}

function isTemporaryEntryName(name) {
    return name.startsWith(TEMP_PREFIX) || name.startsWith(history.config.STAGING_PREFIX);
}

async function createIndexedDbBackend() {
    if (!self.indexedDB) {
        throw new ComicError('STORAGE_UNAVAILABLE', '当前浏览器不支持漫画模式所需的本地暂存');
    }
    const request = self.indexedDB.open('ecryptees-comic-v1', 1);
    request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('entries')) {
            database.createObjectStore('entries');
        }
        if (!database.objectStoreNames.contains('parts')) {
            database.createObjectStore('parts');
        }
    };
    const database = await requestToPromise(request);

    async function deleteParts(name) {
        const transaction = database.transaction('parts', 'readwrite');
        const store = transaction.objectStore('parts');
        const range = IDBKeyRange.bound(`${name}:`, `${name}:\uffff`);
        const cursorRequest = store.openKeyCursor(range);
        cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (cursor) {
                store.delete(cursor.primaryKey);
                cursor.continue();
            }
        };
        await transactionToPromise(transaction);
    }

    return {
        kind: 'indexeddb',
        async createWriter(name) {
            await this.remove(name);
            let partIndex = 0;
            let closed = false;
            return {
                async write(data) {
                    if (closed) {
                        throw new Error('暂存文件已经关闭');
                    }
                    const key = `${name}:${String(partIndex).padStart(8, '0')}`;
                    const transaction = database.transaction('parts', 'readwrite');
                    transaction.objectStore('parts').put(new Blob([data]), key);
                    await transactionToPromise(transaction);
                    partIndex += 1;
                },
                async close() {
                    if (closed) {
                        return;
                    }
                    const transaction = database.transaction('entries', 'readwrite');
                    transaction.objectStore('entries').put({ parts: partIndex, lastModified: Date.now() }, name);
                    await transactionToPromise(transaction);
                    closed = true;
                },
                async abort() {
                    closed = true;
                    await deleteParts(name);
                }
            };
        },
        async getFile(name) {
            const metaTransaction = database.transaction('entries', 'readonly');
            const metadata = await requestToPromise(metaTransaction.objectStore('entries').get(name));
            if (!metadata) {
                throw new DOMException('暂存文件不存在', 'NotFoundError');
            }
            const transaction = database.transaction('parts', 'readonly');
            const store = transaction.objectStore('parts');
            const range = IDBKeyRange.bound(`${name}:`, `${name}:\uffff`);
            const parts = await requestToPromise(store.getAll(range));
            await transactionToPromise(transaction);
            if (parts.length !== metadata.parts) {
                throw new ComicError('STORAGE_CORRUPT', '浏览器暂存文件不完整');
            }
            return new File(parts, name, { lastModified: metadata.lastModified });
        },
        async remove(name) {
            await deleteParts(name);
            const transaction = database.transaction('entries', 'readwrite');
            transaction.objectStore('entries').delete(name);
            await transactionToPromise(transaction);
        },
        async cleanup(cutoff) {
            const transaction = database.transaction('entries', 'readonly');
            const store = transaction.objectStore('entries');
            const entriesPromise = requestToPromise(store.getAll());
            const keysPromise = requestToPromise(store.getAllKeys());
            const [entries, keys] = await Promise.all([entriesPromise, keysPromise]);
            await transactionToPromise(transaction);
            for (let index = 0; index < keys.length; index++) {
                const name = String(keys[index]);
                if (name.startsWith(history.config.STAGING_PREFIX)
                    || (isTemporaryEntryName(name) && entries[index].lastModified < cutoff)) {
                    await this.remove(keys[index]);
                }
            }
        }
    };
}

async function createOpfsBackend() {
    if (!self.navigator.storage || typeof self.navigator.storage.getDirectory !== 'function') {
        throw new Error('OPFS unavailable');
    }
    const root = await self.navigator.storage.getDirectory();
    return {
        kind: 'opfs',
        async createWriter(name) {
            const handle = await root.getFileHandle(name, { create: true });
            return handle.createWritable();
        },
        async getFile(name) {
            const handle = await root.getFileHandle(name);
            return handle.getFile();
        },
        async remove(name) {
            await root.removeEntry(name);
        },
        async cleanup(cutoff) {
            for await (const [name, handle] of root.entries()) {
                if (handle.kind === 'file' && isTemporaryEntryName(name)) {
                    try {
                        const file = await handle.getFile();
                        if (name.startsWith(history.config.STAGING_PREFIX) || file.lastModified < cutoff) {
                            await root.removeEntry(name);
                        }
                    } catch (error) {
                        await root.removeEntry(name);
                    }
                }
            }
        }
    };
}

async function getStorageBackend() {
    if (!storageBackendPromise) {
        storageBackendPromise = (async () => {
            try {
                return await createOpfsBackend();
            } catch (error) {
                return createIndexedDbBackend();
            }
        })();
    }
    return storageBackendPromise;
}

async function ensureStorage(requiredBytes) {
    if (!self.navigator.storage || typeof self.navigator.storage.estimate !== 'function') {
        return;
    }
    const estimate = await self.navigator.storage.estimate();
    if (Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage)) {
        const available = Math.max(0, estimate.quota - estimate.usage);
        if (available < requiredBytes + format.STORAGE_RESERVE_BYTES) {
            throw new ComicError('INSUFFICIENT_STORAGE', '浏览器本地可用空间不足，请释放空间后重试');
        }
    }
}

async function removeEntryQuietly(storage, name) {
    if (!storage || !name) {
        return;
    }
    try {
        await storage.remove(name);
    } catch (error) {
        if (!error || error.name !== 'NotFoundError') {
            // Temporary cleanup is best effort.
        }
    }
}

async function cleanupStaleEntries() {
    const storage = await getStorageBackend();
    await storage.cleanup(Date.now() - 24 * 60 * 60 * 1000);
}

async function detectFileRecord(file) {
    if (!(file instanceof Blob) || file.size <= 0) {
        throw new ComicError('INVALID_PAGE_SIZE', '图片文件不能为空');
    }
    const prefix = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    const detected = core.image.sniffImageType(prefix);
    if (!detected || !format.SUPPORTED_MIME_TYPES.includes(detected.mime)) {
        throw new ComicError('UNSUPPORTED_TYPE', `不支持图片“${file.name || '未命名'}”的格式`);
    }
    return {
        name: file.name,
        type: detected.mime,
        size: file.size,
        lastModified: file.lastModified || 0
    };
}

async function createWritableEntry(storage, name) {
    return { writable: await storage.createWriter(name) };
}

async function encryptArchive(jobId, payload) {
    const files = Array.isArray(payload.files) ? payload.files : [];
    const records = [];
    for (const file of files) {
        assertNotCancelled(jobId);
        records.push(await detectFileRecord(file));
    }

    const manifest = format.createManifest(records);
    const manifestBytes = format.encodeManifest(manifest);
    const salt = self.crypto.getRandomValues(new Uint8Array(16));
    const noncePrefix = self.crypto.getRandomValues(new Uint8Array(8));
    const keyId = await comicCrypto.getBuiltinKeyId();
    const headerBytes = format.encodeHeader({
        salt,
        noncePrefix,
        keyId,
        manifestCipherLength: manifestBytes.length + format.AUTH_TAG_SIZE,
        totalPlainSize: manifest.totalSize
    });
    const header = format.decodeHeader(headerBytes);
    const expectedSize = format.estimateArchiveSize(manifest, manifestBytes.length);
    await ensureStorage(expectedSize);
    assertNotCancelled(jobId);

    const key = await comicCrypto.deriveBuiltinKey(salt);
    const encryptedManifest = await comicCrypto.encryptChunk(
        key,
        headerBytes,
        noncePrefix,
        0,
        manifestBytes
    );
    const storage = await getStorageBackend();
    const entryName = `${TEMP_PREFIX}${jobId}.ecomic`;
    let writable;
    let archiveReady = false;

    try {
        const entry = await createWritableEntry(storage, entryName);
        writable = entry.writable;
        await writable.write(headerBytes);
        await writable.write(encryptedManifest);

        let processed = 0;
        let counter = 1;
        for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
            const file = files[fileIndex];
            for (let offset = 0; offset < file.size; offset += format.CHUNK_SIZE) {
                assertNotCancelled(jobId);
                const plain = new Uint8Array(await file.slice(offset, offset + format.CHUNK_SIZE).arrayBuffer());
                const encrypted = await comicCrypto.encryptChunk(
                    key,
                    header.bytes,
                    header.noncePrefix,
                    counter,
                    plain
                );
                await writable.write(encrypted);
                processed += plain.length;
                counter += 1;
                post('progress', jobId, {
                    processed: Math.round(processed / manifest.totalSize * 500),
                    total: 1000,
                    message: `正在封装第 ${fileIndex + 1}/${files.length} 页`
                });
            }
        }

        await writable.close();
        writable = null;
        const file = await storage.getFile(entryName);
        const outputName = String(payload.outputName || 'comic').replace(/\.[^.]*$/, '') || 'comic';
        const archiveMessage = {
            kind: 'archive',
            file,
            opfsName: entryName,
            storageKind: storage.kind,
            name: `${outputName}.${format.EXTENSION}`,
            size: file.size,
            pages: manifest.pages.length
        };
        if (payload.addToShelf === false) {
            post('portableArchive', jobId, archiveMessage);
            archiveReady = true;
            return;
        }
        post('archiveReady', jobId, archiveMessage);
        archiveReady = true;

        const sessionId = `${jobId}-created`;
        sessions.set(sessionId, {
            kind: 'uploads',
            file,
            files,
            header,
            key,
            manifest,
            pageEntries: new Map(),
            bookId: ''
        });
        try {
            await exportLongImage(jobId, {
                sessionId,
                outputName,
                sourceName: `${outputName}.${format.EXTENSION}`,
                saveHistory: true,
                progressRange: { start: 500, end: 1000, total: 1000 }
            });
        } finally {
            sessions.delete(sessionId);
        }
    } catch (error) {
        if (writable) {
            try {
                await writable.abort();
            } catch (abortError) {
                // Ignore cleanup failures and report the original error.
            }
        }
        if (!archiveReady) {
            await removeEntryQuietly(storage, entryName);
        }
        throw error;
    }
}

async function openArchive(jobId, payload) {
    const file = payload.file;
    if (!(file instanceof Blob) || file.size < format.HEADER_SIZE + format.AUTH_TAG_SIZE) {
        throw new ComicError('TRUNCATED_ARCHIVE', '漫画归档不完整');
    }

    const header = format.decodeHeader(new Uint8Array(await file.slice(0, format.HEADER_SIZE).arrayBuffer()));
    const builtinKeyId = await comicCrypto.getBuiltinKeyId();
    if (!bytesEqual(header.keyId, builtinKeyId)) {
        throw new ComicError('KEY_MISMATCH', '该漫画归档使用了不同的码表或密码本');
    }
    if (file.size < header.dataOffset) {
        throw new ComicError('TRUNCATED_ARCHIVE', '漫画归档清单不完整');
    }

    const key = await comicCrypto.deriveBuiltinKey(header.salt);
    const manifestCipher = new Uint8Array(await file.slice(format.HEADER_SIZE, header.dataOffset).arrayBuffer());
    const manifestPlainLength = header.manifestCipherLength - format.AUTH_TAG_SIZE;
    const manifestBytes = await comicCrypto.decryptChunk(
        key,
        header.bytes,
        header.noncePrefix,
        0,
        manifestCipher,
        manifestPlainLength
    );
    const manifest = format.validateManifest(format.decodeManifest(manifestBytes), header, file.size);
    const sessionId = `${jobId}-${self.crypto.getRandomValues(new Uint32Array(1))[0].toString(16)}`;
    sessions.set(sessionId, { kind: 'archive', file, header, key, manifest, pageEntries: new Map(), bookId: '' });
    post('opened', jobId, {
        sessionId,
        createdAt: manifest.createdAt,
        totalSize: manifest.totalSize,
        pages: manifest.pages.map(page => ({
            name: page.name,
            type: page.type,
            size: page.size,
            lastModified: page.lastModified
        }))
    });
}

async function decryptPage(jobId, payload) {
    const session = sessions.get(payload.sessionId);
    const index = Number(payload.index);
    if (!session || !Number.isInteger(index) || index < 0 || index >= session.manifest.pages.length) {
        throw new ComicError('INVALID_SESSION', '漫画阅读会话已失效');
    }

    const page = session.manifest.pages[index];
    if (session.kind === 'history') {
        const storage = await getStorageBackend();
        const file = await storage.getFile(page.entryName);
        post('page', jobId, {
            sessionId: payload.sessionId,
            index,
            file,
            name: page.name,
            mime: page.type,
            size: page.size
        });
        return;
    }
    await ensureStorage(page.size);
    const storage = await getStorageBackend();
    const oldEntry = session.pageEntries.get(index);
    if (oldEntry) {
        await removeEntryQuietly(storage, oldEntry);
    }
    const entryName = `${TEMP_PREFIX}${payload.sessionId}-page-${index}`;
    let writable;
    try {
        const entry = await createWritableEntry(storage, entryName);
        writable = entry.writable;
        let written = 0;
        for (let localIndex = 0; localIndex < page.chunkCount; localIndex++) {
            assertNotCancelled(jobId);
            const plainLength = format.getPageChunkPlainLength(page, localIndex);
            const cipherOffset = format.getPageChunkCipherOffset(session.header, page, localIndex);
            const encrypted = new Uint8Array(await session.file
                .slice(cipherOffset, cipherOffset + plainLength + format.AUTH_TAG_SIZE)
                .arrayBuffer());
            const plain = await comicCrypto.decryptChunk(
                session.key,
                session.header.bytes,
                session.header.noncePrefix,
                page.firstChunk + localIndex,
                encrypted,
                plainLength
            );
            await writable.write(plain);
            written += plain.length;
        }
        await writable.close();
        writable = null;
        session.pageEntries.set(index, entryName);
        const file = await storage.getFile(entryName);
        post('page', jobId, { sessionId: payload.sessionId, index, file, name: page.name, mime: page.type, size: written });
    } catch (error) {
        if (writable) {
            try {
                await writable.abort();
            } catch (abortError) {
                // Ignore cleanup failures and report the original error.
            }
        }
        await removeEntryQuietly(storage, entryName);
        throw error;
    }
}

function makeCrcTable() {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index++) {
        let value = index;
        for (let bit = 0; bit < 8; bit++) {
            value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
        }
        table[index] = value >>> 0;
    }
    return table;
}

const CRC_TABLE = makeCrcTable();

function updateCrc32(crc, bytes) {
    let value = crc;
    for (let index = 0; index < bytes.length; index++) {
        value = CRC_TABLE[(value ^ bytes[index]) & 0xFF] ^ (value >>> 8);
    }
    return value >>> 0;
}

function getDosDateTime(timestamp) {
    const date = timestamp ? new Date(timestamp) : new Date();
    const year = Math.max(1980, Math.min(2107, date.getFullYear()));
    const time = ((date.getHours() & 0x1F) << 11)
        | ((date.getMinutes() & 0x3F) << 5)
        | ((Math.floor(date.getSeconds() / 2)) & 0x1F);
    const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, date: day };
}

function zipLocalHeader(nameBytes, stamp) {
    const bytes = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x04034B50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0808, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, stamp.time, true);
    view.setUint16(12, stamp.date, true);
    view.setUint16(26, nameBytes.length, true);
    bytes.set(nameBytes, 30);
    return bytes;
}

function zipDataDescriptor(crc, size) {
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x08074B50, true);
    view.setUint32(4, crc, true);
    view.setUint32(8, size, true);
    view.setUint32(12, size, true);
    return bytes;
}

function zipCentralHeader(record) {
    const bytes = new Uint8Array(46 + record.nameBytes.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x02014B50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0x0808, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, record.stamp.time, true);
    view.setUint16(14, record.stamp.date, true);
    view.setUint32(16, record.crc, true);
    view.setUint32(20, record.size, true);
    view.setUint32(24, record.size, true);
    view.setUint16(28, record.nameBytes.length, true);
    view.setUint32(42, record.offset, true);
    bytes.set(record.nameBytes, 46);
    return bytes;
}

function zipEnd(recordCount, centralSize, centralOffset) {
    const bytes = new Uint8Array(22);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x06054B50, true);
    view.setUint16(8, recordCount, true);
    view.setUint16(10, recordCount, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, centralOffset, true);
    return bytes;
}

function uniqueZipName(name, usedNames) {
    const safe = core.utils.sanitizeDownloadName(name, 'img');
    const dot = safe.lastIndexOf('.');
    const base = dot > 0 ? safe.slice(0, dot) : safe;
    const extension = dot > 0 ? safe.slice(dot) : '';
    let candidate = safe;
    let suffix = 2;
    while (usedNames.has(candidate.toLocaleLowerCase())) {
        candidate = `${base}-${suffix}${extension}`;
        suffix += 1;
    }
    usedNames.add(candidate.toLocaleLowerCase());
    return candidate;
}

async function decryptPageChunk(session, page, localIndex) {
    const plainLength = format.getPageChunkPlainLength(page, localIndex);
    const cipherOffset = format.getPageChunkCipherOffset(session.header, page, localIndex);
    const encrypted = new Uint8Array(await session.file
        .slice(cipherOffset, cipherOffset + plainLength + format.AUTH_TAG_SIZE)
        .arrayBuffer());
    return comicCrypto.decryptChunk(
        session.key,
        session.header.bytes,
        session.header.noncePrefix,
        page.firstChunk + localIndex,
        encrypted,
        plainLength
    );
}

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_CHUNK_TYPES = Object.freeze({
    IHDR: Uint8Array.from([73, 72, 68, 82]),
    IDAT: Uint8Array.from([73, 68, 65, 84]),
    IEND: Uint8Array.from([73, 69, 78, 68])
});
const PNG_IDAT_TARGET_BYTES = 1024 * 1024;
const PNG_STRIP_ROWS = 16;

function createPngChunk(type, data = new Uint8Array(0)) {
    const output = new Uint8Array(12 + data.length);
    const view = new DataView(output.buffer);
    view.setUint32(0, data.length, false);
    output.set(type, 4);
    output.set(data, 8);
    let crc = updateCrc32(0xFFFFFFFF, type);
    crc = updateCrc32(crc, data);
    view.setUint32(output.length - 4, (crc ^ 0xFFFFFFFF) >>> 0, false);
    return output;
}

function createPngHeader(width, height) {
    const data = new Uint8Array(13);
    const view = new DataView(data.buffer);
    view.setUint32(0, width, false);
    view.setUint32(4, height, false);
    data[8] = 8;
    data[9] = 6;
    return createPngChunk(PNG_CHUNK_TYPES.IHDR, data);
}

function isHeifMime(mime) {
    return mime === 'image/heic' || mime === 'image/heif';
}

function requestNativeDecode(file, pageName) {
    nativeDecodeSequence += 1;
    const requestId = `native-${Date.now().toString(36)}-${nativeDecodeSequence}`;
    return new Promise((resolve, reject) => {
        nativeDecodeRequests.set(requestId, { resolve, reject });
        post('nativeDecodeRequest', requestId, { requestId, file, name: pageName });
    });
}

async function createPageBitmap(file, pageName, mime) {
    if (typeof self.createImageBitmap !== 'function') {
        throw new ComicError('PNG_UNSUPPORTED', '当前浏览器不支持生成 PNG 长图');
    }
    try {
        try {
            return await self.createImageBitmap(file, { imageOrientation: 'from-image' });
        } catch (optionError) {
            return await self.createImageBitmap(file);
        }
    } catch (error) {
        if (!isHeifMime(mime)) {
            throw new ComicError('IMAGE_DECODE_FAILED', `无法解码图片“${pageName}”`);
        }
        try {
            const decoded = await requestNativeDecode(file, pageName);
            return await self.createImageBitmap(decoded);
        } catch (nativeError) {
            throw new ComicError('IMAGE_DECODE_FAILED', nativeError.message || `无法解码 HEIC/HEIF 图片“${pageName}”`);
        }
    }
}

async function getExportPageFile(jobId, session, sessionId, pageIndex) {
    const storage = await getStorageBackend();
    if (session.kind === 'history') {
        const page = session.manifest.pages[pageIndex];
        return { file: await storage.getFile(page.entryName), storage, entryName: '', temporary: false };
    }
    const cachedEntry = session.pageEntries.get(pageIndex);
    if (cachedEntry) {
        try {
            return { file: await storage.getFile(cachedEntry), storage, entryName: '', temporary: false };
        } catch (error) {
            session.pageEntries.delete(pageIndex);
        }
    }

    const page = session.manifest.pages[pageIndex];
    await ensureStorage(page.size);
    const entryName = `${TEMP_PREFIX}${sessionId}-${jobId}-png-page-${pageIndex}`;
    let writable;
    try {
        writable = (await createWritableEntry(storage, entryName)).writable;
        for (let localIndex = 0; localIndex < page.chunkCount; localIndex++) {
            assertNotCancelled(jobId);
            await writable.write(await decryptPageChunk(session, page, localIndex));
        }
        await writable.close();
        writable = null;
        return { file: await storage.getFile(entryName), storage, entryName, temporary: true };
    } catch (error) {
        if (writable) {
            try {
                await writable.abort();
            } catch (abortError) {
                // Report the original failure.
            }
        }
        await removeEntryQuietly(storage, entryName);
        throw error;
    }
}

async function releaseExportPage(reference) {
    if (reference && reference.temporary) {
        await removeEntryQuietly(reference.storage, reference.entryName);
    }
}

function estimatePngStorage(session, rawSize) {
    const estimated = session.manifest.pages.reduce((total, page) => {
        const multiplier = page.type === 'image/png' || page.type === 'image/bmp' ? 1.35
            : page.type === 'image/gif' ? 2
                : page.type === 'image/jpeg' || page.type === 'image/webp' ? 4
                    : 6;
        return total + page.size * multiplier;
    }, 0);
    return Math.min(rawSize, Math.ceil(estimated + 1024 * 1024));
}

function createIdatWriter(writable) {
    let chunks = [];
    let size = 0;
    const flush = async () => {
        if (!size) {
            return;
        }
        const data = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            data.set(chunk, offset);
            offset += chunk.length;
        }
        chunks = [];
        size = 0;
        await writable.write(createPngChunk(PNG_CHUNK_TYPES.IDAT, data));
    };
    return {
        async write(chunk) {
            chunks.push(chunk);
            size += chunk.length;
            if (size >= PNG_IDAT_TARGET_BYTES) {
                await flush();
            }
        },
        flush
    };
}

async function writeArchivePageToEntry(jobId, session, pageIndex, storage, entryName) {
    const page = session.manifest.pages[pageIndex];
    if (session.kind === 'uploads') {
        await copyStorageFile(jobId, storage, session.files[pageIndex], entryName);
        return storage.getFile(entryName);
    }
    let writable;
    try {
        writable = (await createWritableEntry(storage, entryName)).writable;
        for (let localIndex = 0; localIndex < page.chunkCount; localIndex++) {
            assertNotCancelled(jobId);
            await writable.write(await decryptPageChunk(session, page, localIndex));
        }
        await writable.close();
        writable = null;
        return await storage.getFile(entryName);
    } catch (error) {
        if (writable) {
            try {
                await writable.abort();
            } catch (abortError) {
                // Report the original failure.
            }
        }
        await removeEntryQuietly(storage, entryName);
        throw error;
    }
}

async function copyStorageFile(jobId, storage, sourceFile, destinationName) {
    let writable;
    try {
        writable = (await createWritableEntry(storage, destinationName)).writable;
        for (let offset = 0; offset < sourceFile.size; offset += format.CHUNK_SIZE) {
            assertNotCancelled(jobId);
            await writable.write(new Uint8Array(await sourceFile
                .slice(offset, Math.min(sourceFile.size, offset + format.CHUNK_SIZE))
                .arrayBuffer()));
        }
        await writable.close();
        writable = null;
    } catch (error) {
        if (writable) {
            try {
                await writable.abort();
            } catch (abortError) {
                // Report the original failure.
            }
        }
        await removeEntryQuietly(storage, destinationName);
        throw error;
    }
}

async function createHistoryCover(jobId, storage, sourceFile, entryName, pageName, mime) {
    const bitmap = await createPageBitmap(sourceFile, pageName, mime);
    try {
        const scale = Math.min(
            1,
            history.config.COVER_MAX_WIDTH / bitmap.width,
            history.config.COVER_MAX_HEIGHT / bitmap.height
        );
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = new self.OffscreenCanvas(width, height);
        const context = canvas.getContext('2d', { alpha: false });
        if (!context || typeof canvas.convertToBlob !== 'function') {
            throw new ComicError('COVER_UNSUPPORTED', '当前浏览器无法生成书架封面');
        }
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        context.drawImage(bitmap, 0, 0, width, height);
        assertNotCancelled(jobId);
        const blob = await canvas.convertToBlob({
            type: 'image/jpeg',
            quality: history.config.COVER_QUALITY
        });
        const writable = (await createWritableEntry(storage, entryName)).writable;
        try {
            await writable.write(blob);
            await writable.close();
        } catch (error) {
            await writable.abort();
            await removeEntryQuietly(storage, entryName);
            throw error;
        }
    } finally {
        bitmap.close();
    }
}

async function requestPersistentStorage() {
    if (self.navigator.storage && typeof self.navigator.storage.persist === 'function') {
        try {
            return await self.navigator.storage.persist();
        } catch (error) {
            return false;
        }
    }
    return false;
}

function postLongImageProgress(jobId, payload, processed, message) {
    const range = payload.progressRange;
    if (range && Number.isFinite(range.start) && Number.isFinite(range.end) && Number.isFinite(range.total)) {
        post('progress', jobId, {
            processed: Math.round(range.start + processed / 1000 * (range.end - range.start)),
            total: range.total,
            message
        });
        return;
    }
    post('progress', jobId, { processed, total: 1000, message });
}

async function exportLongImage(jobId, payload) {
    const session = sessions.get(payload.sessionId);
    if (!session) {
        throw new ComicError('INVALID_SESSION', '漫画阅读会话已失效');
    }
    if (typeof self.OffscreenCanvas !== 'function' || typeof self.CompressionStream !== 'function') {
        throw new ComicError('PNG_UNSUPPORTED', '当前浏览器不支持流式生成 PNG 长图，请升级浏览器');
    }

    const saveHistory = payload.saveHistory !== false
        && (session.kind === 'archive' || session.kind === 'uploads');
    const storage = await getStorageBackend();
    const stagingReferences = [];
    const promotedEntryNames = [];
    let historyCommitted = false;
    let bookId = '';
    let existingRecord = null;
    if (saveHistory) {
        bookId = await history.createBookId(session.header.bytes, session.file.size);
        existingRecord = await getHistoryRecord(bookId);
        try {
            await ensureStorage(session.manifest.totalSize);
        } catch (error) {
            if (error && error.code === 'INSUFFICIENT_STORAGE') {
                throw new ComicError('INSUFFICIENT_HISTORY_STORAGE', '空间不足，无法同时保存书架历史；可以改为仅生成 PNG');
            }
            throw error;
        }
    }

    const dimensions = [];
    let outputWidth = 0;
    let outputHeight = 0;
    try {
        for (let index = 0; index < session.manifest.pages.length; index++) {
            assertNotCancelled(jobId);
            let reference;
            let bitmap;
            try {
                if (saveHistory) {
                    const entryName = `${history.config.STAGING_PREFIX}${bookId}-${jobId}-page-${String(index).padStart(4, '0')}`;
                    const file = await writeArchivePageToEntry(jobId, session, index, storage, entryName);
                    reference = { file, storage, entryName, temporary: false, staging: true };
                    stagingReferences.push(reference);
                } else {
                    reference = await getExportPageFile(jobId, session, payload.sessionId, index);
                }
                bitmap = await createPageBitmap(
                    reference.file,
                    session.manifest.pages[index].name,
                    session.manifest.pages[index].type
                );
                if (!bitmap.width || !bitmap.height) {
                    throw new ComicError('DIMENSIONS_UNAVAILABLE', `无法读取图片“${session.manifest.pages[index].name}”的尺寸`);
                }
                dimensions.push({ width: bitmap.width, height: bitmap.height });
                outputWidth = Math.max(outputWidth, bitmap.width);
                outputHeight += bitmap.height;
                postLongImageProgress(
                    jobId,
                    payload,
                    Math.round((index + 1) / session.manifest.pages.length * 200),
                    `正在分析第 ${index + 1}/${session.manifest.pages.length} 页`
                );
            } finally {
                bitmap?.close();
                if (!saveHistory) {
                    await releaseExportPage(reference);
                }
            }
        }
        const rowBytes = 1 + outputWidth * 4;
        const rawSize = rowBytes * outputHeight;
        if (!Number.isSafeInteger(rawSize) || outputWidth > 0x7FFFFFFF || outputHeight > 0x7FFFFFFF) {
            throw new ComicError('LONG_IMAGE_TOO_LARGE', '合并后的 PNG 像素尺寸超出格式限制');
        }
        const largestPage = Math.max(...session.manifest.pages.map(page => page.size));
        await ensureStorage(estimatePngStorage(session, rawSize) + (saveHistory ? 0 : largestPage));
    } catch (error) {
        for (const reference of stagingReferences) {
            await removeEntryQuietly(storage, reference.entryName);
        }
        throw error;
    }
    const rowBytes = 1 + outputWidth * 4;
    const entryName = `${TEMP_PREFIX}${jobId}.png`;
    let writable;
    let compressionWriter;
    let compressionPump;

    try {
        const entry = await createWritableEntry(storage, entryName);
        writable = entry.writable;
        await writable.write(PNG_SIGNATURE);
        await writable.write(createPngHeader(outputWidth, outputHeight));

        const compressor = new self.CompressionStream('deflate');
        compressionWriter = compressor.writable.getWriter();
        const compressedReader = compressor.readable.getReader();
        const idatWriter = createIdatWriter(writable);
        compressionPump = (async () => {
            while (true) {
                const { value, done } = await compressedReader.read();
                if (done) {
                    break;
                }
                await idatWriter.write(value);
            }
            await idatWriter.flush();
        })();

        const previousRow = new Uint8Array(outputWidth * 4);
        const currentRow = new Uint8Array(outputWidth * 4);
        let processedRows = 0;
        for (let pageIndex = 0; pageIndex < session.manifest.pages.length; pageIndex++) {
            assertNotCancelled(jobId);
            const page = session.manifest.pages[pageIndex];
            const size = dimensions[pageIndex];
            let reference;
            let bitmap;
            try {
                reference = saveHistory
                    ? stagingReferences[pageIndex]
                    : await getExportPageFile(jobId, session, payload.sessionId, pageIndex);
                bitmap = await createPageBitmap(reference.file, page.name, page.type);
                if (bitmap.width !== size.width || bitmap.height !== size.height) {
                    throw new ComicError('IMAGE_SIZE_CHANGED', `图片“${page.name}”的尺寸读取不一致`);
                }
                const left = Math.floor((outputWidth - size.width) / 2);
                const canvas = new self.OffscreenCanvas(size.width, Math.min(PNG_STRIP_ROWS, size.height));
                let context = canvas.getContext('2d', { alpha: true, willReadFrequently: true });
                if (!context) {
                    throw new ComicError('PNG_UNSUPPORTED', '当前浏览器无法读取图片像素');
                }
                for (let sourceY = 0; sourceY < size.height; sourceY += PNG_STRIP_ROWS) {
                    assertNotCancelled(jobId);
                    const rows = Math.min(PNG_STRIP_ROWS, size.height - sourceY);
                    if (canvas.height !== rows) {
                        canvas.height = rows;
                        context = canvas.getContext('2d', { alpha: true, willReadFrequently: true });
                        if (!context) {
                            throw new ComicError('PNG_UNSUPPORTED', '当前浏览器无法读取图片像素');
                        }
                    }
                    context.clearRect(0, 0, size.width, rows);
                    context.drawImage(bitmap, 0, sourceY, size.width, rows, 0, 0, size.width, rows);
                    const pixels = context.getImageData(0, 0, size.width, rows).data;
                    const filtered = new Uint8Array(rowBytes * rows);
                    for (let row = 0; row < rows; row++) {
                        currentRow.fill(0);
                        const sourceOffset = row * size.width * 4;
                        currentRow.set(pixels.subarray(sourceOffset, sourceOffset + size.width * 4), left * 4);
                        const targetOffset = row * rowBytes;
                        filtered[targetOffset] = 2;
                        for (let byte = 0; byte < currentRow.length; byte++) {
                            filtered[targetOffset + 1 + byte] = (currentRow[byte] - previousRow[byte]) & 0xFF;
                        }
                        previousRow.set(currentRow);
                    }
                    await compressionWriter.write(filtered);
                    processedRows += rows;
                    postLongImageProgress(
                        jobId,
                        payload,
                        200 + Math.round(processedRows / outputHeight * 780),
                        `正在写入第 ${pageIndex + 1}/${session.manifest.pages.length} 页 PNG`
                    );
                }
            } finally {
                bitmap?.close();
                if (!saveHistory) {
                    await releaseExportPage(reference);
                }
            }
        }
        postLongImageProgress(jobId, payload, 990, '正在完成 PNG 压缩');
        await compressionWriter.close();
        compressionWriter = null;
        await compressionPump;
        await writable.write(createPngChunk(PNG_CHUNK_TYPES.IEND));
        await writable.close();
        writable = null;

        const file = await storage.getFile(entryName);
        const baseName = String(payload.outputName || 'comic').replace(/\.[^.]*$/, '') || 'comic';
        let book = null;
        let coverFile = null;
        if (saveHistory) {
            postLongImageProgress(jobId, payload, 995, '正在保存到漫画书架');
            const generation = `${Date.now().toString(36)}-${jobId.replace(/[^a-z0-9-]/gi, '')}`;
            const pages = [];
            for (let index = 0; index < session.manifest.pages.length; index++) {
                const source = stagingReferences[index].file;
                const destinationName = `${history.config.HISTORY_PREFIX}${bookId}-${generation}-page-${String(index).padStart(4, '0')}`;
                await copyStorageFile(jobId, storage, source, destinationName);
                promotedEntryNames.push(destinationName);
                const sourcePage = session.manifest.pages[index];
                pages.push({
                    name: sourcePage.name,
                    type: sourcePage.type,
                    size: sourcePage.size,
                    width: dimensions[index].width,
                    height: dimensions[index].height,
                    lastModified: sourcePage.lastModified,
                    entryName: destinationName
                });
            }
            const coverEntryName = `${history.config.HISTORY_PREFIX}${bookId}-${generation}-cover.jpg`;
            await createHistoryCover(
                jobId,
                storage,
                stagingReferences[0].file,
                coverEntryName,
                pages[0].name,
                pages[0].type
            );
            promotedEntryNames.push(coverEntryName);
            coverFile = await storage.getFile(coverEntryName);
            const now = Date.now();
            const record = await putHistoryRecord({
                schemaVersion: history.config.SCHEMA_VERSION,
                bookId,
                title: existingRecord?.title || baseName,
                sourceName: payload.sourceName || session.file.name || `${baseName}.ecomic`,
                storageKind: storage.kind,
                coverEntryName,
                coverMime: 'image/jpeg',
                totalSize: session.manifest.totalSize,
                pages,
                png: {
                    name: `${baseName}-long.png`,
                    width: outputWidth,
                    height: outputHeight,
                    size: file.size,
                    generatedAt: now
                },
                progress: existingRecord?.progress || { pageIndex: 0, pageRatio: 0 },
                createdAt: existingRecord?.createdAt || now,
                updatedAt: now,
                lastOpenedAt: existingRecord?.lastOpenedAt || 0
            });
            historyCommitted = true;
            await requestPersistentStorage();
            for (const reference of stagingReferences) {
                await removeEntryQuietly(storage, reference.entryName);
            }
            if (existingRecord) {
                for (const page of existingRecord.pages) {
                    await removeEntryQuietly(storage, page.entryName);
                }
                await removeEntryQuietly(storage, existingRecord.coverEntryName);
            }
            book = history.summarizeRecord(record);
        }
        post('complete', jobId, {
            kind: 'longImage',
            file,
            opfsName: entryName,
            storageKind: storage.kind,
            name: `${baseName}-long.png`,
            size: file.size,
            pages: session.manifest.pages.length,
            width: outputWidth,
            height: outputHeight,
            bookId: bookId || String(payload.bookId || ''),
            book,
            coverFile
        });
    } catch (error) {
        if (compressionWriter) {
            try {
                await compressionWriter.abort(error);
            } catch (abortError) {
                // Report the original failure.
            }
        }
        if (compressionPump) {
            try {
                await compressionPump;
            } catch (pumpError) {
                // Report the original failure.
            }
        }
        if (writable) {
            try {
                await writable.abort();
            } catch (abortError) {
                // Ignore cleanup failures and report the original error.
            }
        }
        await removeEntryQuietly(storage, entryName);
        for (const reference of stagingReferences) {
            await removeEntryQuietly(storage, reference.entryName);
        }
        if (!historyCommitted) {
            for (const name of promotedEntryNames) {
                await removeEntryQuietly(storage, name);
            }
        }
        throw error;
    }
}

async function exportZip(jobId, payload) {
    const session = sessions.get(payload.sessionId);
    if (!session) {
        throw new ComicError('INVALID_SESSION', '漫画阅读会话已失效');
    }
    await ensureStorage(session.manifest.totalSize);
    const storage = await getStorageBackend();
    const entryName = `${TEMP_PREFIX}${jobId}.zip`;
    let writable;

    try {
        const entry = await createWritableEntry(storage, entryName);
        writable = entry.writable;
        const centralRecords = [];
        const usedNames = new Set();
        let archiveOffset = 0;
        let processed = 0;

        for (let pageIndex = 0; pageIndex < session.manifest.pages.length; pageIndex++) {
            const page = session.manifest.pages[pageIndex];
            const name = uniqueZipName(page.name, usedNames);
            const nameBytes = new TextEncoder().encode(name);
            const stamp = getDosDateTime(page.lastModified);
            const localOffset = archiveOffset;
            const localHeader = zipLocalHeader(nameBytes, stamp);
            await writable.write(localHeader);
            archiveOffset += localHeader.length;
            let crc = 0xFFFFFFFF;

            for (let localIndex = 0; localIndex < page.chunkCount; localIndex++) {
                assertNotCancelled(jobId);
                const plainLength = format.getPageChunkPlainLength(page, localIndex);
                const cipherOffset = format.getPageChunkCipherOffset(session.header, page, localIndex);
                const encrypted = new Uint8Array(await session.file
                    .slice(cipherOffset, cipherOffset + plainLength + format.AUTH_TAG_SIZE)
                    .arrayBuffer());
                const plain = await comicCrypto.decryptChunk(
                    session.key,
                    session.header.bytes,
                    session.header.noncePrefix,
                    page.firstChunk + localIndex,
                    encrypted,
                    plainLength
                );
                crc = updateCrc32(crc, plain);
                await writable.write(plain);
                archiveOffset += plain.length;
                processed += plain.length;
                post('progress', jobId, {
                    processed,
                    total: session.manifest.totalSize,
                    message: `正在导出第 ${pageIndex + 1}/${session.manifest.pages.length} 页`
                });
            }

            crc = (crc ^ 0xFFFFFFFF) >>> 0;
            const descriptor = zipDataDescriptor(crc, page.size);
            await writable.write(descriptor);
            archiveOffset += descriptor.length;
            centralRecords.push({ nameBytes, stamp, crc, size: page.size, offset: localOffset });
        }

        const centralOffset = archiveOffset;
        for (const record of centralRecords) {
            const centralHeader = zipCentralHeader(record);
            await writable.write(centralHeader);
            archiveOffset += centralHeader.length;
        }
        const centralSize = archiveOffset - centralOffset;
        await writable.write(zipEnd(centralRecords.length, centralSize, centralOffset));
        await writable.close();
        writable = null;

        const file = await storage.getFile(entryName);
        const baseName = String(payload.outputName || 'comic').replace(/\.[^.]*$/, '') || 'comic';
        post('complete', jobId, {
            kind: 'zip',
            file,
            opfsName: entryName,
            storageKind: storage.kind,
            name: `${baseName}-originals.zip`,
            size: file.size,
            pages: centralRecords.length
        });
    } catch (error) {
        if (writable) {
            try {
                await writable.abort();
            } catch (abortError) {
                // Ignore cleanup failures and report the original error.
            }
        }
        await removeEntryQuietly(storage, entryName);
        throw error;
    }
}

async function historyList(jobId) {
    const records = await listHistoryRecords();
    const storage = await getStorageBackend();
    const books = [];
    for (const record of records) {
        let coverFile = null;
        if (record.coverEntryName) {
            try {
                coverFile = await storage.getFile(record.coverEntryName);
            } catch (error) {
                coverFile = null;
            }
        }
        books.push({ ...history.summarizeRecord(record), coverFile });
    }
    post('history', jobId, { books });
}

function createHistorySession(record, sessionId) {
    const manifest = {
        createdAt: record.createdAt,
        totalSize: record.totalSize,
        pages: record.pages
    };
    sessions.set(sessionId, {
        kind: 'history',
        manifest,
        pageEntries: new Map(),
        bookId: record.bookId
    });
    return manifest;
}

async function historyOpen(jobId, payload) {
    const record = await getHistoryRecord(String(payload.bookId || ''));
    if (!record) {
        throw new ComicError('HISTORY_NOT_FOUND', '这本漫画已不在书架中');
    }
    const now = Date.now();
    const updated = await putHistoryRecord({ ...record, lastOpenedAt: now });
    const sessionId = `${jobId}-history-${record.bookId}`;
    createHistorySession(updated, sessionId);
    post('opened', jobId, {
        sessionId,
        bookId: record.bookId,
        createdAt: record.createdAt,
        totalSize: record.totalSize,
        progress: record.progress,
        pages: record.pages.map(page => ({
            name: page.name,
            type: page.type,
            size: page.size,
            width: page.width,
            height: page.height,
            lastModified: page.lastModified
        }))
    });
}

async function historyProgress(jobId, payload) {
    const record = await getHistoryRecord(String(payload.bookId || ''));
    if (!record) {
        return;
    }
    const progress = history.normalizeProgress(payload.progress, record.pageCount);
    await putHistoryRecord({ ...record, progress, lastOpenedAt: Date.now() });
    post('historyProgressed', jobId, { bookId: record.bookId, progress });
}

async function historyRename(jobId, payload) {
    const record = await getHistoryRecord(String(payload.bookId || ''));
    if (!record) {
        throw new ComicError('HISTORY_NOT_FOUND', '这本漫画已不在书架中');
    }
    const title = history.normalizeTitle(payload.title);
    const updated = await putHistoryRecord({ ...record, title, updatedAt: Date.now() });
    post('historyRenamed', jobId, { book: history.summarizeRecord(updated) });
}

async function deleteOneHistoryBook(record, storage) {
    await removeHistoryRecord(record.bookId);
    for (const page of record.pages) {
        await removeEntryQuietly(storage, page.entryName);
    }
    await removeEntryQuietly(storage, record.coverEntryName);
    for (const [sessionId, session] of sessions) {
        if (session.bookId === record.bookId) {
            sessions.delete(sessionId);
        }
    }
}

async function historyDelete(jobId, payload) {
    const storage = await getStorageBackend();
    if (payload.bookId === '*') {
        const records = await listHistoryRecords();
        for (const record of records) {
            await deleteOneHistoryBook(record, storage);
        }
        post('historyDeleted', jobId, { bookId: '*', count: records.length });
        return;
    }
    const record = await getHistoryRecord(String(payload.bookId || ''));
    if (record) {
        await deleteOneHistoryBook(record, storage);
    }
    post('historyDeleted', jobId, { bookId: String(payload.bookId || ''), count: record ? 1 : 0 });
}

async function historyStorage(jobId) {
    let quota = 0;
    let usage = 0;
    let persisted = false;
    if (self.navigator.storage) {
        if (typeof self.navigator.storage.estimate === 'function') {
            const estimate = await self.navigator.storage.estimate();
            quota = Number(estimate.quota) || 0;
            usage = Number(estimate.usage) || 0;
        }
        if (typeof self.navigator.storage.persisted === 'function') {
            persisted = await self.navigator.storage.persisted();
        }
    }
    post('historyStorage', jobId, { quota, usage, persisted });
}

async function historyRedownload(jobId, payload) {
    const record = await getHistoryRecord(String(payload.bookId || ''));
    if (!record) {
        throw new ComicError('HISTORY_NOT_FOUND', '这本漫画已不在书架中');
    }
    const sessionId = `${jobId}-redownload-${record.bookId}`;
    createHistorySession(record, sessionId);
    try {
        await exportLongImage(jobId, {
            sessionId,
            outputName: record.title,
            saveHistory: false,
            bookId: record.bookId
        });
    } finally {
        sessions.delete(sessionId);
    }
}

async function historyArchive(jobId, payload) {
    const record = await getHistoryRecord(String(payload.bookId || ''));
    if (!record) {
        throw new ComicError('HISTORY_NOT_FOUND', '这本漫画已不在书架中');
    }
    const storage = await getStorageBackend();
    const files = [];
    for (const page of record.pages) {
        assertNotCancelled(jobId);
        const file = await storage.getFile(page.entryName);
        files.push(new File([file], page.name, { type: page.type, lastModified: page.lastModified }));
    }
    await encryptArchive(jobId, {
        files,
        outputName: record.title,
        addToShelf: false
    });
}

async function releasePage(payload) {
    const session = sessions.get(payload.sessionId);
    const index = Number(payload.index);
    if (!session || !session.pageEntries.has(index)) {
        return;
    }
    const storage = await getStorageBackend();
    await removeEntryQuietly(storage, session.pageEntries.get(index));
    session.pageEntries.delete(index);
}

async function closeSession(payload) {
    const session = sessions.get(payload.sessionId);
    if (!session) {
        return;
    }
    const storage = await getStorageBackend();
    for (const name of session.pageEntries.values()) {
        await removeEntryQuietly(storage, name);
    }
    sessions.delete(payload.sessionId);
}

async function releaseOutput(payload) {
    const storage = await getStorageBackend();
    await removeEntryQuietly(storage, payload.opfsName);
}

async function handleComicCommand(data, sink = messageSink) {
    messageSink = sink;
    const { type, jobId, payload = {} } = data || {};
    if (type === 'nativeDecodeResult') {
        const request = nativeDecodeRequests.get(payload.requestId);
        if (request) {
            nativeDecodeRequests.delete(payload.requestId);
            if (payload.error) {
                request.reject(new Error(payload.error));
            } else if (payload.file instanceof Blob) {
                request.resolve(payload.file);
            } else {
                request.reject(new Error('Android HEIC/HEIF 解码结果无效'));
            }
        }
        return;
    }
    if (type === 'cancel') {
        cancelledJobs.add(jobId);
        return;
    }

    try {
        if (type === 'cleanup') {
            await cleanupStaleEntries();
            post('cleaned', jobId);
        } else if (type === 'encrypt') {
            await encryptArchive(jobId, payload);
        } else if (type === 'open') {
            await openArchive(jobId, payload);
        } else if (type === 'page') {
            await decryptPage(jobId, payload);
        } else if (type === 'exportZip') {
            await exportZip(jobId, payload);
        } else if (type === 'exportLongImage') {
            await exportLongImage(jobId, payload);
        } else if (type === 'historyList') {
            await historyList(jobId);
        } else if (type === 'historyOpen') {
            await historyOpen(jobId, payload);
        } else if (type === 'historyDelete') {
            await historyDelete(jobId, payload);
        } else if (type === 'historyProgress') {
            await historyProgress(jobId, payload);
        } else if (type === 'historyRename') {
            await historyRename(jobId, payload);
        } else if (type === 'historyStorage') {
            await historyStorage(jobId);
        } else if (type === 'historyRedownload') {
            await historyRedownload(jobId, payload);
        } else if (type === 'historyArchive') {
            await historyArchive(jobId, payload);
        } else if (type === 'releasePage') {
            await releasePage(payload);
        } else if (type === 'closeSession') {
            await closeSession(payload);
        } else if (type === 'releaseOutput') {
            await releaseOutput(payload);
        }
    } catch (error) {
        if (error && error.code === 'CANCELLED') {
            post('cancelled', jobId);
        } else {
            post('error', jobId, toError(error));
        }
    } finally {
        if (type !== 'cancel') {
            cancelledJobs.delete(jobId);
        }
    }
}

if (IS_WORKER_CONTEXT) {
    self.addEventListener('message', event => {
        handleComicCommand(event.data, message => self.postMessage(message));
    });
} else {
    class LocalComicWorker {
        constructor() {
            this.listeners = { message: new Set(), error: new Set() };
            this.terminated = false;
        }

        addEventListener(type, listener) {
            this.listeners[type]?.add(listener);
        }

        postMessage(data) {
            if (this.terminated) {
                return;
            }
            handleComicCommand(data, message => {
                if (!this.terminated) {
                    this.listeners.message.forEach(listener => listener({ data: message }));
                }
            }).catch(error => {
                this.listeners.error.forEach(listener => listener({ error, message: error.message }));
            });
        }

        terminate() {
            this.terminated = true;
            this.listeners.message.clear();
            this.listeners.error.clear();
        }
    }

    self.Ecryptees.LocalComicWorker = LocalComicWorker;
}
