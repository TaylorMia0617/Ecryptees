(function (root) {
    'use strict';

    const store = root.EcrypteesImageAssets;
    const core = root.Ecryptees?.core;
    const assetCenter = root.EcrypteesAssetCenter;
    if (!store || !core || !assetCenter) {
        return;
    }

    const { codec, image, utils } = core;
    const grid = document.getElementById('historyGrid');
    const panel = document.getElementById('historyPanel');
    const status = document.getElementById('historyStatus');
    const coverUrls = new Map();
    let active = false;
    let assets = [];
    let folders = [];
    let memberships = new Map();
    let selectedFolder = 'all';
    let selectedAssetId = '';
    let viewerUrl = '';
    let busy = false;
    let refreshSequence = 0;

    function setStatus(message, kind = 'info') {
        status.textContent = message || '';
        status.dataset.kind = kind;
    }

    function closeDialog(dialog) {
        if (dialog?.open) {
            dialog.close();
        }
    }

    function revokeCoverUrls() {
        for (const url of coverUrls.values()) {
            URL.revokeObjectURL(url);
        }
        coverUrls.clear();
    }

    function formatDate(timestamp) {
        if (!timestamp) {
            return '尚未查看';
        }
        return new Intl.DateTimeFormat('zh-CN', {
            month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
        }).format(new Date(timestamp));
    }

    function updateImageSortOptions() {
        const select = document.getElementById('historySort');
        select.replaceChildren();
        for (const [value, label] of [['recent', '最近查看'], ['converted', '最近加入'], ['title', '标题']]) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            select.append(option);
        }
    }

    async function updateStorage() {
        try {
            const estimate = await navigator.storage?.estimate?.();
            if (!estimate) return;
            document.getElementById('historyStorageSummary').textContent = `已使用 ${utils.formatBytes(estimate.usage || 0)} · 剩余 ${utils.formatBytes(Math.max(0, (estimate.quota || 0) - (estimate.usage || 0)))}`;
        } catch (error) {
            // Storage estimates are optional.
        }
    }

    function renderFolderMenu() {
        const select = document.getElementById('historyGroupFilterSelect');
        select.replaceChildren();
        const definitions = [
            { folderId: 'all', name: '全部文件夹' },
            { folderId: 'ungrouped', name: '未分组' },
            ...folders
        ];
        for (const folder of definitions) {
            const option = document.createElement('option');
            option.value = folder.folderId;
            const count = folder.folderId === 'all'
                ? assets.length
                : assets.filter(asset => {
                    const membership = memberships.get(asset.assetId) || '';
                    return folder.folderId === 'ungrouped' ? !membership : membership === folder.folderId;
                }).length;
            option.textContent = `${folder.name}（${count}）`;
            select.append(option);
        }
        if (!definitions.some(folder => folder.folderId === selectedFolder)) {
            selectedFolder = 'all';
        }
        select.value = selectedFolder;
        document.getElementById('historyViewSummary').textContent = definitions.find(folder => folder.folderId === selectedFolder)?.name || '全部文件夹';
    }

    function createAction(label, action, assetId, className = '') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.dataset.imageAssetAction = action;
        button.dataset.assetId = assetId;
        button.textContent = label;
        return button;
    }

    function createMenuButton(asset) {
        const button = createAction('更多操作', 'menu', asset.assetId, 'history-menu-button');
        button.setAttribute('aria-label', `打开“${asset.title}”的更多操作`);
        button.title = '更多操作';
        button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/></svg>';
        return button;
    }

    function createGroupControl(asset) {
        const folderId = memberships.get(asset.assetId) || '';
        const folderName = folders.find(folder => folder.folderId === folderId)?.name || '未分组';
        const control = document.createElement('div');
        control.className = 'history-card-group-control';
        const label = document.createElement('span');
        label.className = 'history-card-group-label';
        label.textContent = Array.from(folderName).slice(0, 3).join('');
        label.title = folderName;
        const button = createAction('移除分组', 'removeGroup', asset.assetId, 'history-remove-group-button');
        button.disabled = !folderId;
        button.title = folderId ? `移出“${folderName}”` : '当前图片未分组';
        button.setAttribute('aria-label', folderId ? `将“${asset.title}”移出分组“${folderName}”` : `“${asset.title}”当前未分组`);
        button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h6l2 2h10v12H3V5Zm4 7v2h10v-2H7Z"/></svg>';
        control.append(label, button);
        return control;
    }

    function render() {
        if (!active || !assetCenter.isActive('image')) {
            return;
        }
        revokeCoverUrls();
        renderFolderMenu();
        const query = document.getElementById('historySearch').value.trim().toLocaleLowerCase();
        const sort = document.getElementById('historySort').value;
        const filtered = assets.filter(asset => {
            if (query && !String(asset.title).toLocaleLowerCase().includes(query)) return false;
            const membership = memberships.get(asset.assetId) || '';
            if (selectedFolder === 'ungrouped') return !membership;
            return selectedFolder === 'all' || selectedFolder === membership;
        }).slice();
        filtered.sort((left, right) => {
            if (sort === 'title') return String(left.title).localeCompare(String(right.title), 'zh-CN');
            if (sort === 'converted') return right.createdAt - left.createdAt;
            return (right.lastOpenedAt || right.createdAt) - (left.lastOpenedAt || left.createdAt);
        });
        grid.replaceChildren();
        for (const asset of filtered) {
            const card = document.createElement('article');
            card.className = 'image-asset-card';
            const thumbnail = document.createElement('img');
            thumbnail.className = 'image-asset-thumbnail';
            thumbnail.alt = `${asset.title} 预览`;
            if (asset.fileAvailable === false) {
                thumbnail.hidden = true;
                card.classList.add('image-asset-unavailable');
            } else if (asset.mime === 'image/heic' || asset.mime === 'image/heif') {
                thumbnail.hidden = true;
                card.classList.add('image-asset-needs-decoder');
            } else {
                const url = URL.createObjectURL(asset.blob);
                coverUrls.set(asset.assetId, url);
                thumbnail.src = url;
                thumbnail.loading = 'lazy';
            }
            const header = document.createElement('div');
            header.className = 'history-card-header';
            const title = document.createElement('h3');
            title.className = 'history-card-title';
            title.textContent = asset.title;
            const headerTools = document.createElement('div');
            headerTools.className = 'history-card-header-tools';
            headerTools.append(createGroupControl(asset), createMenuButton(asset));
            header.append(title, headerTools);
            const meta = document.createElement('p');
            meta.className = 'history-card-meta';
            const dimensions = asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : '';
            meta.textContent = asset.fileAvailable === false
                ? `文件不可用 · ${utils.formatBytes(asset.size)}`
                : `${asset.mime.replace('image/', '').toUpperCase()} · ${utils.formatBytes(asset.size)}${dimensions}`;
            const time = document.createElement('p');
            time.className = 'history-card-time';
            time.textContent = `最近：${formatDate(asset.lastOpenedAt || asset.createdAt)}`;
            const actions = document.createElement('div');
            actions.className = 'image-asset-actions';
            const openButton = createAction('查看', 'open', asset.assetId);
            const txtButton = createAction('导出 TXT', 'exportTxt', asset.assetId);
            const imageButton = createAction('导出图片', 'exportImage', asset.assetId);
            openButton.disabled = asset.fileAvailable === false;
            txtButton.disabled = asset.fileAvailable === false;
            imageButton.disabled = asset.fileAvailable === false;
            actions.append(
                openButton,
                txtButton,
                imageButton,
                createAction('删除', 'delete', asset.assetId, 'image-asset-delete')
            );
            card.append(thumbnail, header, meta, time, actions);
            grid.append(card);
        }
        document.getElementById('historyEmptyState').hidden = assets.length !== 0;
        document.getElementById('historyEmptyTitle').textContent = '图片资产还是空的';
        document.getElementById('historyEmptyDescription').textContent = '在图片模式处理成功时勾选“同时保存到资产”。';
        document.getElementById('historyGoToComicButton').textContent = '前往图片模式';
        document.getElementById('clearHistoryButton').disabled = busy || assets.length === 0;
        if (assets.length && !filtered.length) setStatus('没有符合条件的图片。');
        updateStorage();
    }

    async function refresh() {
        if (!active || !assetCenter.isActive('image')) return;
        const sequence = ++refreshSequence;
        const activation = assetCenter.getSequence();
        const state = await store.listImageAssets();
        assetCenter.setCount('image', state.assets.length);
        if (!active || !assetCenter.isCurrent('image', activation) || sequence !== refreshSequence) return;
        assets = state.assets;
        folders = state.folders.sort((a, b) => a.createdAt - b.createdAt);
        memberships = new Map(state.memberships.map(item => [item.assetId, item.folderId]));
        render();
    }

    function scheduleUrlRelease(url) {
        const release = () => {
            URL.revokeObjectURL(url);
            document.removeEventListener('ecryptees-download-result', onResult);
        };
        const onResult = event => {
            if (event.detail?.url === url) release();
        };
        document.addEventListener('ecryptees-download-result', onResult);
        root.setTimeout(release, root.AndroidFileBridge ? 120000 : 30000);
    }

    function downloadBlob(blob, name) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        link.hidden = true;
        document.body.append(link);
        link.click();
        link.remove();
        scheduleUrlRelease(url);
    }

    async function openAsset(assetId) {
        const asset = await store.getImageAsset(assetId);
        if (!asset) throw new Error('图片资产不存在');
        if (!assetCenter.isActive('image')) await assetCenter.activate('image');
        const dialog = document.getElementById('imageAssetViewerDialog');
        const viewer = document.getElementById('imageAssetViewerImage');
        const message = document.getElementById('imageAssetViewerMessage');
        if (viewerUrl) URL.revokeObjectURL(viewerUrl);
        viewerUrl = '';
        viewer.removeAttribute('src');
        message.textContent = '';
        document.getElementById('imageAssetViewerTitle').textContent = asset.title;
        try {
            let previewBlob = asset.blob;
            if ((asset.mime === 'image/heic' || asset.mime === 'image/heif') && root.EcrypteesAndroidMedia?.isHeicSupported()) {
                message.textContent = '正在准备 HEIC/HEIF 预览…';
                previewBlob = (await root.EcrypteesAndroidMedia.decodeHeic(asset.blob, { name: asset.fileName })).file;
            }
            viewerUrl = URL.createObjectURL(previewBlob);
            viewer.src = viewerUrl;
            await viewer.decode().catch(() => {});
            message.textContent = '';
        } catch (error) {
            message.textContent = error.message || '当前设备无法预览该图片，可直接导出原图。';
        }
        if (!dialog.open) dialog.showModal();
        await store.updateImageAsset(assetId, { lastOpenedAt: Date.now() });
        refresh();
    }

    async function exportTxt(assetId) {
        const asset = await store.getImageAsset(assetId);
        if (!asset) throw new Error('图片资产不存在');
        busy = true;
        render();
        setStatus('正在无损生成图片密文 TXT…');
        try {
            const bytes = new Uint8Array(await asset.blob.arrayBuffer());
            const format = image.sniffImageType(bytes);
            if (!format || format.mime !== asset.mime) throw new Error('图片资产内容与格式不一致');
            const source = {
                file: new File([asset.blob], asset.fileName, { type: asset.mime }),
                bytes,
                format,
                metadata: { name: asset.fileName, type: asset.mime, size: bytes.length }
            };
            const crc = await codec.calculateCrc32Chunked(bytes);
            const prefix = codec.buildImagePrefix(source, crc);
            const encoded = await codec.encodeImageByteSegmentsChunked([prefix, bytes]);
            const base = String(asset.fileName || asset.title).replace(/\.[^.]+$/, '') || 'image';
            downloadBlob(new Blob([encoded], { type: 'text/plain;charset=utf-8' }), utils.sanitizeDownloadName(`${base}-msbt-v3.txt`, 'txt'));
            setStatus('图片密文 TXT 已生成。', 'success');
        } finally {
            busy = false;
            render();
        }
    }

    async function handleAction(action, assetId) {
        if (busy) return;
        const asset = assets.find(item => item.assetId === assetId);
        if (!asset) return;
        if (action === 'open') {
            await openAsset(assetId);
        } else if (action === 'exportImage') {
            downloadBlob(asset.blob, asset.fileName);
        } else if (action === 'exportTxt') {
            await exportTxt(assetId);
        } else if (action === 'delete') {
            if (confirm(`删除图片“${asset.title}”？此操作无法撤销。`)) {
                await store.deleteImageAsset(assetId);
                await refresh();
                setStatus('图片资产已删除。', 'success');
            }
        } else if (action === 'removeGroup') {
            await store.setImageAssetFolder(assetId, '');
            await refresh();
            setStatus(`“${asset.title}”已移出分组。`, 'success');
        } else if (action === 'menu') {
            selectedAssetId = assetId;
            document.getElementById('imageAssetMenuTitle').textContent = asset.title;
            document.getElementById('imageAssetMenuDialog').showModal();
        }
    }

    async function activateImages() {
        active = true;
        updateImageSortOptions();
        document.getElementById('historyDirectoryPanel').hidden = true;
        document.getElementById('historyDescription').textContent = '图片以原始格式保存在应用私有资产中。';
        document.getElementById('clearHistoryButton').textContent = '清空图片';
        document.getElementById('historySearch').value = '';
        await refresh();
    }

    function deactivate() {
        active = false;
        refreshSequence += 1;
        revokeCoverUrls();
        panel.classList.remove('image-assets-active');
    }

    assetCenter.register('image', {
        activate: activateImages,
        deactivate,
        render,
        refresh,
        handleGridClick(event) {
            const button = event.target.closest('button[data-image-asset-action]');
            if (button) handleAction(button.dataset.imageAssetAction, button.dataset.assetId).catch(error => setStatus(error.message, 'error'));
        },
        handleGroupChange(event) {
            selectedFolder = event.currentTarget.value;
            document.getElementById('historyViewMenu').open = false;
            render();
        },
        handleSortChange() {
            document.getElementById('assetSortMenu').open = false;
            render();
        },
        handleSearchInput: render,
        handleAddFolder() {
            const name = prompt('图片文件夹名称');
            if (name) store.createImageFolder(name).then(refresh).catch(error => setStatus(error.message, 'error'));
        },
        listGroups() {
            return folders.map(folder => ({ groupId: folder.folderId, name: folder.name }));
        },
        async createGroup(name) {
            const folder = await store.createImageFolder(name);
            await refresh();
            return folder;
        },
        async renameGroup(folderId, name) {
            const folder = await store.renameImageFolder(folderId, name);
            await refresh();
            return folder;
        },
        async deleteGroup(folderId) {
            if (selectedFolder === folderId) selectedFolder = 'all';
            await store.deleteImageFolder(folderId);
            await refresh();
        },
        handleClear() {
            if (assets.length && confirm('清空全部图片资产？此操作无法撤销。')) {
                store.clearImageAssets().then(refresh).catch(error => setStatus(error.message, 'error'));
            }
        },
        handleEmptyAction() {
            document.getElementById('imageTab').click();
        }
    });
    document.getElementById('imageAssetMenuCancelButton').addEventListener('click', () => closeDialog(document.getElementById('imageAssetMenuDialog')));
    document.getElementById('imageAssetRenameButton').addEventListener('click', async () => {
        const asset = assets.find(item => item.assetId === selectedAssetId);
        if (!asset) return;
        const title = prompt('修改图片名称', asset.title);
        if (title?.trim()) {
            await store.updateImageAsset(asset.assetId, { title });
            closeDialog(document.getElementById('imageAssetMenuDialog'));
            await refresh();
        }
    });
    document.getElementById('imageAssetGroupButton').addEventListener('click', () => {
        const select = document.getElementById('imageAssetGroupSelect');
        select.replaceChildren();
        const empty = document.createElement('option');
        empty.value = '';
        empty.textContent = '未分组';
        select.append(empty);
        for (const folder of folders) {
            const option = document.createElement('option');
            option.value = folder.folderId;
            option.textContent = folder.name;
            select.append(option);
        }
        select.value = memberships.get(selectedAssetId) || '';
        closeDialog(document.getElementById('imageAssetMenuDialog'));
        document.getElementById('imageAssetGroupDialog').showModal();
    });
    document.getElementById('imageAssetGroupCancelButton').addEventListener('click', () => closeDialog(document.getElementById('imageAssetGroupDialog')));
    document.getElementById('imageAssetGroupForm').addEventListener('submit', async event => {
        event.preventDefault();
        await store.setImageAssetFolder(selectedAssetId, document.getElementById('imageAssetGroupSelect').value);
        closeDialog(document.getElementById('imageAssetGroupDialog'));
        await refresh();
    });
    document.getElementById('closeImageAssetViewerButton').addEventListener('click', () => closeDialog(document.getElementById('imageAssetViewerDialog')));
    document.getElementById('imageAssetViewerDialog').addEventListener('close', () => {
        if (viewerUrl) URL.revokeObjectURL(viewerUrl);
        viewerUrl = '';
        document.getElementById('imageAssetViewerImage').removeAttribute('src');
    });
    document.addEventListener('ecryptees-image-asset-saved', () => {
        if (active) refresh();
    });

    store.listImageAssets().then(state => assetCenter.setCount('image', state.assets.length)).catch(() => {});

    root.EcrypteesImageAssetsUI = Object.freeze({
        isActive: () => active && assetCenter.isActive('image'),
        deactivate,
        render,
        refresh,
        openAsset
    });
})(globalThis);
