(function (root) {
    'use strict';

    const internals = root.__TAURI_INTERNALS__;
    const tauri = root.__TAURI__;
    const available = !!internals && !!tauri?.core?.invoke;
    const CHUNK_BYTES = 4 * 1024 * 1024;
    let settings = null;
    let readyResolve;
    const whenReady = new Promise(resolve => {
        readyResolve = resolve;
    });

    function assertKind(kind) {
        const value = String(kind || '');
        if (!['image', 'comic', 'video'].includes(value)) {
            throw new Error('未知的桌面资产类型');
        }
        return value;
    }

    function invoke(command, payload, options) {
        if (!available) {
            return Promise.reject(new Error('当前环境不是 Ecryptees Windows 桌面版'));
        }
        return tauri.core.invoke(command, payload, options);
    }

    async function refreshSettings() {
        settings = await invoke('get_desktop_settings');
        return settings;
    }

    async function listAssets(kind) {
        return invoke('list_desktop_assets', { kind: assertKind(kind) });
    }

    async function getAssetPath(kind, assetId) {
        return invoke('get_desktop_asset_path', {
            kind: assertKind(kind),
            assetId: String(assetId || '')
        });
    }

    async function getAssetUrl(kind, assetId) {
        const path = await getAssetPath(kind, assetId);
        return tauri.core.convertFileSrc(path);
    }

    async function getAssetFile(kind, assetId, fallbackName = '') {
        const url = await getAssetUrl(kind, assetId);
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`无法读取桌面资产：${response.status}`);
        }
        const name = String(fallbackName || `${assetId}.bin`);
        if (!response.body || !root.navigator?.storage?.getDirectory) {
            const blob = await response.blob();
            return new File([blob], name, { type: blob.type, lastModified: Date.now() });
        }

        const cacheRoot = await root.navigator.storage.getDirectory();
        const cacheDirectory = await cacheRoot.getDirectoryHandle('ecryptees-desktop-cache', { create: true });
        const cacheName = `${assertKind(kind)}-${String(assetId || '').replace(/[^a-zA-Z0-9_-]/g, '_')}.cache`;
        const cacheHandle = await cacheDirectory.getFileHandle(cacheName, { create: true });
        const writable = await cacheHandle.createWritable({ keepExistingData: false });
        const reader = response.body.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                await writable.write(value);
            }
            await writable.close();
        } catch (error) {
            await writable.abort().catch(() => {});
            await cacheDirectory.removeEntry(cacheName).catch(() => {});
            throw error;
        } finally {
            reader.releaseLock();
        }
        const cachedFile = await cacheHandle.getFile();
        return new File([cachedFile], name, {
            type: cachedFile.type || response.headers.get('content-type') || '',
            lastModified: cachedFile.lastModified
        });
    }

    async function saveAsset(kind, assetId, source, metadata = {}, onProgress) {
        const blob = source instanceof Blob ? source : new Blob([source]);
        if (!blob.size) {
            throw new Error('不能保存空资产');
        }
        const begin = await invoke('begin_asset_write', {
            request: {
                kind: assertKind(kind),
                assetId: String(assetId || ''),
                expectedSize: blob.size,
                metadata
            }
        });
        const token = begin.token;
        const chunkSize = Math.min(CHUNK_BYTES, Math.max(1, Number(begin.chunkSize) || CHUNK_BYTES));
        let offset = 0;
        try {
            while (offset < blob.size) {
                const bytes = new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer());
                const written = await invoke('write_asset_chunk', bytes, {
                    headers: {
                        'x-ecryptees-token': token,
                        'x-ecryptees-offset': String(offset)
                    }
                });
                offset = Number(written);
                onProgress?.({ written: offset, total: blob.size, progress: offset / blob.size });
            }
            return await invoke('commit_asset_write', { token });
        } catch (error) {
            await invoke('abort_asset_write', { token }).catch(() => {});
            throw error;
        }
    }

    async function updateAssetMetadata(kind, assetId, metadata) {
        return invoke('update_desktop_asset_metadata', {
            kind: assertKind(kind),
            assetId: String(assetId || ''),
            metadata
        });
    }

    async function updateLibrary(kind, library) {
        return invoke('update_desktop_library', { kind: assertKind(kind), library });
    }

    async function getLibrary(kind) {
        return invoke('get_desktop_library', { kind: assertKind(kind) });
    }

    async function trashAsset(kind, assetId) {
        return invoke('trash_desktop_asset', {
            kind: assertKind(kind),
            assetId: String(assetId || '')
        });
    }

    async function pickRoot() {
        if (!tauri?.dialog?.open) {
            throw new Error('当前桌面版缺少目录选择能力');
        }
        const selected = await tauri.dialog.open({ directory: true, multiple: false });
        return typeof selected === 'string' ? selected : '';
    }

    async function setRoot(kind, newPath, migrate) {
        settings = await invoke('set_desktop_asset_root', {
            kind: assertKind(kind),
            newPath: String(newPath || ''),
            migrate: !!migrate
        });
        document.dispatchEvent(new CustomEvent('ecryptees-desktop-paths-changed', {
            detail: { kind, settings }
        }));
        return settings;
    }

    async function openRoot(kind) {
        return invoke('open_desktop_asset_root', { kind: assertKind(kind) });
    }

    const api = Object.freeze({
        available,
        whenReady,
        getSettings: () => settings,
        refreshSettings,
        listAssets,
        getAssetPath,
        getAssetUrl,
        getAssetFile,
        saveAsset,
        updateAssetMetadata,
        getLibrary,
        updateLibrary,
        trashAsset,
        pickRoot,
        setRoot,
        openRoot
    });
    root.EcrypteesDesktopStorage = api;

    if (!available) {
        readyResolve(null);
        return;
    }
    document.documentElement.dataset.desktopRuntime = 'true';
    refreshSettings().then(value => {
        readyResolve(value);
        document.dispatchEvent(new CustomEvent('ecryptees-desktop-ready', { detail: value }));
    }).catch(error => {
        console.error('桌面存储初始化失败', error);
        readyResolve(null);
        document.dispatchEvent(new CustomEvent('ecryptees-desktop-error', { detail: error }));
    });
})(globalThis);
