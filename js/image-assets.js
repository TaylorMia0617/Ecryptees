(function (root) {
    'use strict';

    const DATABASE_NAME = 'ecryptees-image-assets-v1';
    const DATABASE_VERSION = 1;
    const ASSET_STORE = 'assets';
    const FOLDER_STORE = 'folders';
    const MEMBERSHIP_STORE = 'memberships';
    const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

    function requestToPromise(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('图片资产数据库操作失败'));
        });
    }

    function transactionToPromise(transaction) {
        return new Promise((resolve, reject) => {
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error || new Error('图片资产保存失败'));
            transaction.onabort = () => reject(transaction.error || new Error('图片资产操作已取消'));
        });
    }

    function openDatabase() {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(ASSET_STORE)) {
                database.createObjectStore(ASSET_STORE, { keyPath: 'assetId' });
            }
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
        if (typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    }

    function normalizeTitle(value, fallback = '图片') {
        const title = String(value || '').trim().slice(0, 120);
        return title || fallback;
    }

    function normalizeFileName(value) {
        const name = String(value || 'image').replace(/[\\/:*?"<>|\u0000-\u001F\u007F]/g, '_').trim();
        return Array.from(name || 'image').slice(0, 180).join('');
    }

    function titleFromFileName(name) {
        return normalizeTitle(String(name || '').replace(/\.[^.]+$/, ''), '图片');
    }

    async function saveImageAsset(input) {
        const blob = input?.blob instanceof Blob
            ? input.blob
            : new Blob([input?.bytes || new Uint8Array()], { type: String(input?.mime || '') });
        if (!blob.size || blob.size > MAX_IMAGE_BYTES) {
            throw new Error('图片不能为空或超过 15 MiB');
        }
        const mime = String(input?.mime || blob.type || '');
        if (!/^image\//.test(mime)) {
            throw new Error('图片资产格式无效');
        }
        const now = Date.now();
        const fileName = normalizeFileName(input?.fileName || 'image');
        const asset = {
            assetId: createId(),
            title: normalizeTitle(input?.title, titleFromFileName(fileName)),
            fileName,
            mime,
            size: blob.size,
            width: Math.max(0, Math.trunc(Number(input?.width) || 0)),
            height: Math.max(0, Math.trunc(Number(input?.height) || 0)),
            blob,
            createdAt: now,
            updatedAt: now,
            lastOpenedAt: 0
        };
        const database = await openDatabase();
        try {
            const transaction = database.transaction(ASSET_STORE, 'readwrite');
            transaction.objectStore(ASSET_STORE).add(asset);
            await transactionToPromise(transaction);
        } finally {
            database.close();
        }
        return asset;
    }

    async function listImageAssets() {
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

    async function getImageAsset(assetId) {
        const database = await openDatabase();
        try {
            return await requestToPromise(database.transaction(ASSET_STORE, 'readonly').objectStore(ASSET_STORE).get(String(assetId || '')));
        } finally {
            database.close();
        }
    }

    async function updateImageAsset(assetId, changes) {
        const database = await openDatabase();
        try {
            const transaction = database.transaction(ASSET_STORE, 'readwrite');
            const store = transaction.objectStore(ASSET_STORE);
            const asset = await requestToPromise(store.get(String(assetId || '')));
            if (!asset) {
                throw new Error('图片资产不存在');
            }
            if (Object.prototype.hasOwnProperty.call(changes || {}, 'title')) {
                asset.title = normalizeTitle(changes.title, asset.title);
            }
            if (Object.prototype.hasOwnProperty.call(changes || {}, 'lastOpenedAt')) {
                asset.lastOpenedAt = Math.max(0, Number(changes.lastOpenedAt) || 0);
            }
            asset.updatedAt = Date.now();
            store.put(asset);
            await transactionToPromise(transaction);
            return asset;
        } finally {
            database.close();
        }
    }

    async function deleteImageAsset(assetId) {
        const id = String(assetId || '');
        const database = await openDatabase();
        try {
            const transaction = database.transaction([ASSET_STORE, MEMBERSHIP_STORE], 'readwrite');
            transaction.objectStore(ASSET_STORE).delete(id);
            transaction.objectStore(MEMBERSHIP_STORE).delete(id);
            await transactionToPromise(transaction);
        } finally {
            database.close();
        }
    }

    async function createImageFolder(name) {
        const normalized = normalizeTitle(name, '');
        if (!normalized) {
            throw new Error('文件夹名称不能为空');
        }
        const state = await listImageAssets();
        if (state.folders.some(folder => String(folder.name).toLocaleLowerCase() === normalized.toLocaleLowerCase())) {
            throw new Error('已经存在同名文件夹');
        }
        const now = Date.now();
        const folder = { folderId: createId(), name: normalized.slice(0, 40), createdAt: now, updatedAt: now };
        const database = await openDatabase();
        try {
            const transaction = database.transaction(FOLDER_STORE, 'readwrite');
            transaction.objectStore(FOLDER_STORE).add(folder);
            await transactionToPromise(transaction);
        } finally {
            database.close();
        }
        return folder;
    }

    async function setImageAssetFolder(assetId, folderId) {
        const id = String(assetId || '');
        const selectedFolder = String(folderId || '');
        const database = await openDatabase();
        try {
            const transaction = database.transaction(MEMBERSHIP_STORE, 'readwrite');
            const store = transaction.objectStore(MEMBERSHIP_STORE);
            if (selectedFolder) {
                store.put({ assetId: id, folderId: selectedFolder, updatedAt: Date.now() });
            } else {
                store.delete(id);
            }
            await transactionToPromise(transaction);
        } finally {
            database.close();
        }
    }

    async function clearImageAssets() {
        const database = await openDatabase();
        try {
            const transaction = database.transaction([ASSET_STORE, MEMBERSHIP_STORE], 'readwrite');
            transaction.objectStore(ASSET_STORE).clear();
            transaction.objectStore(MEMBERSHIP_STORE).clear();
            await transactionToPromise(transaction);
        } finally {
            database.close();
        }
    }

    root.EcrypteesImageAssets = Object.freeze({
        saveImageAsset,
        listImageAssets,
        getImageAsset,
        updateImageAsset,
        deleteImageAsset,
        createImageFolder,
        setImageAssetFolder,
        clearImageAssets,
        titleFromFileName
    });
})(globalThis);
