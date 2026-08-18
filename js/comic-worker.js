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
const HISTORY_ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const HISTORY_MUTATION_LOCK_NAME = 'ecryptees-history-mutation-v1';
const HISTORY_LEASE_DATABASE_NAME = 'ecryptees-history-lock-v1';
const HISTORY_LEASE_STORE = 'leases';
const HISTORY_LEASE_KEY = 'history-mutation';
const HISTORY_LEASE_TTL_MS = 30 * 1000;
const HISTORY_LEASE_RENEW_MS = 5 * 1000;
const sessions = new Map();
const cancelledJobs = new Set();
const nativeDecodeRequests = new Map();
let nativeDecodeSequence = 0;
let messageSink = message => self.postMessage(message);
let preferredStorageBackendPromise = null;
let opfsBackendPromise = null;
let indexedDbBackendPromise = null;
let historyDatabasePromise = null;
let historyLeaseDatabasePromise = null;
let codecTaskPool = null;
let historyMutationTail = Promise.resolve();
let historyMutationUsingLease = false;
let activeHistoryLeaseOwner = '';

const CODEC_WORKER_SOURCE = `
'use strict';
function nonce(prefix, counter) {
    const value = new Uint8Array(12);
    value.set(prefix, 0);
    new DataView(value.buffer).setUint32(8, counter, false);
    return value;
}
function aad(header, counter, plainLength) {
    const value = new Uint8Array(header.length + 8);
    value.set(header, 0);
    const view = new DataView(value.buffer);
    view.setUint32(header.length, counter, false);
    view.setUint32(header.length + 4, plainLength, false);
    return value;
}
self.onmessage = async event => {
    const task = event.data || {};
    try {
        if (task.operation === 'inspectImage') {
            const bitmap = await createImageBitmap(task.file);
            const result = { width: bitmap.width, height: bitmap.height };
            bitmap.close();
            self.postMessage({ taskId: task.taskId, result });
            return;
        }
        const bytes = new Uint8Array(task.bytes);
        const algorithm = {
            name: 'AES-GCM',
            iv: nonce(task.noncePrefix, task.counter),
            additionalData: aad(task.header, task.counter, task.plainLength),
            tagLength: 128
        };
        const output = task.operation === 'encryptChunk'
            ? await crypto.subtle.encrypt(algorithm, task.key, bytes)
            : await crypto.subtle.decrypt(algorithm, task.key, bytes);
        self.postMessage({ taskId: task.taskId, result: { bytes: output } }, [output]);
    } catch (error) {
        self.postMessage({
            taskId: task.taskId,
            error: { name: error && error.name || 'Error', message: error && error.message || '并行任务失败' }
        });
    }
};
`;

function normalizeParallelism(value) {
    return Math.max(1, Math.min(4, Math.trunc(Number(value) || 1)));
}

function cancelledTaskError() {
    return new ComicError('CANCELLED', '操作已取消');
}

async function runLocalCodecTask(operation, payload) {
    if (operation === 'inspectImage') {
        const bitmap = await self.createImageBitmap(payload.file);
        try {
            return { width: bitmap.width, height: bitmap.height };
        } finally {
            bitmap.close();
        }
    }
    if (operation === 'encryptChunk') {
        return {
            bytes: (await comicCrypto.encryptChunk(
                payload.key,
                payload.header,
                payload.noncePrefix,
                payload.counter,
                new Uint8Array(payload.bytes)
            )).buffer
        };
    }
    return {
        bytes: (await comicCrypto.decryptChunk(
            payload.key,
            payload.header,
            payload.noncePrefix,
            payload.counter,
            new Uint8Array(payload.bytes),
            payload.plainLength
        )).buffer
    };
}

class CodecTaskPool {
    constructor(size) {
        this.size = normalizeParallelism(size);
        this.sequence = 0;
        this.queue = [];
        this.slots = [];
        this.workerUrl = '';
        if (typeof self.Worker === 'function' && typeof self.Blob === 'function'
            && self.URL && typeof self.URL.createObjectURL === 'function') {
            try {
                this.workerUrl = self.URL.createObjectURL(new self.Blob([CODEC_WORKER_SOURCE], { type: 'text/javascript' }));
                for (let index = 0; index < this.size; index++) {
                    this.slots.push(this.createSlot());
                }
            } catch (error) {
                this.closeWorkers();
            }
        }
    }

    createSlot() {
        const slot = { worker: new self.Worker(this.workerUrl), task: null };
        slot.worker.addEventListener('message', event => {
            const task = slot.task;
            if (!task || event.data?.taskId !== task.taskId) {
                return;
            }
            slot.task = null;
            if (event.data.error) {
                task.reject(new Error(event.data.error.message || '并行任务失败'));
            } else {
                task.resolve(event.data.result);
            }
            this.dispatch();
        });
        slot.worker.addEventListener('error', event => {
            this.fallbackToLocal(slot.task, new Error(event.message || '并行工作线程意外停止'));
        });
        return slot;
    }

    run(jobId, operation, payload) {
        if (!this.slots.length) {
            return runLocalCodecTask(operation, payload);
        }
        return new Promise((resolve, reject) => {
            this.queue.push({
                taskId: `codec-${++this.sequence}`,
                jobId,
                operation,
                payload,
                resolve,
                reject
            });
            this.dispatch();
        });
    }

    dispatch() {
        for (const slot of this.slots) {
            if (slot.task || !this.queue.length) {
                continue;
            }
            const task = this.queue.shift();
            slot.task = task;
            const data = { taskId: task.taskId, operation: task.operation, ...task.payload };
            try {
                const transfer = task.operation === 'inspectImage' ? [] : [data.bytes];
                slot.worker.postMessage(data, transfer);
            } catch (error) {
                slot.task = null;
                this.fallbackToLocal(task, error);
            }
        }
    }

    fallbackToLocal(extraTask = null, failure = null) {
        const tasks = [];
        if (extraTask) {
            tasks.push(extraTask);
        }
        tasks.push(...this.queue);
        this.queue = [];
        for (const slot of this.slots) {
            if (slot.task && slot.task !== extraTask) {
                tasks.push(slot.task);
            }
            slot.task = null;
            slot.worker.terminate();
        }
        this.slots = [];
        if (this.workerUrl) {
            self.URL.revokeObjectURL(this.workerUrl);
            this.workerUrl = '';
        }
        for (const task of tasks) {
            const canRetry = task.operation === 'inspectImage'
                || !(task.payload.bytes instanceof ArrayBuffer)
                || task.payload.bytes.byteLength > 0;
            if (canRetry) {
                runLocalCodecTask(task.operation, task.payload).then(task.resolve, task.reject);
            } else {
                task.reject(failure || new Error('并行工作线程意外停止'));
            }
        }
    }

    cancelJob(jobId) {
        const retained = [];
        for (const task of this.queue) {
            if (task.jobId === jobId) {
                task.reject(cancelledTaskError());
            } else {
                retained.push(task);
            }
        }
        this.queue = retained;
        for (let index = 0; index < this.slots.length; index++) {
            const slot = this.slots[index];
            if (slot.task?.jobId !== jobId) {
                continue;
            }
            slot.task.reject(cancelledTaskError());
            slot.worker.terminate();
            this.slots[index] = this.createSlot();
        }
        this.dispatch();
    }

    isIdle() {
        return this.queue.length === 0 && this.slots.every(slot => !slot.task);
    }

    closeWorkers() {
        for (const task of this.queue) {
            task.reject(new Error('并行工作线程不可用'));
        }
        this.queue = [];
        for (const slot of this.slots) {
            slot.task?.reject(new Error('并行工作线程不可用'));
            slot.worker.terminate();
        }
        this.slots = [];
        if (this.workerUrl) {
            self.URL.revokeObjectURL(this.workerUrl);
            this.workerUrl = '';
        }
    }
}

function getCodecTaskPool(parallelism) {
    const size = normalizeParallelism(parallelism);
    if (codecTaskPool && codecTaskPool.size !== size && codecTaskPool.isIdle()) {
        codecTaskPool.closeWorkers();
        codecTaskPool = null;
    }
    if (!codecTaskPool) {
        codecTaskPool = new CodecTaskPool(size);
    }
    return codecTaskPool;
}

async function runBounded(count, parallelism, operation) {
    const results = new Array(count);
    let nextIndex = 0;
    let firstError = null;
    async function lane() {
        while (!firstError) {
            const index = nextIndex++;
            if (index >= count) {
                return;
            }
            try {
                results[index] = await operation(index);
            } catch (error) {
                firstError ||= error;
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(count, normalizeParallelism(parallelism)) }, lane));
    if (firstError) {
        throw firstError;
    }
    return results;
}

async function encryptChunkWithPool(jobId, pool, key, header, noncePrefix, counter, bytes) {
    const source = bytes instanceof ArrayBuffer
        ? bytes
        : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const result = await pool.run(jobId, 'encryptChunk', {
        key,
        header,
        noncePrefix,
        counter,
        plainLength: source.byteLength,
        bytes: source
    });
    return new Uint8Array(result.bytes);
}

async function decryptChunkWithPool(jobId, pool, key, header, noncePrefix, counter, bytes, plainLength) {
    const source = bytes instanceof ArrayBuffer
        ? bytes
        : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    try {
        const result = await pool.run(jobId, 'decryptChunk', {
            key,
            header,
            noncePrefix,
            counter,
            plainLength,
            bytes: source
        });
        return new Uint8Array(result.bytes);
    } catch (error) {
        if (error?.code === 'CANCELLED') {
            throw error;
        }
        throw new ComicError('AUTHENTICATION_FAILED', '漫画归档校验失败，文件可能已损坏或被篡改');
    }
}

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

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function openHistoryLeaseDatabase() {
    if (!historyLeaseDatabasePromise) {
        historyLeaseDatabasePromise = new Promise((resolve, reject) => {
            const request = self.indexedDB.open(HISTORY_LEASE_DATABASE_NAME, 1);
            request.onupgradeneeded = () => {
                const database = request.result;
                if (!database.objectStoreNames.contains(HISTORY_LEASE_STORE)) {
                    database.createObjectStore(HISTORY_LEASE_STORE);
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('漫画书架跨窗口锁不可用'));
        });
    }
    return historyLeaseDatabasePromise;
}

async function updateHistoryLease(owner, operation) {
    const database = await openHistoryLeaseDatabase();
    const transaction = database.transaction(HISTORY_LEASE_STORE, 'readwrite');
    const store = transaction.objectStore(HISTORY_LEASE_STORE);
    const current = await requestToPromise(store.get(HISTORY_LEASE_KEY));
    const now = Date.now();
    let updated = false;
    if (operation === 'acquire' && (!current || current.owner === owner || current.expiresAt <= now)) {
        store.put({ owner, expiresAt: now + HISTORY_LEASE_TTL_MS }, HISTORY_LEASE_KEY);
        updated = true;
    } else if (operation === 'renew' && current?.owner === owner && current.expiresAt > now) {
        store.put({ owner, expiresAt: now + HISTORY_LEASE_TTL_MS }, HISTORY_LEASE_KEY);
        updated = true;
    } else if (operation === 'release' && current?.owner === owner) {
        store.delete(HISTORY_LEASE_KEY);
        updated = true;
    }
    await transactionToPromise(transaction);
    return updated;
}

async function assertHistoryMutationOwnership() {
    if (!historyMutationUsingLease) {
        return;
    }
    if (!activeHistoryLeaseOwner) {
        throw new ComicError('HISTORY_LOCK_LOST', '漫画书架被其他窗口修改，请重试');
    }
    const database = await openHistoryLeaseDatabase();
    const transaction = database.transaction(HISTORY_LEASE_STORE, 'readonly');
    const current = await requestToPromise(transaction.objectStore(HISTORY_LEASE_STORE).get(HISTORY_LEASE_KEY));
    await transactionToPromise(transaction);
    if (current?.owner !== activeHistoryLeaseOwner || current.expiresAt <= Date.now()) {
        activeHistoryLeaseOwner = '';
        throw new ComicError('HISTORY_LOCK_LOST', '漫画书架被其他窗口修改，请重试');
    }
}

async function withHistoryLease(task) {
    const owner = typeof self.crypto?.randomUUID === 'function'
        ? self.crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    while (!(await updateHistoryLease(owner, 'acquire'))) {
        await delay(50 + Math.trunc(Math.random() * 100));
    }
    historyMutationUsingLease = true;
    activeHistoryLeaseOwner = owner;
    const renewal = setInterval(() => {
        updateHistoryLease(owner, 'renew').then(renewed => {
            if (!renewed && activeHistoryLeaseOwner === owner) activeHistoryLeaseOwner = '';
        }).catch(() => {
            if (activeHistoryLeaseOwner === owner) activeHistoryLeaseOwner = '';
        });
    }, HISTORY_LEASE_RENEW_MS);
    try {
        return await task();
    } finally {
        clearInterval(renewal);
        if (activeHistoryLeaseOwner === owner) activeHistoryLeaseOwner = '';
        historyMutationUsingLease = false;
        await updateHistoryLease(owner, 'release').catch(() => {});
    }
}

function withHistoryMutation(task) {
    const crossContextTask = () => self.navigator?.locks?.request
        ? self.navigator.locks.request(HISTORY_MUTATION_LOCK_NAME, { mode: 'exclusive' }, task)
        : withHistoryLease(task);
    const run = historyMutationTail.catch(() => {}).then(crossContextTask);
    historyMutationTail = run.catch(() => {});
    return run;
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
    const record = await getRawHistoryRecord(bookId);
    return record ? history.validateRecord(record) : null;
}

async function getRawHistoryRecord(bookId) {
    const database = await openHistoryDatabase();
    const transaction = database.transaction(history.config.BOOK_STORE, 'readonly');
    const record = await requestToPromise(transaction.objectStore(history.config.BOOK_STORE).get(bookId));
    await transactionToPromise(transaction);
    return record || null;
}

async function readHistoryRecords() {
    const database = await openHistoryDatabase();
    const transaction = database.transaction(history.config.BOOK_STORE, 'readonly');
    const rawRecords = await requestToPromise(transaction.objectStore(history.config.BOOK_STORE).getAll());
    await transactionToPromise(transaction);
    const records = [];
    const invalidRecords = [];
    for (const rawRecord of rawRecords) {
        try {
            records.push(history.validateRecord(rawRecord));
        } catch (error) {
            invalidRecords.push({
                bookId: /^[0-9a-f]{32}$/.test(rawRecord?.bookId || '') ? rawRecord.bookId : '',
                title: history.normalizeTitle(rawRecord?.title),
                message: error?.message || '漫画元数据损坏'
            });
        }
    }
    records.sort((left, right) => (right.lastOpenedAt || right.updatedAt) - (left.lastOpenedAt || left.updatedAt));
    return { records, invalidRecords };
}

async function listHistoryRecords() {
    return (await readHistoryRecords()).records;
}

async function putHistoryRecord(record) {
    const valid = history.validateRecord(record);
    await assertHistoryMutationOwnership();
    const database = await openHistoryDatabase();
    const transaction = database.transaction(history.config.BOOK_STORE, 'readwrite');
    transaction.objectStore(history.config.BOOK_STORE).put(valid);
    await transactionToPromise(transaction);
    return valid;
}

async function removeHistoryRecord(bookId) {
    await assertHistoryMutationOwnership();
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
        async has(name) {
            const metaTransaction = database.transaction('entries', 'readonly');
            const metadata = await requestToPromise(metaTransaction.objectStore('entries').get(name));
            await transactionToPromise(metaTransaction);
            if (!metadata || !Number.isInteger(metadata.parts) || metadata.parts < 1) {
                return false;
            }
            const partsTransaction = database.transaction('parts', 'readonly');
            const range = IDBKeyRange.bound(`${name}:`, `${name}:\uffff`);
            const partCount = await requestToPromise(partsTransaction.objectStore('parts').count(range));
            await transactionToPromise(partsTransaction);
            return partCount === metadata.parts;
        },
        async listCompleteNames() {
            const metaTransaction = database.transaction('entries', 'readonly');
            const metadataPromise = requestToPromise(metaTransaction.objectStore('entries').getAll());
            const namesPromise = requestToPromise(metaTransaction.objectStore('entries').getAllKeys());
            const [metadata, names] = await Promise.all([metadataPromise, namesPromise]);
            await transactionToPromise(metaTransaction);

            const partsTransaction = database.transaction('parts', 'readonly');
            const partKeys = await requestToPromise(partsTransaction.objectStore('parts').getAllKeys());
            await transactionToPromise(partsTransaction);
            const partCounts = new Map();
            for (const rawKey of partKeys) {
                const key = String(rawKey);
                const separator = key.lastIndexOf(':');
                if (separator <= 0) continue;
                const name = key.slice(0, separator);
                partCounts.set(name, (partCounts.get(name) || 0) + 1);
            }
            const complete = new Set();
            for (let index = 0; index < names.length; index++) {
                const name = String(names[index]);
                const expected = metadata[index]?.parts;
                if (Number.isInteger(expected) && expected > 0 && partCounts.get(name) === expected) {
                    complete.add(name);
                }
            }
            return complete;
        },
        async remove(name) {
            await deleteParts(name);
            const transaction = database.transaction('entries', 'readwrite');
            transaction.objectStore('entries').delete(name);
            await transactionToPromise(transaction);
        },
        async listNames() {
            const transaction = database.transaction('entries', 'readonly');
            const keys = await requestToPromise(transaction.objectStore('entries').getAllKeys());
            await transactionToPromise(transaction);
            return keys.map(String);
        },
        async cleanup(cutoff, removeAllTemporary = false) {
            const transaction = database.transaction('entries', 'readonly');
            const store = transaction.objectStore('entries');
            const entriesPromise = requestToPromise(store.getAll());
            const keysPromise = requestToPromise(store.getAllKeys());
            const [entries, keys] = await Promise.all([entriesPromise, keysPromise]);
            await transactionToPromise(transaction);
            for (let index = 0; index < keys.length; index++) {
                const name = String(keys[index]);
                if (name.startsWith(history.config.STAGING_PREFIX)
                    || (name.startsWith(TEMP_PREFIX)
                        && (removeAllTemporary || entries[index].lastModified < cutoff))) {
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
        async has(name) {
            try {
                await root.getFileHandle(name);
                return true;
            } catch (error) {
                if (error?.name === 'NotFoundError') {
                    return false;
                }
                throw error;
            }
        },
        async listCompleteNames() {
            return new Set(await this.listNames());
        },
        async remove(name) {
            await root.removeEntry(name);
        },
        async listNames() {
            const names = [];
            for await (const [name, handle] of root.entries()) {
                if (handle.kind === 'file') {
                    names.push(name);
                }
            }
            return names;
        },
        async cleanup(cutoff, removeAllTemporary = false) {
            for await (const [name, handle] of root.entries()) {
                if (handle.kind === 'file' && isTemporaryEntryName(name)) {
                    try {
                        const file = await handle.getFile();
                        if (name.startsWith(history.config.STAGING_PREFIX)
                            || (name.startsWith(TEMP_PREFIX)
                                && (removeAllTemporary || file.lastModified < cutoff))) {
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

async function getOpfsBackend() {
    if (!opfsBackendPromise) {
        opfsBackendPromise = createOpfsBackend().catch(error => {
            opfsBackendPromise = null;
            throw error;
        });
    }
    return opfsBackendPromise;
}

async function getIndexedDbBackend() {
    if (!indexedDbBackendPromise) {
        indexedDbBackendPromise = createIndexedDbBackend().catch(error => {
            indexedDbBackendPromise = null;
            throw error;
        });
    }
    return indexedDbBackendPromise;
}

async function getStorageBackend(kind = '') {
    if (kind === 'opfs') {
        return getOpfsBackend();
    }
    if (kind === 'indexeddb') {
        return getIndexedDbBackend();
    }
    if (!preferredStorageBackendPromise) {
        preferredStorageBackendPromise = (async () => {
            try {
                return await getOpfsBackend();
            } catch (error) {
                return getIndexedDbBackend();
            }
        })();
    }
    return preferredStorageBackendPromise;
}

async function getAvailableStorageBackends() {
    const backends = [];
    try {
        backends.push(await getOpfsBackend());
    } catch (error) {
        // OPFS is optional on older Android System WebView versions.
    }
    try {
        backends.push(await getIndexedDbBackend());
    } catch (error) {
        // Report the original operation error if neither backend is available.
    }
    if (!backends.length) {
        backends.push(await getStorageBackend());
    }
    return backends;
}

function formatStorageGigabytes(bytes) {
    return `${(Math.max(0, Number(bytes) || 0) / 1_000_000_000).toFixed(2)} GB`;
}

async function ensureStorage(requiredBytes, availableStorageBytes = null) {
    const availableCandidates = [];
    const nativeAvailable = availableStorageBytes === null || availableStorageBytes === undefined
        ? NaN
        : Number(availableStorageBytes);
    if (Number.isFinite(nativeAvailable) && nativeAvailable >= 0) {
        availableCandidates.push(nativeAvailable);
    }
    if (self.navigator.storage && typeof self.navigator.storage.estimate === 'function') {
        const estimate = await self.navigator.storage.estimate();
        if (Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage)) {
            availableCandidates.push(Math.max(0, estimate.quota - estimate.usage));
        }
    }
    if (availableCandidates.length) {
        const available = Math.min(...availableCandidates);
        const required = Math.max(0, Number(requiredBytes) || 0) + format.STORAGE_RESERVE_BYTES;
        if (available < required) {
            const source = Number.isFinite(nativeAvailable) && nativeAvailable >= 0 ? '设备实际' : '浏览器估算';
            throw new ComicError(
                'INSUFFICIENT_STORAGE',
                `本次操作至少需要 ${formatStorageGigabytes(required)} 可用空间，当前${source}可用 ${formatStorageGigabytes(available)}`
            );
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

function getHistoryEntryCreatedAt(name) {
    if (!name.startsWith(history.config.HISTORY_PREFIX)) {
        return 0;
    }
    const suffix = name.slice(history.config.HISTORY_PREFIX.length);
    const match = /^[0-9a-f]{32}-([a-z0-9]+)-/.exec(suffix);
    const createdAt = match ? Number.parseInt(match[1], 36) : 0;
    return Number.isSafeInteger(createdAt) && createdAt > 0 ? createdAt : 0;
}

async function cleanupStaleEntries(removeAllTemporary = false) {
    return withHistoryMutation(async () => {
        const backends = await getAvailableStorageBackends();
        for (const backend of backends) {
            await backend.cleanup(Date.now() - 24 * 60 * 60 * 1000, removeAllTemporary);
        }

        const historyState = await readHistoryRecords();
        let records = historyState.records;
        if (removeAllTemporary) {
            const updatedRecords = [];
            for (const record of records) {
                const legacyLongImage = record.png?.entryName || '';
                if (!legacyLongImage) {
                    updatedRecords.push(record);
                    continue;
                }
                try {
                    const recordStorage = await getStorageBackend(record.storageKind);
                    const updatedRecord = await putHistoryRecord({
                        ...record,
                        png: {
                            ...record.png,
                            width: 1,
                            height: 1,
                            size: 0,
                            generatedAt: 0,
                            entryName: ''
                        }
                    });
                    updatedRecords.push(updatedRecord);
                    await removeEntryQuietly(recordStorage, legacyLongImage);
                } catch (error) {
                    updatedRecords.push(record);
                }
            }
            records = updatedRecords;
        }

        if (!historyState.invalidRecords.length) {
            const referencedByKind = new Map([
                ['opfs', new Set()],
                ['indexeddb', new Set()]
            ]);
            for (const record of records) {
                const referenced = referencedByKind.get(record.storageKind);
                referenced.add(record.coverEntryName);
                referenced.add(record.png?.entryName);
                for (const page of record.pages) {
                    referenced.add(page.entryName);
                }
            }
            const orphanCutoff = Date.now() - HISTORY_ORPHAN_GRACE_MS;
            for (const storage of backends) {
                const referenced = referencedByKind.get(storage.kind);
                for (const name of await storage.listNames()) {
                    const createdAt = getHistoryEntryCreatedAt(name);
                    if (createdAt > 0 && createdAt < orphanCutoff && !referenced.has(name)) {
                        await removeEntryQuietly(storage, name);
                    }
                }
            }
        }
        return historyState.invalidRecords;
    });
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
    await ensureStorage(
        expectedSize + (payload.addToShelf === false ? 0 : manifest.totalSize),
        payload.availableStorageBytes
    );
    assertNotCancelled(jobId);

    const key = await comicCrypto.deriveBuiltinKey(salt);
    const requestedParallelism = normalizeParallelism(payload.parallelism);
    const parallelism = manifest.totalSize < format.CHUNK_SIZE * 16
        ? Math.min(2, requestedParallelism)
        : requestedParallelism;
    const pool = getCodecTaskPool(parallelism);
    const encryptedManifest = await encryptChunkWithPool(
        jobId, pool, key, headerBytes, noncePrefix, 0, manifestBytes
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

        const chunks = [];
        let counter = 1;
        for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
            const file = files[fileIndex];
            for (let offset = 0; offset < file.size; offset += format.CHUNK_SIZE) {
                counter += 1;
                chunks.push({
                    file,
                    fileIndex,
                    offset,
                    plainLength: Math.min(format.CHUNK_SIZE, file.size - offset),
                    counter: counter - 1
                });
            }
        }

        const pending = new Array(chunks.length);
        const startChunk = index => {
            const chunk = chunks[index];
            pending[index] = (async () => {
                assertNotCancelled(jobId);
                const plain = await chunk.file.slice(chunk.offset, chunk.offset + chunk.plainLength).arrayBuffer();
                const encrypted = await encryptChunkWithPool(
                    jobId,
                    pool,
                    key,
                    header.bytes,
                    header.noncePrefix,
                    chunk.counter,
                    plain
                );
                return { encrypted, plainLength: chunk.plainLength, fileIndex: chunk.fileIndex };
            })();
        };
        for (let index = 0; index < Math.min(parallelism, chunks.length); index++) {
            startChunk(index);
        }
        let processed = 0;
        for (let index = 0; index < chunks.length; index++) {
            assertNotCancelled(jobId);
            const result = await pending[index];
            await writable.write(result.encrypted);
            processed += result.plainLength;
            if (index + parallelism < chunks.length) {
                startChunk(index + parallelism);
            }
            post('progress', jobId, {
                processed: Math.round(processed / manifest.totalSize * 500),
                total: 1000,
                message: `正在封装第 ${result.fileIndex + 1}/${files.length} 页`
            });
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
            post(payload.resultType === 'historyExport' ? 'historyArchiveReady' : 'portableArchive', jobId, archiveMessage);
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
            bookId: '',
            availableStorageBytes: payload.availableStorageBytes
        });
        try {
            await saveHistorySession(jobId, {
                sessionId,
                outputName,
                sourceName: `${outputName}.${format.EXTENSION}`,
                parallelism,
                availableStorageBytes: payload.availableStorageBytes,
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

async function createArchiveSession(jobId, file, availableStorageBytes = null) {
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
    const pool = getCodecTaskPool(1);
    const manifestBytes = await decryptChunkWithPool(
        jobId, pool, key, header.bytes, header.noncePrefix, 0, manifestCipher, manifestPlainLength
    );
    const manifest = format.validateManifest(format.decodeManifest(manifestBytes), header, file.size);
    const sessionId = `${jobId}-${self.crypto.getRandomValues(new Uint32Array(1))[0].toString(16)}`;
    sessions.set(sessionId, {
        kind: 'archive',
        file,
        header,
        key,
        manifest,
        pageEntries: new Map(),
        bookId: '',
        availableStorageBytes
    });
    return { sessionId, manifest };
}

async function openArchive(jobId, payload) {
    const { sessionId, manifest } = await createArchiveSession(jobId, payload.file, payload.availableStorageBytes);
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
        const storage = await getStorageBackend(session.storageKind);
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
    await ensureStorage(page.size, session.availableStorageBytes);
    const storage = await getStorageBackend();
    const pool = getCodecTaskPool(payload.parallelism);
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
            const plain = await decryptChunkWithPool(
                jobId,
                pool,
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

async function decryptPageChunk(jobId, pool, session, page, localIndex) {
    const plainLength = format.getPageChunkPlainLength(page, localIndex);
    const cipherOffset = format.getPageChunkCipherOffset(session.header, page, localIndex);
    const encrypted = new Uint8Array(await session.file
        .slice(cipherOffset, cipherOffset + plainLength + format.AUTH_TAG_SIZE)
        .arrayBuffer());
    return decryptChunkWithPool(
        jobId,
        pool,
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

async function inspectPageWithPool(jobId, pool, file, pageName, mime) {
    try {
        const result = await pool.run(jobId, 'inspectImage', { file });
        if (result.width > 0 && result.height > 0) {
            return result;
        }
    } catch (error) {
        if (error?.code === 'CANCELLED') {
            throw error;
        }
    }
    const bitmap = await createPageBitmap(file, pageName, mime);
    try {
        return { width: bitmap.width, height: bitmap.height };
    } finally {
        bitmap.close();
    }
}

async function getExportPageFile(jobId, pool, session, sessionId, pageIndex) {
    const storage = await getStorageBackend(session.kind === 'history' ? session.storageKind : '');
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
    await ensureStorage(page.size, session.availableStorageBytes);
    const entryName = `${TEMP_PREFIX}${sessionId}-${jobId}-png-page-${pageIndex}`;
    let writable;
    try {
        writable = (await createWritableEntry(storage, entryName)).writable;
        for (let localIndex = 0; localIndex < page.chunkCount; localIndex++) {
            assertNotCancelled(jobId);
            await writable.write(await decryptPageChunk(jobId, pool, session, page, localIndex));
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

async function writeArchivePageToEntry(jobId, pool, session, pageIndex, storage, entryName) {
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
            await writable.write(await decryptPageChunk(jobId, pool, session, page, localIndex));
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

async function createHistoryThumbnail(jobId, sourceFile, pageName, mime) {
    const bitmap = await createPageBitmap(sourceFile, pageName, mime);
    try {
        const scale = Math.min(1, 224 / bitmap.width, 200 / bitmap.height);
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = new self.OffscreenCanvas(width, height);
        const context = canvas.getContext('2d', { alpha: false });
        if (!context || typeof canvas.convertToBlob !== 'function') {
            throw new ComicError('THUMBNAIL_UNSUPPORTED', '当前浏览器无法生成页面缩略图');
        }
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        context.drawImage(bitmap, 0, 0, width, height);
        assertNotCancelled(jobId);
        return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
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

async function saveHistorySession(jobId, payload) {
    return withHistoryMutation(() => saveHistorySessionUnlocked(jobId, payload));
}

async function saveHistorySessionUnlocked(jobId, payload) {
    const session = sessions.get(payload.sessionId);
    if (!session || (session.kind !== 'archive' && session.kind !== 'uploads')) {
        throw new ComicError('INVALID_SESSION', '漫画阅读会话已失效');
    }
    const storage = await getStorageBackend();
    const parallelism = Math.min(
        normalizeParallelism(payload.parallelism),
        session.manifest.pages.length
    );
    const pool = getCodecTaskPool(parallelism);
    const requestedBookId = String(payload.bookId || '').toLowerCase();
    const bookId = /^[a-f0-9]{32}$/.test(requestedBookId)
        ? requestedBookId
        : await history.createBookId(session.header.bytes, session.file.size);
    const existingRawRecord = await getRawHistoryRecord(bookId);
    let existingRecord = null;
    if (existingRawRecord) {
        try {
            existingRecord = history.validateRecord(existingRawRecord);
        } catch (error) {
            if (!(error instanceof TypeError)) {
                throw error;
            }
            // Re-importing the same archive may repair malformed metadata, but storage errors must abort.
        }
    }
    const generation = `${Date.now().toString(36)}-${jobId.replace(/[^a-z0-9-]/gi, '')}`;
    const pageReferences = new Array(session.manifest.pages.length);
    const dimensions = new Array(session.manifest.pages.length);
    const newEntryNames = [];
    let historyCommitted = false;

    try {
        await ensureStorage(
            session.manifest.totalSize,
            payload.availableStorageBytes ?? session.availableStorageBytes
        );
        let savedPages = 0;
        await runBounded(session.manifest.pages.length, parallelism, async index => {
            assertNotCancelled(jobId);
            const sourcePage = session.manifest.pages[index];
            const pageEntryName = `${history.config.HISTORY_PREFIX}${bookId}-${generation}-page-${String(index).padStart(4, '0')}`;
            newEntryNames.push(pageEntryName);
            const file = await writeArchivePageToEntry(jobId, pool, session, index, storage, pageEntryName);
            pageReferences[index] = { file, entryName: pageEntryName };
            const size = await inspectPageWithPool(jobId, pool, file, sourcePage.name, sourcePage.type);
            if (!size.width || !size.height) {
                throw new ComicError('DIMENSIONS_UNAVAILABLE', `无法读取图片“${sourcePage.name}”的尺寸`);
            }
            dimensions[index] = size;
            savedPages += 1;
            postLongImageProgress(
                jobId,
                payload,
                Math.round(savedPages / session.manifest.pages.length * 900),
                `正在保存第 ${savedPages}/${session.manifest.pages.length} 页`
            );
        });

        const pages = session.manifest.pages.map((sourcePage, index) => ({
            name: sourcePage.name,
            type: sourcePage.type,
            size: sourcePage.size,
            width: dimensions[index].width,
            height: dimensions[index].height,
            lastModified: sourcePage.lastModified,
            entryName: pageReferences[index].entryName
        }));
        const coverEntryName = `${history.config.HISTORY_PREFIX}${bookId}-${generation}-cover.jpg`;
        newEntryNames.push(coverEntryName);
        postLongImageProgress(jobId, payload, 940, '正在生成书架封面');
        await createHistoryCover(
            jobId,
            storage,
            pageReferences[0].file,
            coverEntryName,
            pages[0].name,
            pages[0].type
        );
        const coverFile = await storage.getFile(coverEntryName);
        const baseName = String(payload.outputName || 'comic').replace(/\.[^.]*$/, '') || 'comic';
        const now = Date.now();
        postLongImageProgress(jobId, payload, 980, '正在提交漫画书架');
        const record = await putHistoryRecord({
            schemaVersion: history.config.SCHEMA_VERSION,
            bookId,
            title: payload.replaceMetadata ? baseName : (existingRecord?.title || baseName),
            sourceName: payload.sourceName || session.file.name || `${baseName}.ecomic`,
            storageKind: storage.kind,
            coverEntryName,
            coverMime: 'image/jpeg',
            totalSize: session.manifest.totalSize,
            pages,
            png: {
                name: `${baseName}-long.png`,
                width: 1,
                height: 1,
                size: 0,
                generatedAt: 0,
                entryName: ''
            },
            progress: existingRecord?.progress || { pageIndex: 0, pageRatio: 0 },
            createdAt: payload.replaceMetadata
                ? (Number(payload.createdAt) || existingRecord?.createdAt || now)
                : (existingRecord?.createdAt || now),
            updatedAt: now,
            lastOpenedAt: existingRecord?.lastOpenedAt || 0
        });
        historyCommitted = true;
        await requestPersistentStorage();
        if (existingRecord) {
            try {
                await assertHistoryMutationOwnership();
                const currentRecord = await getHistoryRecord(bookId);
                if (currentRecord?.coverEntryName === coverEntryName) {
                    const existingStorage = await getStorageBackend(existingRecord.storageKind);
                    for (const page of existingRecord.pages) {
                        await removeEntryQuietly(existingStorage, page.entryName);
                    }
                    await removeEntryQuietly(existingStorage, existingRecord.coverEntryName);
                    await removeEntryQuietly(existingStorage, existingRecord.png?.entryName);
                }
            } catch (error) {
                // The committed generation is authoritative; stale data can be reclaimed later.
            }
        }
        const result = {
            bookId,
            book: history.summarizeRecord(record),
            coverFile,
            pages: pages.length,
            size: session.manifest.totalSize
        };
        if (!payload.silent) post('historySaved', jobId, result);
        return result;
    } catch (error) {
        if (!historyCommitted) {
            for (const name of newEntryNames) {
                await removeEntryQuietly(storage, name);
            }
        }
        if (error && error.code === 'INSUFFICIENT_STORAGE') {
            throw new ComicError('INSUFFICIENT_HISTORY_STORAGE', '空间不足，无法把漫画原页和封面写入书架应用数据');
        }
        throw error;
    }
}

async function exportLongImage(jobId, payload) {
    const session = sessions.get(payload.sessionId);
    if (!session) {
        throw new ComicError('INVALID_SESSION', '漫画阅读会话已失效');
    }
    if (typeof self.OffscreenCanvas !== 'function' || typeof self.CompressionStream !== 'function') {
        throw new ComicError('PNG_UNSUPPORTED', '当前浏览器不支持流式生成 PNG 长图，请升级浏览器');
    }

    const storage = await getStorageBackend();
    const parallelism = Math.min(
        normalizeParallelism(payload.parallelism),
        session.manifest.pages.length
    );
    const pool = getCodecTaskPool(parallelism);

    const dimensions = new Array(session.manifest.pages.length);
    let outputWidth = 0;
    let outputHeight = 0;
    try {
        let analyzedPages = 0;
        await runBounded(session.manifest.pages.length, parallelism, async index => {
            assertNotCancelled(jobId);
            const page = session.manifest.pages[index];
            let reference = null;
            try {
                reference = await getExportPageFile(jobId, pool, session, payload.sessionId, index);
                const size = await inspectPageWithPool(
                    jobId,
                    pool,
                    reference.file,
                    page.name,
                    page.type
                );
                if (!size.width || !size.height) {
                    throw new ComicError('DIMENSIONS_UNAVAILABLE', `无法读取图片“${page.name}”的尺寸`);
                }
                dimensions[index] = size;
                analyzedPages += 1;
                postLongImageProgress(
                    jobId,
                    payload,
                    Math.round(analyzedPages / session.manifest.pages.length * 200),
                    `正在并行分析 ${analyzedPages}/${session.manifest.pages.length} 页`
                );
            } finally {
                await releaseExportPage(reference);
            }
        });
        for (const size of dimensions) {
            outputWidth = Math.max(outputWidth, size.width);
            outputHeight += size.height;
        }
        const rowBytes = 1 + outputWidth * 4;
        const rawSize = rowBytes * outputHeight;
        if (!Number.isSafeInteger(rawSize) || outputWidth > 0x7FFFFFFF || outputHeight > 0x7FFFFFFF) {
            throw new ComicError('LONG_IMAGE_TOO_LARGE', '合并后的 PNG 像素尺寸超出格式限制');
        }
        const largestPage = Math.max(...session.manifest.pages.map(page => page.size));
        const temporaryPageBytes = session.kind === 'history' ? 0 : largestPage;
        await ensureStorage(
            estimatePngStorage(session, rawSize) + temporaryPageBytes,
            payload.availableStorageBytes ?? session.availableStorageBytes
        );
    } catch (error) {
        throw error;
    }
    const rowBytes = 1 + outputWidth * 4;
    const entryName = `${TEMP_PREFIX}${jobId}.png`;
    let writable;
    let compressionWriter;
    let compressionPump;
    let preparedPage = null;

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
        const preparePage = async pageIndex => {
            const page = session.manifest.pages[pageIndex];
            const reference = await getExportPageFile(jobId, pool, session, payload.sessionId, pageIndex);
            try {
                const bitmap = await createPageBitmap(reference.file, page.name, page.type);
                return { reference, bitmap };
            } catch (error) {
                await releaseExportPage(reference);
                throw error;
            }
        };
        const preparePageResult = async pageIndex => {
            try {
                return { prepared: await preparePage(pageIndex), error: null };
            } catch (error) {
                return { prepared: null, error };
            }
        };
        preparedPage = preparePageResult(0);
        for (let pageIndex = 0; pageIndex < session.manifest.pages.length; pageIndex++) {
            assertNotCancelled(jobId);
            const page = session.manifest.pages[pageIndex];
            const size = dimensions[pageIndex];
            const preparedResult = await preparedPage;
            if (preparedResult.error) {
                throw preparedResult.error;
            }
            const prepared = preparedResult.prepared;
            preparedPage = pageIndex + 1 < session.manifest.pages.length
                ? preparePageResult(pageIndex + 1)
                : null;
            try {
                const bitmap = prepared.bitmap;
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
                prepared.bitmap.close();
                await releaseExportPage(prepared.reference);
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
        post(payload.resultType === 'historyExport' ? 'historyLongImageReady' : 'complete', jobId, {
            kind: 'longImage',
            file,
            opfsName: entryName,
            storageKind: storage.kind,
            name: `${baseName}-long.png`,
            title: payload.title || baseName,
            size: file.size,
            pages: session.manifest.pages.length,
            width: outputWidth,
            height: outputHeight,
            bookId: String(payload.bookId || ''),
            persisted: false
        });
    } catch (error) {
        if (preparedPage) {
            try {
                const preparedResult = await preparedPage;
                if (preparedResult.prepared) {
                    preparedResult.prepared.bitmap.close();
                    await releaseExportPage(preparedResult.prepared.reference);
                }
            } catch (prepareError) {
                // Preserve the original failure.
            }
            preparedPage = null;
        }
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
        throw error;
    }
}

async function exportZip(jobId, payload) {
    const session = sessions.get(payload.sessionId);
    if (!session) {
        throw new ComicError('INVALID_SESSION', '漫画阅读会话已失效');
    }
    await ensureStorage(
        session.manifest.totalSize,
        payload.availableStorageBytes ?? session.availableStorageBytes
    );
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
    const historyState = await readHistoryRecords();
    const books = [];
    const storageByKind = new Map();
    const completeNamesByKind = new Map();
    for (const storageKind of new Set(historyState.records.map(record => record.storageKind))) {
        try {
            const storage = await getStorageBackend(storageKind);
            storageByKind.set(storageKind, storage);
            completeNamesByKind.set(storageKind, await storage.listCompleteNames());
        } catch (error) {
            completeNamesByKind.set(storageKind, new Set());
        }
    }
    for (const record of historyState.records) {
        let coverFile = null;
        const storage = storageByKind.get(record.storageKind);
        const completeNames = completeNamesByKind.get(record.storageKind) || new Set();
        let fileAvailable = record.pages.every(page => completeNames.has(page.entryName));
        try {
            if (storage && record.coverEntryName && completeNames.has(record.coverEntryName)) {
                try {
                    coverFile = await storage.getFile(record.coverEntryName);
                } catch (error) {
                    coverFile = null;
                }
            }
        } catch (error) {
            coverFile = null;
            fileAvailable = false;
        }
        books.push({
            ...history.summarizeRecord(record),
            storageKind: record.storageKind,
            coverFile,
            fileAvailable
        });
    }
    post('history', jobId, {
        books,
        invalidRecords: historyState.invalidRecords
    });
}

function createHistorySession(record, sessionId, availableStorageBytes = null) {
    const manifest = {
        createdAt: record.createdAt,
        totalSize: record.totalSize,
        pages: record.pages
    };
    sessions.set(sessionId, {
        kind: 'history',
        manifest,
        pageEntries: new Map(),
        bookId: record.bookId,
        storageKind: record.storageKind,
        availableStorageBytes
    });
    return manifest;
}

async function historyOpen(jobId, payload) {
    return withHistoryMutation(async () => {
        const record = await getHistoryRecord(String(payload.bookId || ''));
        if (!record) {
            throw new ComicError('HISTORY_NOT_FOUND', '这本漫画已不在书架中');
        }
        const storage = await getStorageBackend(record.storageKind);
        for (const page of record.pages) {
            if (!(await storage.has(page.entryName))) {
                throw new ComicError('HISTORY_ASSET_MISSING', '漫画原始页面已缺失，请重新导入原归档');
            }
        }
        const now = Date.now();
        const updated = await putHistoryRecord({ ...record, lastOpenedAt: now });
        const sessionId = `${jobId}-history-${record.bookId}`;
        createHistorySession(updated, sessionId, payload.availableStorageBytes);
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
    });
}

async function historyEditOpen(jobId, payload) {
    const record = await getHistoryRecord(String(payload.bookId || ''));
    if (!record) {
        throw new ComicError('HISTORY_NOT_FOUND', '这本漫画已不在书架中');
    }
    const storage = await getStorageBackend(record.storageKind);
    for (const page of record.pages) {
        if (!(await storage.has(page.entryName))) {
            throw new ComicError('HISTORY_ASSET_MISSING', '漫画原始页面已缺失，请重新导入原归档');
        }
    }
    const sessionId = `${jobId}-edit-${record.bookId}`;
    sessions.set(sessionId, {
        kind: 'edit',
        record,
        availableStorageBytes: payload.availableStorageBytes
    });
    post('historyEditOpened', jobId, {
        sessionId,
        bookId: record.bookId,
        title: record.title,
        pages: record.pages.map((page, index) => ({
            index,
            name: page.name,
            type: page.type,
            size: page.size,
            width: page.width,
            height: page.height,
            lastModified: page.lastModified
        }))
    });
}

async function historyEditThumbnail(jobId, payload) {
    const session = sessions.get(String(payload.sessionId || ''));
    const index = Number(payload.index);
    if (!session || session.kind !== 'edit' || !Number.isInteger(index)
            || index < 0 || index >= session.record.pages.length) {
        throw new ComicError('INVALID_SESSION', '漫画编辑会话已失效');
    }
    const page = session.record.pages[index];
    const storage = await getStorageBackend(session.record.storageKind);
    const file = await storage.getFile(page.entryName);
    const thumbnail = await createHistoryThumbnail(jobId, file, page.name, page.type);
    post('historyEditThumbnail', jobId, {
        sessionId: payload.sessionId,
        index,
        file: thumbnail
    });
}

function mapEditedProgress(record, retainedIndexes) {
    const oldIndex = record.progress.pageIndex;
    const retainedPosition = retainedIndexes.indexOf(oldIndex);
    if (retainedPosition >= 0) {
        return { pageIndex: retainedPosition, pageRatio: record.progress.pageRatio };
    }
    const nextPosition = retainedIndexes.findIndex(index => index > oldIndex);
    return {
        pageIndex: nextPosition >= 0 ? nextPosition : Math.max(0, retainedIndexes.length - 1),
        pageRatio: 0
    };
}

async function historyEditCommit(jobId, payload) {
    return withHistoryMutation(async () => {
        const sessionId = String(payload.sessionId || '');
        const session = sessions.get(sessionId);
        if (!session || session.kind !== 'edit') {
            throw new ComicError('INVALID_SESSION', '漫画编辑会话已失效');
        }
        const currentRecord = await getHistoryRecord(session.record.bookId);
        if (!currentRecord) {
            throw new ComicError('HISTORY_NOT_FOUND', '这本漫画已不在书架中');
        }
        if (currentRecord.updatedAt !== session.record.updatedAt
                || currentRecord.coverEntryName !== session.record.coverEntryName) {
            throw new ComicError('EDIT_CONFLICT', '漫画已在其他窗口发生变化，请关闭编辑器后重新打开');
        }
        const retainedIndexes = Array.isArray(payload.retainedIndexes)
            ? payload.retainedIndexes.map(Number)
            : [];
        if (retainedIndexes.some((index, position) => !Number.isInteger(index)
                || index < 0 || index >= currentRecord.pages.length
                || (position > 0 && retainedIndexes[position - 1] >= index))) {
            throw new ComicError('INVALID_EDIT', '保留页面顺序无效');
        }
        const newFiles = Array.isArray(payload.newFiles) ? payload.newFiles : [];
        const newRecords = [];
        for (const file of newFiles) {
            assertNotCancelled(jobId);
            newRecords.push(await detectFileRecord(file));
        }
        const finalRecords = [
            ...retainedIndexes.map(index => currentRecord.pages[index]),
            ...newRecords
        ];
        const manifest = format.createManifest(finalRecords, currentRecord.createdAt);
        const storage = await getStorageBackend(currentRecord.storageKind);
        await ensureStorage(manifest.totalSize, payload.availableStorageBytes ?? session.availableStorageBytes);
        const generation = `${Date.now().toString(36)}-${jobId.replace(/[^a-z0-9-]/gi, '')}`;
        const pageReferences = new Array(finalRecords.length);
        const dimensions = new Array(finalRecords.length);
        const newEntryNames = [];
        let committed = false;
        try {
            const parallelism = Math.min(normalizeParallelism(payload.parallelism), finalRecords.length);
            const pool = getCodecTaskPool(parallelism);
            let completed = 0;
            await runBounded(finalRecords.length, parallelism, async outputIndex => {
                assertNotCancelled(jobId);
                const originalIndex = outputIndex < retainedIndexes.length
                    ? retainedIndexes[outputIndex]
                    : -1;
                const record = originalIndex >= 0
                    ? currentRecord.pages[originalIndex]
                    : newRecords[outputIndex - retainedIndexes.length];
                const sourceFile = originalIndex >= 0
                    ? await storage.getFile(record.entryName)
                    : newFiles[outputIndex - retainedIndexes.length];
                const entryName = `${history.config.HISTORY_PREFIX}${currentRecord.bookId}-${generation}-page-${String(outputIndex).padStart(4, '0')}`;
                newEntryNames.push(entryName);
                await copyStorageFile(jobId, storage, sourceFile, entryName);
                const file = await storage.getFile(entryName);
                pageReferences[outputIndex] = { file, entryName };
                dimensions[outputIndex] = originalIndex >= 0
                    ? { width: record.width, height: record.height }
                    : await inspectPageWithPool(jobId, pool, file, record.name, record.type);
                completed += 1;
                post('progress', jobId, {
                    processed: completed,
                    total: finalRecords.length + 1,
                    message: `正在写入第 ${completed}/${finalRecords.length} 页`
                });
            });
            const pages = finalRecords.map((record, index) => ({
                name: record.name,
                type: record.type,
                size: record.size,
                width: dimensions[index].width,
                height: dimensions[index].height,
                lastModified: record.lastModified,
                entryName: pageReferences[index].entryName
            }));
            const coverEntryName = `${history.config.HISTORY_PREFIX}${currentRecord.bookId}-${generation}-cover.jpg`;
            newEntryNames.push(coverEntryName);
            await createHistoryCover(
                jobId,
                storage,
                pageReferences[0].file,
                coverEntryName,
                pages[0].name,
                pages[0].type
            );
            const coverFile = await storage.getFile(coverEntryName);
            const now = Date.now();
            const updatedRecord = await putHistoryRecord({
                ...currentRecord,
                storageKind: storage.kind,
                coverEntryName,
                coverMime: 'image/jpeg',
                pageCount: pages.length,
                totalSize: manifest.totalSize,
                pages,
                png: {
                    name: `${currentRecord.title}-long.png`,
                    width: 1,
                    height: 1,
                    size: 0,
                    generatedAt: 0,
                    entryName: ''
                },
                progress: mapEditedProgress(currentRecord, retainedIndexes),
                updatedAt: now
            });
            committed = true;
            sessions.delete(sessionId);
            try {
                await assertHistoryMutationOwnership();
                const authoritative = await getHistoryRecord(currentRecord.bookId);
                if (authoritative?.coverEntryName === coverEntryName) {
                    for (const page of currentRecord.pages) await removeEntryQuietly(storage, page.entryName);
                    await removeEntryQuietly(storage, currentRecord.coverEntryName);
                    await removeEntryQuietly(storage, currentRecord.png?.entryName);
                }
            } catch (error) {
                // The new generation is committed; orphan cleanup can reclaim the old one later.
            }
            post('historyEditCommitted', jobId, {
                book: history.summarizeRecord(updatedRecord),
                coverFile,
                removed: currentRecord.pages.length - retainedIndexes.length,
                added: newFiles.length
            });
        } catch (error) {
            if (!committed) {
                for (const entryName of newEntryNames) await removeEntryQuietly(storage, entryName);
            }
            throw error;
        }
    });
}

async function historyEditCancel(payload) {
    const session = sessions.get(String(payload.sessionId || ''));
    if (session?.kind === 'edit') sessions.delete(String(payload.sessionId || ''));
}

async function historyProgress(jobId, payload) {
    return withHistoryMutation(async () => {
        const record = await getHistoryRecord(String(payload.bookId || ''));
        if (!record) {
            return;
        }
        const progress = history.normalizeProgress(payload.progress, record.pageCount);
        await putHistoryRecord({ ...record, progress, lastOpenedAt: Date.now() });
        post('historyProgressed', jobId, { bookId: record.bookId, progress });
    });
}

async function historyRename(jobId, payload) {
    return withHistoryMutation(async () => {
        const record = await getHistoryRecord(String(payload.bookId || ''));
        if (!record) {
            throw new ComicError('HISTORY_NOT_FOUND', '这本漫画已不在书架中');
        }
        const title = history.normalizeTitle(payload.title);
        const updated = await putHistoryRecord({ ...record, title, updatedAt: Date.now() });
        post('historyRenamed', jobId, { book: history.summarizeRecord(updated) });
    });
}

async function deleteOneHistoryBook(record, storage) {
    await removeHistoryRecord(record.bookId);
    for (const page of record.pages) {
        await removeEntryQuietly(storage, page.entryName);
    }
    await removeEntryQuietly(storage, record.coverEntryName);
    await removeEntryQuietly(storage, record.png?.entryName);
    for (const [sessionId, session] of sessions) {
        if (session.bookId === record.bookId) {
            sessions.delete(sessionId);
        }
    }
}

async function historyDelete(jobId, payload) {
    return withHistoryMutation(async () => {
        if (payload.bookId === '*') {
            const records = await listHistoryRecords();
            for (const record of records) {
                const storage = await getStorageBackend(record.storageKind);
                await deleteOneHistoryBook(record, storage);
            }
            post('historyDeleted', jobId, { bookId: '*', count: records.length });
            return;
        }
        const record = await getHistoryRecord(String(payload.bookId || ''));
        if (record) {
            const storage = await getStorageBackend(record.storageKind);
            await deleteOneHistoryBook(record, storage);
        }
        post('historyDeleted', jobId, { bookId: String(payload.bookId || ''), count: record ? 1 : 0 });
    });
}

async function historyStorage(jobId) {
    let quota = 0;
    let usage = 0;
    if (self.navigator.storage) {
        if (typeof self.navigator.storage.estimate === 'function') {
            const estimate = await self.navigator.storage.estimate();
            quota = Number(estimate.quota) || 0;
            usage = Number(estimate.usage) || 0;
        }
    }
    post('historyStorage', jobId, { quota, usage });
}

async function historyExportLongImage(jobId, payload) {
    const bookId = String(payload.bookId || '');
    const record = await getHistoryRecord(bookId);
    let sessionId = '';
    let title = String(payload.outputName || '').trim();
    if (record) {
        sessionId = `${jobId}-history-long-${record.bookId}`;
        createHistorySession(record, sessionId, payload.availableStorageBytes);
        title = record.title;
    } else if (payload.file instanceof Blob) {
        const opened = await createArchiveSession(jobId, payload.file, payload.availableStorageBytes);
        sessionId = opened.sessionId;
    } else {
        throw new ComicError('HISTORY_NOT_FOUND', '这本漫画已不在书架中');
    }
    try {
        await exportLongImage(jobId, {
            sessionId,
            outputName: title || 'comic',
            title: title || 'comic',
            bookId,
            resultType: 'historyExport',
            parallelism: payload.parallelism,
            availableStorageBytes: payload.availableStorageBytes
        });
    } finally {
        sessions.delete(sessionId);
    }
}

async function historySave(jobId, payload) {
    await saveHistorySession(jobId, payload);
}

async function historyArchive(jobId, payload) {
    const record = await getHistoryRecord(String(payload.bookId || ''));
    if (!record) {
        throw new ComicError('HISTORY_NOT_FOUND', '这本漫画已不在书架中');
    }
    const storage = await getStorageBackend(record.storageKind);
    const files = [];
    for (const page of record.pages) {
        assertNotCancelled(jobId);
        const file = await storage.getFile(page.entryName);
        files.push(new File([file], page.name, { type: page.type, lastModified: page.lastModified }));
    }
    await encryptArchive(jobId, {
        files,
        outputName: record.title,
        addToShelf: false,
        parallelism: payload.parallelism,
        availableStorageBytes: payload.availableStorageBytes
    });
}

async function historyExportArchive(jobId, payload) {
    const record = await getHistoryRecord(String(payload.bookId || ''));
    if (!record) {
        throw new ComicError('HISTORY_NOT_FOUND', '这本漫画已不在书架中');
    }
    const storage = await getStorageBackend(record.storageKind);
    const files = [];
    for (const page of record.pages) {
        assertNotCancelled(jobId);
        const file = await storage.getFile(page.entryName);
        files.push(new File([file], page.name, { type: page.type, lastModified: page.lastModified }));
    }
    await encryptArchive(jobId, {
        files,
        outputName: record.title,
        addToShelf: false,
        resultType: 'historyExport',
        parallelism: payload.parallelism,
        availableStorageBytes: payload.availableStorageBytes
    });
}

async function createPortableHistoryArchive(jobId, record, storage, parallelism) {
    const files = [];
    const records = [];
    for (const page of record.pages) {
        assertNotCancelled(jobId);
        const stored = await storage.getFile(page.entryName);
        const file = new File([stored], page.name, { type: page.type, lastModified: page.lastModified });
        files.push(file);
        records.push(await detectFileRecord(file));
    }
    const manifest = format.createManifest(records, record.createdAt);
    const manifestBytes = format.encodeManifest(manifest);
    const salt = self.crypto.getRandomValues(new Uint8Array(16));
    const noncePrefix = self.crypto.getRandomValues(new Uint8Array(8));
    const headerBytes = format.encodeHeader({
        salt,
        noncePrefix,
        keyId: await comicCrypto.getBuiltinKeyId(),
        manifestCipherLength: manifestBytes.length + format.AUTH_TAG_SIZE,
        totalPlainSize: manifest.totalSize
    });
    const header = format.decodeHeader(headerBytes);
    const key = await comicCrypto.deriveBuiltinKey(salt);
    const laneCount = Math.min(
        normalizeParallelism(parallelism),
        manifest.pages.reduce((sum, page) => sum + page.chunkCount, 0)
    );
    const pool = getCodecTaskPool(laneCount);
    const entryName = `${TEMP_PREFIX}${jobId}-${record.bookId}.ecomic`;
    let writable;
    try {
        writable = (await createWritableEntry(storage, entryName)).writable;
        await writable.write(headerBytes);
        await writable.write(await encryptChunkWithPool(jobId, pool, key, headerBytes, noncePrefix, 0, manifestBytes));
        const chunks = [];
        let counter = 1;
        for (const file of files) {
            for (let offset = 0; offset < file.size; offset += format.CHUNK_SIZE) {
                chunks.push({ file, offset, counter });
                counter += 1;
            }
        }
        const pending = new Array(chunks.length);
        const startChunk = index => {
            const chunk = chunks[index];
            pending[index] = (async () => {
                assertNotCancelled(jobId);
                const plain = await chunk.file.slice(chunk.offset, chunk.offset + format.CHUNK_SIZE).arrayBuffer();
                return encryptChunkWithPool(
                    jobId,
                    pool,
                    key,
                    header.bytes,
                    header.noncePrefix,
                    chunk.counter,
                    plain
                );
            })();
        };
        for (let index = 0; index < Math.min(laneCount, chunks.length); index++) startChunk(index);
        for (let index = 0; index < chunks.length; index++) {
            await writable.write(await pending[index]);
            if (index + laneCount < chunks.length) startChunk(index + laneCount);
        }
        await writable.close();
        writable = null;
        return { file: await storage.getFile(entryName), entryName };
    } catch (error) {
        try { await writable?.abort(error); } catch (abortError) { /* Preserve original error. */ }
        await removeEntryQuietly(storage, entryName);
        throw error;
    }
}

async function appendStoredZipFile(jobId, writable, source, path, offset, timestamp = Date.now()) {
    const nameBytes = new TextEncoder().encode(path);
    const stamp = getDosDateTime(timestamp);
    const localHeader = zipLocalHeader(nameBytes, stamp);
    await writable.write(localHeader);
    let nextOffset = offset + localHeader.length;
    let crc = 0xFFFFFFFF;
    for (let sourceOffset = 0; sourceOffset < source.size; sourceOffset += 1024 * 1024) {
        assertNotCancelled(jobId);
        const bytes = new Uint8Array(await source.slice(sourceOffset, sourceOffset + 1024 * 1024).arrayBuffer());
        crc = updateCrc32(crc, bytes);
        await writable.write(bytes);
        nextOffset += bytes.length;
    }
    crc = (crc ^ 0xFFFFFFFF) >>> 0;
    const descriptor = zipDataDescriptor(crc, source.size);
    await writable.write(descriptor);
    nextOffset += descriptor.length;
    return {
        offset: nextOffset,
        record: { nameBytes, stamp, crc, size: source.size, offset }
    };
}

async function historyExportBundle(jobId, payload) {
    const bookIds = Array.isArray(payload.bookIds)
        ? [...new Set(payload.bookIds.map(value => String(value || '').toLowerCase()))]
        : [];
    if (!bookIds.length) throw new ComicError('EMPTY_BUNDLE', '请至少选择一本漫画');
    if (bookIds.length + 1 > 0xFFFF) throw new ComicError('BUNDLE_TOO_LARGE', '单个漫画包包含的漫画数量过多');
    const records = [];
    let estimatedZipSize = 0;
    let largestArchive = 0;
    for (const bookId of bookIds) {
        const record = await getHistoryRecord(bookId);
        if (!record) throw new ComicError('HISTORY_NOT_FOUND', '所选漫画已不在书架中，请刷新后重试');
        const archiveManifest = format.createManifest(record.pages, record.createdAt);
        const archiveSize = format.estimateArchiveSize(archiveManifest, format.encodeManifest(archiveManifest).length);
        estimatedZipSize += archiveSize + 256;
        largestArchive = Math.max(largestArchive, archiveSize);
        records.push(record);
    }
    if (estimatedZipSize >= 0xFFFFFFFF) {
        throw new ComicError('BUNDLE_TOO_LARGE', '所选漫画包将达到 4 GB，请拆分选择后再导出');
    }
    await ensureStorage(estimatedZipSize + largestArchive, payload.availableStorageBytes);
    const outputStorage = await getStorageBackend();
    const outputEntryName = `${TEMP_PREFIX}${jobId}.zip`;
    let writable;
    let currentTempName = '';
    let currentTempStorage = null;
    try {
        writable = (await createWritableEntry(outputStorage, outputEntryName)).writable;
        const centralRecords = [];
        const manifestBooks = [];
        let offset = 0;
        for (let index = 0; index < records.length; index++) {
            const record = records[index];
            const sourceStorage = await getStorageBackend(record.storageKind);
            const archive = await createPortableHistoryArchive(jobId, record, sourceStorage, payload.parallelism);
            currentTempName = archive.entryName;
            currentTempStorage = sourceStorage;
            const path = `books/${record.bookId}.ecomic`;
            const appended = await appendStoredZipFile(jobId, writable, archive.file, path, offset, record.updatedAt);
            offset = appended.offset;
            centralRecords.push(appended.record);
            manifestBooks.push({
                bookId: record.bookId,
                title: record.title,
                path,
                size: archive.file.size,
                createdAt: record.createdAt
            });
            await removeEntryQuietly(sourceStorage, currentTempName);
            currentTempName = '';
            currentTempStorage = null;
            post('progress', jobId, {
                processed: index + 1,
                total: records.length + 1,
                message: `已打包第 ${index + 1}/${records.length} 本漫画`
            });
        }
        const bundleManifest = new Blob([JSON.stringify({
            format: 'ecryptees-comic-bundle',
            version: 1,
            createdAt: Date.now(),
            books: manifestBooks
        })], { type: 'application/json' });
        const manifestAppend = await appendStoredZipFile(
            jobId,
            writable,
            bundleManifest,
            'ecryptees-bundle.json',
            offset
        );
        offset = manifestAppend.offset;
        centralRecords.push(manifestAppend.record);
        const centralOffset = offset;
        for (const centralRecord of centralRecords) {
            const header = zipCentralHeader(centralRecord);
            await writable.write(header);
            offset += header.length;
        }
        const centralSize = offset - centralOffset;
        if (offset + 22 >= 0xFFFFFFFF) throw new ComicError('BUNDLE_TOO_LARGE', '漫画包超过 4 GB，请拆分选择');
        await writable.write(zipEnd(centralRecords.length, centralSize, centralOffset));
        await writable.close();
        writable = null;
        const file = await outputStorage.getFile(outputEntryName);
        post('historyBundleReady', jobId, {
            file,
            opfsName: outputEntryName,
            storageKind: outputStorage.kind,
            name: `Ecryptees-comics-${new Date().toISOString().slice(0, 10)}.zip`,
            size: file.size,
            count: records.length
        });
    } catch (error) {
        try { await writable?.abort(error); } catch (abortError) { /* Preserve original error. */ }
        if (currentTempName && currentTempStorage) await removeEntryQuietly(currentTempStorage, currentTempName);
        await removeEntryQuietly(outputStorage, outputEntryName);
        throw error;
    }
}

function assertSafeBundlePath(name) {
    if (!name || name.includes('\\') || name.startsWith('/') || name.includes('\0')
            || name.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new ComicError('INVALID_BUNDLE_PATH', '漫画包包含不安全的文件路径');
    }
}

async function verifyZipEntryCrc(file, entry) {
    let crc = 0xFFFFFFFF;
    for (let offset = 0; offset < entry.size; offset += 1024 * 1024) {
        const end = Math.min(entry.size, offset + 1024 * 1024);
        const bytes = new Uint8Array(await file.slice(entry.dataOffset + offset, entry.dataOffset + end).arrayBuffer());
        crc = updateCrc32(crc, bytes);
    }
    if (((crc ^ 0xFFFFFFFF) >>> 0) !== entry.crc) {
        throw new ComicError('BUNDLE_CRC_MISMATCH', `漫画包文件“${entry.name}”校验失败`);
    }
}

async function parseHistoryBundle(file) {
    if (!(file instanceof Blob) || file.size < 22 || file.size >= 0xFFFFFFFF) {
        throw new ComicError('INVALID_BUNDLE', '漫画包为空、损坏或超过 4 GB');
    }
    const tailOffset = Math.max(0, file.size - 65557);
    const tail = new Uint8Array(await file.slice(tailOffset).arrayBuffer());
    let eocd = -1;
    for (let index = tail.length - 22; index >= 0; index--) {
        if (tail[index] === 0x50 && tail[index + 1] === 0x4B && tail[index + 2] === 0x05 && tail[index + 3] === 0x06) {
            eocd = index;
            break;
        }
    }
    if (eocd < 0) throw new ComicError('INVALID_BUNDLE', '漫画包缺少 ZIP 目录');
    const endView = new DataView(tail.buffer, tail.byteOffset + eocd);
    if (endView.getUint16(4, true) !== 0 || endView.getUint16(6, true) !== 0) {
        throw new ComicError('UNSUPPORTED_BUNDLE', '不支持分卷 ZIP 漫画包');
    }
    const recordCount = endView.getUint16(10, true);
    const centralSize = endView.getUint32(12, true);
    const centralOffset = endView.getUint32(16, true);
    if (recordCount === 0xFFFF || centralSize === 0xFFFFFFFF || centralOffset === 0xFFFFFFFF) {
        throw new ComicError('UNSUPPORTED_BUNDLE', '不支持 ZIP64 漫画包');
    }
    if (endView.getUint16(20, true) !== 0 || tailOffset + eocd + 22 !== file.size) {
        throw new ComicError('UNSUPPORTED_BUNDLE', '漫画包不能包含 ZIP 注释或尾随数据');
    }
    if (centralOffset + centralSize > file.size) throw new ComicError('INVALID_BUNDLE', '漫画包 ZIP 目录越界');
    const central = new Uint8Array(await file.slice(centralOffset, centralOffset + centralSize).arrayBuffer());
    const entries = new Map();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let cursor = 0;
    for (let index = 0; index < recordCount; index++) {
        if (cursor + 46 > central.length) throw new ComicError('INVALID_BUNDLE', '漫画包 ZIP 目录不完整');
        const view = new DataView(central.buffer, central.byteOffset + cursor);
        if (view.getUint32(0, true) !== 0x02014B50) throw new ComicError('INVALID_BUNDLE', '漫画包 ZIP 目录签名错误');
        const flags = view.getUint16(8, true);
        const method = view.getUint16(10, true);
        const crc = view.getUint32(16, true);
        const compressedSize = view.getUint32(20, true);
        const size = view.getUint32(24, true);
        const nameLength = view.getUint16(28, true);
        const extraLength = view.getUint16(30, true);
        const commentLength = view.getUint16(32, true);
        const disk = view.getUint16(34, true);
        const localOffset = view.getUint32(42, true);
        if (flags !== 0x0808 || method !== 0 || disk !== 0 || compressedSize !== size
                || compressedSize === 0xFFFFFFFF || localOffset === 0xFFFFFFFF) {
            throw new ComicError('UNSUPPORTED_BUNDLE', '漫画包只能使用未压缩、未加密的标准 ZIP 条目');
        }
        if (extraLength || commentLength) throw new ComicError('UNSUPPORTED_BUNDLE', '漫画包不能包含 ZIP64 或自定义扩展字段');
        const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
        if (recordEnd > central.length) throw new ComicError('INVALID_BUNDLE', '漫画包 ZIP 文件名越界');
        const name = decoder.decode(central.subarray(cursor + 46, cursor + 46 + nameLength));
        assertSafeBundlePath(name);
        if (entries.has(name)) throw new ComicError('INVALID_BUNDLE', '漫画包包含重复文件名');
        const localHeader = new Uint8Array(await file.slice(localOffset, localOffset + 30).arrayBuffer());
        if (localHeader.length !== 30 || new DataView(localHeader.buffer).getUint32(0, true) !== 0x04034B50) {
            throw new ComicError('INVALID_BUNDLE', '漫画包本地文件头损坏');
        }
        const localView = new DataView(localHeader.buffer);
        if (localView.getUint16(6, true) !== 0x0808 || localView.getUint16(8, true) !== 0) {
            throw new ComicError('INVALID_BUNDLE', '漫画包本地文件头与目录不一致');
        }
        const localNameLength = localView.getUint16(26, true);
        const localExtraLength = localView.getUint16(28, true);
        if (localExtraLength) throw new ComicError('UNSUPPORTED_BUNDLE', '漫画包不能包含 ZIP64 或自定义扩展字段');
        const localNameBytes = new Uint8Array(await file.slice(localOffset + 30, localOffset + 30 + localNameLength).arrayBuffer());
        if (decoder.decode(localNameBytes) !== name) throw new ComicError('INVALID_BUNDLE', '漫画包本地文件名与目录不一致');
        const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
        const descriptorOffset = dataOffset + size;
        if (descriptorOffset + 16 > centralOffset) throw new ComicError('INVALID_BUNDLE', '漫画包文件内容越界');
        const descriptorBytes = new Uint8Array(await file.slice(descriptorOffset, descriptorOffset + 16).arrayBuffer());
        const descriptorView = new DataView(descriptorBytes.buffer);
        if (descriptorBytes.length !== 16 || descriptorView.getUint32(0, true) !== 0x08074B50
                || descriptorView.getUint32(4, true) !== crc
                || descriptorView.getUint32(8, true) !== size
                || descriptorView.getUint32(12, true) !== size) {
            throw new ComicError('INVALID_BUNDLE', '漫画包数据描述符损坏');
        }
        entries.set(name, { name, crc, size, dataOffset, localOffset, endOffset: descriptorOffset + 16 });
        cursor = recordEnd;
    }
    if (cursor !== central.length) throw new ComicError('INVALID_BUNDLE', '漫画包 ZIP 目录包含多余数据');
    const ranges = [...entries.values()].sort((left, right) => left.localOffset - right.localOffset);
    for (let index = 1; index < ranges.length; index++) {
        if (ranges[index].localOffset < ranges[index - 1].endOffset) {
            throw new ComicError('INVALID_BUNDLE', '漫画包 ZIP 条目相互重叠');
        }
    }
    const manifestEntry = entries.get('ecryptees-bundle.json');
    if (!manifestEntry || manifestEntry.size > 4 * 1024 * 1024) {
        throw new ComicError('INVALID_BUNDLE', '漫画包缺少有效的 ecryptees-bundle.json');
    }
    await verifyZipEntryCrc(file, manifestEntry);
    let manifest;
    try {
        manifest = JSON.parse(await file.slice(manifestEntry.dataOffset, manifestEntry.dataOffset + manifestEntry.size).text());
    } catch (error) {
        throw new ComicError('INVALID_BUNDLE', '漫画包清单不是有效 JSON');
    }
    if (manifest?.format !== 'ecryptees-comic-bundle' || manifest.version !== 1 || !Array.isArray(manifest.books)) {
        throw new ComicError('INVALID_BUNDLE', '漫画包格式或版本不受支持');
    }
    const books = [];
    const seenBookIds = new Set();
    for (const item of manifest.books) {
        const bookId = String(item?.bookId || '').toLowerCase();
        const path = String(item?.path || '');
        if (!/^[a-f0-9]{32}$/.test(bookId) || path !== `books/${bookId}.ecomic` || seenBookIds.has(bookId)) {
            throw new ComicError('INVALID_BUNDLE', '漫画包清单包含无效或重复的漫画身份');
        }
        const entry = entries.get(path);
        if (!entry || entry.size !== Number(item.size)) throw new ComicError('INVALID_BUNDLE', '漫画包清单与文件大小不一致');
        seenBookIds.add(bookId);
        books.push({
            bookId,
            title: String(item.title || 'comic').slice(0, 120),
            createdAt: Number(item.createdAt) || Date.now(),
            entry
        });
    }
    if (!books.length || entries.size !== books.length + 1) {
        throw new ComicError('INVALID_BUNDLE', '漫画包必须只包含清单和声明的 .ecomic 文件');
    }
    return books;
}

async function historyImportBundle(jobId, payload) {
    return withHistoryMutation(async () => {
        const books = await parseHistoryBundle(payload.file);
        const conflictPolicy = payload.conflictPolicy === 'skip' ? 'skip' : 'replace';
        const counts = { success: 0, replaced: 0, skipped: 0, failed: 0 };
        const failures = [];
        for (let index = 0; index < books.length; index++) {
            assertNotCancelled(jobId);
            const book = books[index];
            const existing = await getHistoryRecord(book.bookId);
            if (existing && conflictPolicy === 'skip') {
                counts.skipped += 1;
            } else {
                let importSessionId = '';
                try {
                    await verifyZipEntryCrc(payload.file, book.entry);
                    const archive = new File([
                        payload.file.slice(book.entry.dataOffset, book.entry.dataOffset + book.entry.size)
                    ], `${book.bookId}.ecomic`, { type: 'application/vnd.ecryptees.ecomic' });
                    const opened = await createArchiveSession(jobId, archive, payload.availableStorageBytes);
                    importSessionId = opened.sessionId;
                    await saveHistorySessionUnlocked(jobId, {
                        sessionId: importSessionId,
                        bookId: book.bookId,
                        outputName: book.title,
                        sourceName: `${book.title}.ecomic`,
                        createdAt: book.createdAt,
                        replaceMetadata: true,
                        silent: true,
                        parallelism: payload.parallelism,
                        availableStorageBytes: payload.availableStorageBytes
                    });
                    counts.success += 1;
                    if (existing) counts.replaced += 1;
                } catch (error) {
                    if (error?.name === 'AbortError' || cancelledJobs.has(jobId)) throw error;
                    counts.failed += 1;
                    failures.push({ bookId: book.bookId, title: book.title, message: error.message || '导入失败' });
                } finally {
                    if (importSessionId) sessions.delete(importSessionId);
                }
            }
            post('historyBundleImportProgress', jobId, {
                ...counts,
                completed: index + 1,
                total: books.length,
                message: `已处理第 ${index + 1}/${books.length} 本漫画`
            });
        }
        post('historyBundleImported', jobId, { ...counts, failures });
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
    for (const name of session.pageEntries?.values?.() || []) {
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
        codecTaskPool?.cancelJob(jobId);
        return;
    }

    try {
        if (type === 'cleanup') {
            const invalidRecords = await cleanupStaleEntries(payload.aggressive === true);
            post('cleaned', jobId, { invalidRecords });
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
        } else if (type === 'historyEditOpen') {
            await historyEditOpen(jobId, payload);
        } else if (type === 'historyEditThumbnail') {
            await historyEditThumbnail(jobId, payload);
        } else if (type === 'historyEditCommit') {
            await historyEditCommit(jobId, payload);
        } else if (type === 'historyEditCancel') {
            await historyEditCancel(payload);
        } else if (type === 'historySave') {
            await historySave(jobId, payload);
        } else if (type === 'historyDelete') {
            await historyDelete(jobId, payload);
        } else if (type === 'historyProgress') {
            await historyProgress(jobId, payload);
        } else if (type === 'historyRename') {
            await historyRename(jobId, payload);
        } else if (type === 'historyStorage') {
            await historyStorage(jobId);
        } else if (type === 'historyExportLongImage') {
            await historyExportLongImage(jobId, payload);
        } else if (type === 'historyArchive') {
            await historyArchive(jobId, payload);
        } else if (type === 'historyExportArchive') {
            await historyExportArchive(jobId, payload);
        } else if (type === 'historyExportBundle') {
            await historyExportBundle(jobId, payload);
        } else if (type === 'historyImportBundle') {
            await historyImportBundle(jobId, payload);
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
