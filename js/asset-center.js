(function (root) {
    'use strict';

    const adapters = new Map();
    const buttons = new Map([
        ['comic', document.getElementById('assetTypeComicButton')],
        ['image', document.getElementById('assetTypeImageButton')],
        ['video', document.getElementById('assetTypeVideoButton')]
    ]);
    let activeType = 'comic';
    let activationSequence = 0;
    const typeLabels = Object.freeze({ comic: '漫画', image: '图片', video: '视频' });

    function updateButtons() {
        for (const [type, button] of buttons) {
            const selected = type === activeType;
            button?.classList.toggle('is-active', selected);
            button?.setAttribute('aria-pressed', String(selected));
        }
        document.getElementById('historyPanel')?.classList.toggle('image-assets-active', activeType === 'image');
        document.getElementById('historyPanel')?.classList.toggle('video-assets-active', activeType === 'video');
    }

    function setCount(type, count) {
        const output = document.querySelector(`[data-asset-count="${type}"]`);
        if (output) {
            const normalized = Math.max(0, Math.trunc(Number(count) || 0));
            output.textContent = String(normalized);
            output.setAttribute('aria-label', `${normalized} 项`);
        }
    }

    async function activate(type) {
        if (!adapters.has(type)) {
            return;
        }
        const sequence = ++activationSequence;
        activeType = type;
        for (const [adapterType, adapter] of adapters) {
            if (adapterType !== type) {
                adapter.deactivate?.();
            }
        }
        updateButtons();
        await adapters.get(type).activate?.({ sequence });
    }

    function dispatch(method, event) {
        const adapter = adapters.get(activeType);
        if (adapter && typeof adapter[method] === 'function') {
            return adapter[method](event);
        }
        return undefined;
    }

    function register(type, adapter) {
        if (!buttons.has(type) || !adapter || adapters.has(type)) {
            throw new Error(`资产中心适配器无效：${type}`);
        }
        adapters.set(type, adapter);
        updateButtons();
    }

    function activeAdapter() {
        return adapters.get(activeType);
    }

    function setGroupManagerStatus(message, kind = '') {
        const status = document.getElementById('assetGroupManagerStatus');
        if (!status) return;
        status.textContent = message || '';
        status.dataset.kind = kind;
    }

    async function renderGroupManager() {
        const adapter = activeAdapter();
        const list = document.getElementById('assetGroupManagerList');
        const empty = document.getElementById('assetGroupManagerEmpty');
        if (!adapter || !list || typeof adapter.listGroups !== 'function') return;
        const groups = await adapter.listGroups();
        list.replaceChildren();
        empty.hidden = groups.length !== 0;
        for (const group of groups) {
            const row = document.createElement('div');
            row.className = 'asset-group-manager-row';
            row.setAttribute('role', 'listitem');
            const name = document.createElement('strong');
            name.textContent = group.name;
            name.title = group.name;
            const rename = document.createElement('button');
            rename.className = 'secondary-button';
            rename.type = 'button';
            rename.textContent = '重命名';
            rename.addEventListener('click', async () => {
                const nextName = prompt('修改分组名称', group.name);
                if (nextName === null) return;
                try {
                    await adapter.renameGroup(group.groupId, nextName);
                    setGroupManagerStatus('分组名称已保存。', 'success');
                    await renderGroupManager();
                } catch (error) {
                    setGroupManagerStatus(error?.message || '分组重命名失败。', 'error');
                }
            });
            const remove = document.createElement('button');
            remove.className = 'asset-group-delete';
            remove.type = 'button';
            remove.textContent = '删除';
            remove.addEventListener('click', async () => {
                if (!confirm(`删除分组“${group.name}”？分组内资产会变为未分组。`)) return;
                try {
                    await adapter.deleteGroup(group.groupId);
                    setGroupManagerStatus('分组已删除，资产原件保持不变。', 'success');
                    await renderGroupManager();
                } catch (error) {
                    setGroupManagerStatus(error?.message || '分组删除失败。', 'error');
                }
            });
            row.append(name, rename, remove);
            list.append(row);
        }
    }

    async function openGroupManager() {
        const adapter = activeAdapter();
        if (!adapter || typeof adapter.listGroups !== 'function') return;
        document.getElementById('assetGroupManagerTitle').textContent = `管理${typeLabels[activeType]}分组`;
        document.getElementById('assetGroupCreateInput').value = '';
        setGroupManagerStatus('');
        await renderGroupManager();
        document.getElementById('assetGroupManagerDialog').showModal();
    }

    for (const [type, button] of buttons) {
        button?.addEventListener('click', () => {
            activate(type).catch(error => {
                const status = document.getElementById('historyStatus');
                if (status) {
                    status.textContent = error?.message || '无法切换资产类型';
                    status.dataset.kind = 'error';
                }
            });
        });
    }

    const historyGrid = document.getElementById('historyGrid');
    historyGrid?.addEventListener('click', event => dispatch('handleGridClick', event));
    historyGrid?.addEventListener('pointerdown', event => dispatch('handleGridPointerDown', event));
    historyGrid?.addEventListener('pointermove', event => dispatch('handleGridPointerMove', event));
    historyGrid?.addEventListener('pointerup', event => dispatch('handleGridPointerUp', event));
    historyGrid?.addEventListener('pointercancel', event => dispatch('handleGridPointerCancel', event));
    historyGrid?.addEventListener('contextmenu', event => dispatch('handleGridContextMenu', event));
    document.getElementById('historyGroupFilterSelect')?.addEventListener('change', event => dispatch('handleGroupChange', event));
    document.getElementById('historySort')?.addEventListener('change', event => dispatch('handleSortChange', event));
    document.getElementById('historySearch')?.addEventListener('input', event => dispatch('handleSearchInput', event));
    document.getElementById('manageHistoryFoldersButton')?.addEventListener('click', () => {
        openGroupManager().catch(error => setGroupManagerStatus(error?.message || '无法打开分组管理。', 'error'));
    });
    document.getElementById('addHistoryFolderButton')?.addEventListener('click', () => dispatch('handleAddFolder'));
    document.getElementById('clearHistoryButton')?.addEventListener('click', event => dispatch('handleClear', event));
    document.getElementById('historyGoToComicButton')?.addEventListener('click', event => dispatch('handleEmptyAction', event));
    document.getElementById('closeAssetGroupManagerButton')?.addEventListener('click', () => {
        document.getElementById('assetGroupManagerDialog').close();
    });
    document.getElementById('assetGroupManagerDialog')?.addEventListener('cancel', event => {
        event.preventDefault();
        event.currentTarget.close();
    });
    document.getElementById('assetGroupCreateForm')?.addEventListener('submit', async event => {
        event.preventDefault();
        const adapter = activeAdapter();
        const input = document.getElementById('assetGroupCreateInput');
        if (!adapter || typeof adapter.createGroup !== 'function') return;
        try {
            await adapter.createGroup(input.value);
            input.value = '';
            setGroupManagerStatus('分组已创建。', 'success');
            await renderGroupManager();
        } catch (error) {
            setGroupManagerStatus(error?.message || '分组创建失败。', 'error');
            input.focus();
        }
    });

    root.EcrypteesAssetCenter = Object.freeze({
        register,
        activate,
        setCount,
        isActive: type => activeType === type,
        getActiveType: () => activeType,
        getSequence: () => activationSequence,
        isCurrent: (type, sequence) => activeType === type && activationSequence === sequence
    });
})(globalThis);
