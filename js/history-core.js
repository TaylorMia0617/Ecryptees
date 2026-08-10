(function initializeHistoryCore(root) {
    'use strict';

    const core = root.Ecryptees && root.Ecryptees.core;
    const comic = root.Ecryptees && root.Ecryptees.comic;
    if (!core || !comic) {
        throw new Error('Ecryptees core and comic core must load before history core.');
    }

    const SCHEMA_VERSION = 1;
    const DATABASE_NAME = 'ecryptees-library-v1';
    const DATABASE_VERSION = 1;
    const BOOK_STORE = 'books';
    const HISTORY_PREFIX = 'ecryptees-history-';
    const STAGING_PREFIX = 'ecryptees-staging-';
    const COVER_MAX_WIDTH = 320;
    const COVER_MAX_HEIGHT = 480;
    const COVER_QUALITY = 0.82;

    function bytesToHex(bytes) {
        return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    }

    async function createBookId(headerBytes, fileSize) {
        if (!(headerBytes instanceof Uint8Array) || headerBytes.length !== comic.format.HEADER_SIZE) {
            throw new TypeError('历史ID需要有效的漫画归档头');
        }
        if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
            throw new TypeError('历史ID需要有效的归档大小');
        }
        const input = new Uint8Array(headerBytes.length + 8);
        input.set(headerBytes);
        new DataView(input.buffer).setBigUint64(headerBytes.length, BigInt(fileSize), false);
        const digest = new Uint8Array(await root.crypto.subtle.digest('SHA-256', input));
        return bytesToHex(digest.subarray(0, 16));
    }

    function normalizeProgress(progress, pageCount) {
        const maximumPage = Math.max(0, Number(pageCount) - 1);
        const pageIndex = Math.max(0, Math.min(maximumPage, Math.trunc(Number(progress?.pageIndex) || 0)));
        const pageRatio = Math.max(0, Math.min(1, Number(progress?.pageRatio) || 0));
        return { pageIndex, pageRatio };
    }

    function normalizeTitle(title) {
        return String(title || '').trim().slice(0, 120) || '漫画';
    }

    function validatePage(page, index) {
        if (!page || typeof page !== 'object') {
            throw new TypeError(`历史第 ${index + 1} 页无效`);
        }
        if (!comic.format.SUPPORTED_MIME_TYPES.includes(page.type)) {
            throw new TypeError(`历史第 ${index + 1} 页格式无效`);
        }
        if (!Number.isSafeInteger(page.size) || page.size <= 0
            || !Number.isInteger(page.width) || page.width <= 0
            || !Number.isInteger(page.height) || page.height <= 0
            || typeof page.entryName !== 'string' || !page.entryName.startsWith(HISTORY_PREFIX)) {
            throw new TypeError(`历史第 ${index + 1} 页信息无效`);
        }
        return Object.freeze({
            name: core.utils.sanitizeDownloadName(page.name, `page-${index + 1}`),
            type: page.type,
            size: page.size,
            width: page.width,
            height: page.height,
            lastModified: Number(page.lastModified) || 0,
            entryName: page.entryName
        });
    }

    function validateRecord(record) {
        if (!record || typeof record !== 'object' || record.schemaVersion !== SCHEMA_VERSION
            || !/^[0-9a-f]{32}$/.test(record.bookId || '')) {
            throw new TypeError('漫画历史记录无效');
        }
        if (!Array.isArray(record.pages) || record.pages.length < 1 || record.pages.length > comic.format.MAX_PAGES) {
            throw new TypeError('漫画历史页数无效');
        }
        const pages = record.pages.map(validatePage);
        const totalSize = pages.reduce((sum, page) => sum + page.size, 0);
        if (totalSize !== record.totalSize || totalSize > comic.format.MAX_TOTAL_BYTES) {
            throw new TypeError('漫画历史大小无效');
        }
        return Object.freeze({
            schemaVersion: SCHEMA_VERSION,
            bookId: record.bookId,
            title: normalizeTitle(record.title),
            sourceName: core.utils.sanitizeDownloadName(record.sourceName, 'comic.ecomic'),
            storageKind: record.storageKind === 'opfs' ? 'opfs' : 'indexeddb',
            coverEntryName: String(record.coverEntryName || ''),
            coverMime: record.coverMime === 'image/jpeg' ? 'image/jpeg' : '',
            pageCount: pages.length,
            totalSize,
            pages: Object.freeze(pages),
            png: Object.freeze({
                name: core.utils.sanitizeDownloadName(record.png?.name, 'comic-long.png'),
                width: Math.max(1, Math.trunc(Number(record.png?.width) || 1)),
                height: Math.max(1, Math.trunc(Number(record.png?.height) || 1)),
                size: Math.max(0, Math.trunc(Number(record.png?.size) || 0)),
                generatedAt: Math.max(0, Math.trunc(Number(record.png?.generatedAt) || Date.now()))
            }),
            progress: Object.freeze(normalizeProgress(record.progress, pages.length)),
            createdAt: Math.max(0, Math.trunc(Number(record.createdAt) || Date.now())),
            updatedAt: Math.max(0, Math.trunc(Number(record.updatedAt) || Date.now())),
            lastOpenedAt: Math.max(0, Math.trunc(Number(record.lastOpenedAt) || 0))
        });
    }

    function summarizeRecord(record) {
        const valid = validateRecord(record);
        return Object.freeze({
            bookId: valid.bookId,
            title: valid.title,
            pageCount: valid.pageCount,
            totalSize: valid.totalSize,
            progress: valid.progress,
            png: valid.png,
            coverEntryName: valid.coverEntryName,
            coverMime: valid.coverMime,
            createdAt: valid.createdAt,
            updatedAt: valid.updatedAt,
            lastOpenedAt: valid.lastOpenedAt
        });
    }

    root.Ecryptees = root.Ecryptees || {};
    root.Ecryptees.history = Object.freeze({
        config: Object.freeze({
            SCHEMA_VERSION,
            DATABASE_NAME,
            DATABASE_VERSION,
            BOOK_STORE,
            HISTORY_PREFIX,
            STAGING_PREFIX,
            COVER_MAX_WIDTH,
            COVER_MAX_HEIGHT,
            COVER_QUALITY
        }),
        createBookId,
        normalizeProgress,
        normalizeTitle,
        validateRecord,
        summarizeRecord
    });
})(globalThis);
