(function (root) {
    'use strict';

    const RESERVE_BYTES = 64 * 1024 * 1024;
    let persistenceRequest;

    async function requestPersistence() {
        if (!navigator.storage?.persist) {
            return { supported: false, persisted: false };
        }
        if (!persistenceRequest) {
            persistenceRequest = (async () => {
                const alreadyPersisted = await navigator.storage.persisted?.().catch(() => false);
                const persisted = alreadyPersisted || await navigator.storage.persist().catch(() => false);
                return { supported: true, persisted };
            })();
        }
        return persistenceRequest;
    }

    async function ensureCapacity(additionalBytes, label = '本次操作') {
        const required = Math.max(0, Number(additionalBytes) || 0) + RESERVE_BYTES;
        const estimate = await navigator.storage?.estimate?.().catch(() => null);
        if (!estimate || !Number.isFinite(estimate.quota) || !Number.isFinite(estimate.usage)) {
            return { required, available: Infinity };
        }
        const available = Math.max(0, estimate.quota - estimate.usage);
        if (available < required) {
            const error = new Error(`${label}至少还需要 ${formatBytes(required)} 可用空间，当前约剩余 ${formatBytes(available)}。`);
            error.code = 'INSUFFICIENT_STORAGE';
            error.required = required;
            error.available = available;
            throw error;
        }
        return { required, available };
    }

    function assertOwnedName(name, prefixes) {
        const value = String(name || '');
        const allowed = (Array.isArray(prefixes) ? prefixes : [prefixes]).filter(Boolean);
        if (!value || value.includes('/') || value.includes('\\') || !allowed.some(prefix => value.startsWith(prefix))) {
            throw new Error('拒绝访问不属于当前资产类型的存储文件');
        }
        return value;
    }

    function formatBytes(bytes) {
        const value = Math.max(0, Number(bytes) || 0);
        if (value < 1024) return `${value} B`;
        const units = ['KiB', 'MiB', 'GiB', 'TiB'];
        let size = value / 1024;
        let index = 0;
        while (size >= 1024 && index < units.length - 1) {
            size /= 1024;
            index += 1;
        }
        return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
    }

    root.EcrypteesAssetStorage = Object.freeze({
        RESERVE_BYTES,
        requestPersistence,
        ensureCapacity,
        assertOwnedName,
        formatBytes
    });
})(globalThis);
