const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadStorage(estimate, deviceAvailableBytes = null) {
    const context = {
        AndroidFileBridge: deviceAvailableBytes === null ? undefined : {
            getAvailableStorageBytes: () => deviceAvailableBytes
        },
        navigator: {
            storage: {
                estimate: async () => estimate,
                persisted: async () => false,
                persist: async () => true
            }
        }
    };
    context.globalThis = context;
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../js/asset-storage.js'), 'utf8'), context);
    return context.EcrypteesAssetStorage;
}

test('storage preflight preserves the 64 MiB reserve', async () => {
    const storage = loadStorage({ quota: 100 * 1024 * 1024, usage: 30 * 1024 * 1024 });
    await storage.ensureCapacity(6 * 1024 * 1024, '测试导入');
    await assert.rejects(
        storage.ensureCapacity(7 * 1024 * 1024, '测试导入'),
        error => error.code === 'INSUFFICIENT_STORAGE' && error.required > error.available
    );
    assert.equal((await storage.requestPersistence()).persisted, true);
});

test('storage deletion guards reject other asset namespaces', () => {
    const storage = loadStorage({ quota: 1, usage: 0 });
    assert.equal(
        storage.assertOwnedName('ecryptees-video-asset-abc.mp4', ['ecryptees-video-asset-']),
        'ecryptees-video-asset-abc.mp4'
    );
    assert.throws(
        () => storage.assertOwnedName('ecryptees-history-book-page', ['ecryptees-video-asset-']),
        /不属于当前资产类型/
    );
    assert.throws(
        () => storage.assertOwnedName('../ecryptees-video-asset-abc.mp4', ['ecryptees-video-asset-']),
        /不属于当前资产类型/
    );
});

test('Android capacity uses actual device free space and summaries stay in decimal GB', async () => {
    const storage = loadStorage(
        { quota: 20 * 1000 ** 3, usage: 2 * 1000 ** 3 },
        3.25 * 1000 ** 3
    );
    const status = await storage.getStorageStatus();
    assert.equal(status.source, 'device');
    assert.equal(status.availableBytes, 3.25 * 1000 ** 3);
    assert.equal(storage.formatGigabytes(1.5 * 1000 ** 3), '1.50 GB');
    const element = { textContent: '' };
    await storage.updateStorageSummary(element);
    assert.equal(element.textContent, '应用占用 2.00 GB · 设备可用 3.25 GB');
});
