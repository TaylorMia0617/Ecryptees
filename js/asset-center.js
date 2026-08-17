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

    document.getElementById('historyGrid')?.addEventListener('click', event => dispatch('handleGridClick', event));
    document.getElementById('historyGroupFilterSelect')?.addEventListener('change', event => dispatch('handleGroupChange', event));
    document.getElementById('historySort')?.addEventListener('change', event => dispatch('handleSortChange', event));
    document.getElementById('historySearch')?.addEventListener('input', event => dispatch('handleSearchInput', event));
    document.getElementById('addHistoryFolderButton')?.addEventListener('click', event => dispatch('handleAddFolder', event));
    document.getElementById('clearHistoryButton')?.addEventListener('click', event => dispatch('handleClear', event));
    document.getElementById('historyGoToComicButton')?.addEventListener('click', event => dispatch('handleEmptyAction', event));

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
