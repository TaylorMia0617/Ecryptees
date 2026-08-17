(function (root) {
    'use strict';

    const DATABASE_NAME = 'ecryptees-video-assets-v1';
    const DATABASE_VERSION = 3;
    const ASSET_STORE = 'assets';
    const FOLDER_STORE = 'folders';
    const MEMBERSHIP_STORE = 'memberships';
    const FILE_PREFIX = 'ecryptees-video-asset-';
    const EXPORT_PREFIX = 'ecryptees-video-export-';
    const INCOMING_PREFIX = 'ecryptees-temp-incoming-';
    const CONTENT_ID_PATTERN = /^sha256-tree-v1:[a-f0-9]{64}$/;
    const desktopStorage = root.EcrypteesDesktopStorage?.available ? root.EcrypteesDesktopStorage : null;
    let desktopSyncPromise = null;

    function requestToPromise(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('视频资产数据库操作失败'));
        });
    }

    function transactionToPromise(transaction) {
        return new Promise((resolve, reject) => {
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error || new Error('视频资产保存失败'));
            transaction.onabort = () => reject(transaction.error || new Error('视频资产操作已取消'));
        });
    }

    function openDatabase() {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
            const database = request.result;
            const assets = database.objectStoreNames.contains(ASSET_STORE)
                ? request.transaction.objectStore(ASSET_STORE)
                : database.createObjectStore(ASSET_STORE, { keyPath: 'assetId' });
            if (!assets.indexNames.contains('byContentId')) assets.createIndex('byContentId', 'contentId', { unique: false });
            if (!assets.indexNames.contains('byFileSize')) assets.createIndex('byFileSize', 'fileSize', { unique: false });
            if (!database.objectStoreNames.contains(FOLDER_STORE)) {
                database.createObjectStore(FOLDER_STORE, { keyPath: 'folderId' });
            }
            if (!database.objectStoreNames.contains(MEMBERSHIP_STORE)) {
                database.createObjectStore(MEMBERSHIP_STORE, { keyPath: 'assetId' });
            }
        };
        return requestToPromise(request);
    }

    function createId() {
        if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
    }

    function normalizeText(value, fallback, maximum = 120) {
        const text = String(value || '').replace(/[\u0000-\u001F\u007F]/g, '').trim();
        return Array.from(text || fallback).slice(0, maximum).join('');
    }

    function assetFileName(assetId) {
        const id = String(assetId || '').replace(/[^a-z0-9-]/gi, '');
        if (!id) throw new Error('视频资产 ID 无效');
        return `${FILE_PREFIX}${id}.mp4`;
    }

    function legacyAssetFileName(assetId) {
        const id = String(assetId || '').replace(/[^a-z0-9-]/gi, '');
        if (!id) throw new Error('视频资产 ID 无效');
        return `${FILE_PREFIX}${id}.emp4`;
    }

    function normalizeContentId(value, required = false) {
        const contentId = String(value || '').toLocaleLowerCase();
        if (!contentId && !required) return '';
        if (!CONTENT_ID_PATTERN.test(contentId)) throw new Error('视频内容指纹无效');
        return contentId;
    }

    async function getRoot() {
        if (!navigator.storage?.getDirectory) throw new Error('当前环境不支持视频资产存储');
        return navigator.storage.getDirectory();
    }

    async function getVideoAssetFile(assetOrId) {
        const asset = typeof assetOrId === 'object' ? assetOrId : await getVideoAsset(assetOrId);
        if (!asset) throw new Error('视频资产不存在');
        if (desktopStorage) {
            if (asset.fileAvailable === false) throw new Error('视频资产文件缺失或保存目录不可用');
            return desktopStorage.getAssetFile('video', asset.assetId, asset.originalName || asset.fileName || 'video.mp4');
        }
        try {
            return await (await (await getRoot()).getFileHandle(asset.opfsName)).getFile();
        } catch (error) {
            throw new Error('视频资产文件缺失或已被清理');
        }
    }

    function createAssetRecord(input) {
        const assetId = String(input?.assetId || createId());
        const opfsName = String(input?.opfsName || assetFileName(assetId));
        if (opfsName !== assetFileName(assetId)) throw new Error('视频资产存储路径无效');
        const fileSize = Number(input?.fileSize ?? input?.plainSize);
        if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
            throw new Error('视频资产大小无效');
        }
        const now = Date.now();
        return {
            assetId,
            title: normalizeText(input?.title, '视频'),
            fileName: normalizeText(input?.fileName, 'video.mp4', 180),
            originalName: normalizeText(input?.originalName, 'video.mp4', 180),
            opfsName,
            storageFormat: 'plain-mp4',
            fileSize,
            plainSize: fileSize,
            contentId: normalizeContentId(input?.contentId),
            createdAt: Number(input?.createdAt) || now,
            updatedAt: Number(input?.updatedAt) || now,
            lastOpenedAt: Math.max(0, Number(input?.lastOpenedAt) || 0),
            playbackPosition: Math.max(0, Number(input?.playbackPosition) || 0),
            duration: Math.max(0, Number(input?.duration) || 0),
            playbackRate: normalizePlaybackRate(input?.playbackRate),
            fileAvailable: input?.fileAvailable !== false
        };
    }

    function normalizePlaybackRate(value) {
        const rate = Number(value) || 1;
        return [0.5, 0.75, 1, 1.25, 1.5, 2].includes(rate) ? rate : 1;
    }

    async function commitVideoAsset(input) {
        const asset = createAssetRecord(input);
        let database = await openDatabase();
        try {
            const transaction = database.transaction(ASSET_STORE, 'readonly');
            const assets = transaction.objectStore(ASSET_STORE);
            if (asset.contentId) {
                const duplicate = await requestToPromise(assets.index('byContentId').get(asset.contentId));
                if (duplicate && duplicate.assetId !== asset.assetId) {
                    return { asset: duplicate, duplicate: true };
                }
            }
        } finally {
            database.close();
        }
        if (desktopStorage) {
            const file = await (await (await getRoot()).getFileHandle(asset.opfsName)).getFile();
            await desktopStorage.saveAsset('video', asset.assetId, file, asset);
        }
        database = await openDatabase();
        try {
            const transaction = database.transaction(ASSET_STORE, 'readwrite');
            transaction.objectStore(ASSET_STORE).put(asset);
            await transactionToPromise(transaction);
        } finally {
            database.close();
        }
        return { asset, duplicate: false };
    }

    async function saveVideoAsset(input) {
        return (await commitVideoAsset(input)).asset;
    }

    async function readRawState() {
        const database = await openDatabase();
        try {
            const transaction = database.transaction([ASSET_STORE, FOLDER_STORE, MEMBERSHIP_STORE], 'readonly');
            const [assets, folders, memberships] = await Promise.all([
                requestToPromise(transaction.objectStore(ASSET_STORE).getAll()),
                requestToPromise(transaction.objectStore(FOLDER_STORE).getAll()),
                requestToPromise(transaction.objectStore(MEMBERSHIP_STORE).getAll())
            ]);
            return { assets, folders, memberships };
        } finally {
            database.close();
        }
    }

    async function synchronizeDesktopAssets() {
        if (!desktopStorage) return;
        if (desktopSyncPromise) return desktopSyncPromise;
        desktopSyncPromise = (async () => {
            await desktopStorage.whenReady;
            const desktopSettings = desktopStorage.getSettings();
            if (!desktopSettings?.video?.available) return;
            const [diskAssets, library] = await Promise.all([
                desktopStorage.listAssets('video'),
                desktopStorage.getLibrary('video').catch(() => null)
            ]);
            const diskRecords = diskAssets.map(item => createAssetRecord({
                    ...item.metadata,
                    assetId: item.assetId,
                    opfsName: assetFileName(item.assetId),
                    fileSize: Number(item.metadata.fileSize || item.metadata.plainSize),
                    fileAvailable: item.available
                }));
            const restoredFolders = Array.isArray(library?.groups) ? library.groups : [];
            const restoredMemberships = Array.isArray(library?.memberships) ? library.memberships : [];
            const database = await openDatabase();
            try {
                const transaction = database.transaction([ASSET_STORE, FOLDER_STORE, MEMBERSHIP_STORE], 'readwrite');
                const assets = transaction.objectStore(ASSET_STORE);
                const folders = transaction.objectStore(FOLDER_STORE);
                const memberships = transaction.objectStore(MEMBERSHIP_STORE);
                assets.clear();
                folders.clear();
                memberships.clear();
                diskRecords.forEach(asset => assets.put(asset));
                restoredFolders.forEach(folder => folders.put(folder));
                restoredMemberships.forEach(membership => memberships.put(membership));
                await transactionToPromise(transaction);
            } finally {
                database.close();
            }
        })().catch(error => {
            desktopSyncPromise = null;
            throw error;
        });
        return desktopSyncPromise;
    }

    async function persistDesktopLibrary() {
        if (!desktopStorage) return;
        const state = await readRawState();
        await desktopStorage.updateLibrary('video', {
            groups: state.folders,
            memberships: state.memberships,
            orderMode: 'natural',
            order: []
        });
    }

    async function listVideoAssets() {
        await synchronizeDesktopAssets();
        return readRawState();
    }

    async function getVideoAsset(assetId) {
        const database = await openDatabase();
        try {
            return await requestToPromise(database.transaction(ASSET_STORE, 'readonly')
                .objectStore(ASSET_STORE).get(String(assetId || '')));
        } finally {
            database.close();
        }
    }

    async function updateVideoAsset(assetId, changes) {
        let database = await openDatabase();
        let asset;
        try {
            asset = await requestToPromise(database.transaction(ASSET_STORE, 'readonly')
                .objectStore(ASSET_STORE).get(String(assetId || '')));
            if (!asset) throw new Error('视频资产不存在');
            if (Object.prototype.hasOwnProperty.call(changes || {}, 'title')) {
                asset.title = normalizeText(changes.title, asset.title);
            }
            if (Object.prototype.hasOwnProperty.call(changes || {}, 'lastOpenedAt')) {
                asset.lastOpenedAt = Math.max(0, Number(changes.lastOpenedAt) || 0);
            }
            if (Object.prototype.hasOwnProperty.call(changes || {}, 'contentId')) {
                asset.contentId = normalizeContentId(changes.contentId, true);
            }
            if (Object.prototype.hasOwnProperty.call(changes || {}, 'playbackPosition')) {
                asset.playbackPosition = Math.max(0, Number(changes.playbackPosition) || 0);
            }
            if (Object.prototype.hasOwnProperty.call(changes || {}, 'duration')) {
                asset.duration = Math.max(0, Number(changes.duration) || 0);
            }
            if (Object.prototype.hasOwnProperty.call(changes || {}, 'playbackRate')) {
                asset.playbackRate = normalizePlaybackRate(changes.playbackRate);
            }
            asset.updatedAt = Date.now();
            if (desktopStorage) await desktopStorage.updateAssetMetadata('video', asset.assetId, asset);
        } finally {
            database.close();
        }
        database = await openDatabase();
        try {
            const transaction = database.transaction(ASSET_STORE, 'readwrite');
            transaction.objectStore(ASSET_STORE).put(asset);
            await transactionToPromise(transaction);
            return asset;
        } finally {
            database.close();
        }
    }

    async function removeStoredFile(opfsName) {
        const name = root.EcrypteesAssetStorage?.assertOwnedName(opfsName, [FILE_PREFIX, EXPORT_PREFIX])
            || String(opfsName || '');
        try {
            await (await getRoot()).removeEntry(name);
        } catch (error) {
            if (error?.name !== 'NotFoundError') throw error;
        }
    }

    async function removeIncomingFile(opfsName) {
        const name = root.EcrypteesAssetStorage?.assertOwnedName(opfsName, INCOMING_PREFIX)
            || String(opfsName || '');
        try {
            await (await getRoot()).removeEntry(name);
        } catch (error) {
            if (error?.name !== 'NotFoundError') throw error;
        }
    }

    async function findVideoAssetByContentId(contentId) {
        const normalized = normalizeContentId(contentId, true);
        const database = await openDatabase();
        try {
            return await requestToPromise(database.transaction(ASSET_STORE, 'readonly')
                .objectStore(ASSET_STORE).index('byContentId').get(normalized));
        } finally {
            database.close();
        }
    }

    async function listUnindexedVideoAssetsBySize(fileSize) {
        const size = Number(fileSize);
        const database = await openDatabase();
        try {
            const matches = await requestToPromise(database.transaction(ASSET_STORE, 'readonly')
                .objectStore(ASSET_STORE).index('byFileSize').getAll(size));
            return matches.filter(asset => !asset.contentId);
        } finally {
            database.close();
        }
    }

    async function auditVideoAssets() {
        const state = await listVideoAssets();
        if (desktopStorage) {
            const disk = await desktopStorage.listAssets('video');
            const available = new Set(disk.filter(item => item.available).map(item => item.assetId));
            return { ...state, missingIds: state.assets.filter(asset => !available.has(asset.assetId)).map(asset => asset.assetId) };
        }
        const missingIds = [];
        for (const asset of state.assets) {
            try {
                await (await (await getRoot()).getFileHandle(asset.opfsName)).getFile();
            } catch (error) {
                if (error?.name === 'NotFoundError') missingIds.push(asset.assetId);
                else throw error;
            }
        }
        return { ...state, missingIds };
    }

    async function deleteVideoAsset(assetId) {
        const asset = await getVideoAsset(assetId);
        if (!asset) return;
        if (desktopStorage) await desktopStorage.trashAsset('video', asset.assetId);
        await removeStoredFile(asset.opfsName);
        const database = await openDatabase();
        try {
            const transaction = database.transaction([ASSET_STORE, MEMBERSHIP_STORE], 'readwrite');
            transaction.objectStore(ASSET_STORE).delete(asset.assetId);
            transaction.objectStore(MEMBERSHIP_STORE).delete(asset.assetId);
            await transactionToPromise(transaction);
        } finally {
            database.close();
        }
        await persistDesktopLibrary();
    }

    async function createVideoFolder(name) {
        const normalized = normalizeText(name, '', 40);
        if (!normalized) throw new Error('文件夹名称不能为空');
        const state = await listVideoAssets();
        if (state.folders.some(folder => folder.name.toLocaleLowerCase() === normalized.toLocaleLowerCase())) {
            throw new Error('已经存在同名文件夹');
        }
        const now = Date.now();
        const folder = { folderId: createId(), name: normalized, createdAt: now, updatedAt: now };
        const database = await openDatabase();
        try {
            const transaction = database.transaction(FOLDER_STORE, 'readwrite');
            transaction.objectStore(FOLDER_STORE).add(folder);
            await transactionToPromise(transaction);
        } finally {
            database.close();
        }
        await persistDesktopLibrary();
        return folder;
    }

    async function setVideoAssetFolder(assetId, folderId) {
        const database = await openDatabase();
        try {
            const transaction = database.transaction(MEMBERSHIP_STORE, 'readwrite');
            const memberships = transaction.objectStore(MEMBERSHIP_STORE);
            if (folderId) memberships.put({ assetId: String(assetId), folderId: String(folderId), updatedAt: Date.now() });
            else memberships.delete(String(assetId));
            await transactionToPromise(transaction);
        } finally {
            database.close();
        }
        await persistDesktopLibrary();
    }

    async function clearVideoAssets() {
        const state = await listVideoAssets();
        if (desktopStorage) {
            for (const asset of state.assets) await desktopStorage.trashAsset('video', asset.assetId);
        }
        for (const asset of state.assets) await removeStoredFile(asset.opfsName);
        const database = await openDatabase();
        try {
            const transaction = database.transaction([ASSET_STORE, MEMBERSHIP_STORE], 'readwrite');
            transaction.objectStore(ASSET_STORE).clear();
            transaction.objectStore(MEMBERSHIP_STORE).clear();
            await transactionToPromise(transaction);
        } finally {
            database.close();
        }
        await persistDesktopLibrary();
    }

    document.addEventListener('ecryptees-desktop-paths-changed', event => {
        if (event.detail?.kind === 'video') desktopSyncPromise = null;
    });

    root.EcrypteesVideoAssets = Object.freeze({
        createId,
        assetFileName,
        legacyAssetFileName,
        commitVideoAsset,
        saveVideoAsset,
        listVideoAssets,
        getVideoAsset,
        getVideoAssetFile,
        updateVideoAsset,
        findVideoAssetByContentId,
        listUnindexedVideoAssetsBySize,
        auditVideoAssets,
        deleteVideoAsset,
        createVideoFolder,
        setVideoAssetFolder,
        clearVideoAssets,
        removeStoredFile,
        removeIncomingFile
    });
})(globalThis);
