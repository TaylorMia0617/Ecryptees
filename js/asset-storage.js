(function (root) {
    'use strict';

    const RESERVE_BYTES = 64 * 1024 * 1024;
    const DECIMAL_GIGABYTE = 1000 * 1000 * 1000;
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

    function getNativeAvailableBytes() {
        try {
            const value = Number(root.AndroidFileBridge?.getAvailableStorageBytes?.());
            return Number.isFinite(value) && value >= 0 ? value : null;
        } catch (error) {
            return null;
        }
    }

    async function getStorageStatus() {
        const estimate = await navigator.storage?.estimate?.().catch(() => null);
        const usageBytes = Number.isFinite(Number(estimate?.usage)) ? Math.max(0, Number(estimate.usage)) : null;
        const quotaBytes = Number.isFinite(Number(estimate?.quota)) ? Math.max(0, Number(estimate.quota)) : null;
        const quotaAvailableBytes = usageBytes !== null && quotaBytes !== null
            ? Math.max(0, quotaBytes - usageBytes)
            : null;
        const deviceAvailableBytes = getNativeAvailableBytes();
        const candidates = [quotaAvailableBytes, deviceAvailableBytes].filter(Number.isFinite);
        const availableBytes = candidates.length ? Math.min(...candidates) : Infinity;
        return {
            usageBytes,
            quotaBytes,
            quotaAvailableBytes,
            deviceAvailableBytes,
            availableBytes,
            writableBytes: Number.isFinite(availableBytes)
                ? Math.max(0, availableBytes - RESERVE_BYTES)
                : Infinity,
            source: deviceAvailableBytes !== null ? 'device' : 'browser'
        };
    }

    async function ensureCapacity(additionalBytes, label = '本次操作') {
        const required = Math.max(0, Number(additionalBytes) || 0) + RESERVE_BYTES;
        const status = await getStorageStatus();
        const available = status.availableBytes;
        if (available < required) {
            const qualifier = status.source === 'device' ? '设备实际' : '浏览器估算';
            const error = new Error(`${label}至少还需要 ${formatGigabytes(required)} 可用空间，当前${qualifier}可用 ${formatGigabytes(available)}。`);
            error.code = 'INSUFFICIENT_STORAGE';
            error.required = required;
            error.available = available;
            throw error;
        }
        return { required, available, status };
    }

    function formatGigabytes(bytes) {
        const value = Math.max(0, Number(bytes) || 0);
        return `${(value / DECIMAL_GIGABYTE).toFixed(2)} GB`;
    }

    async function updateStorageSummary(element) {
        if (!element) return null;
        const status = await getStorageStatus();
        const used = status.usageBytes === null ? '未知' : formatGigabytes(status.usageBytes);
        const available = status.source === 'device'
            ? status.deviceAvailableBytes
            : status.quotaAvailableBytes;
        const availableText = available === null ? '未知' : formatGigabytes(available);
        element.textContent = status.source === 'device'
            ? `应用占用 ${used} · 设备可用 ${availableText}`
            : `应用占用 ${used} · 浏览器估算可用 ${availableText}`;
        return status;
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
        getNativeAvailableBytes,
        getStorageStatus,
        ensureCapacity,
        updateStorageSummary,
        assertOwnedName,
        formatBytes,
        formatGigabytes
    });
})(globalThis);
