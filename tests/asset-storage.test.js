const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadStorage(estimate) {
    const context = {
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
