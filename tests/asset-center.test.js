const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeElement {
    constructor() {
        this.listeners = new Map();
        this.classList = { toggle() {} };
    }

    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(listener);
    }

    async emit(type, extra = {}) {
        for (const listener of this.listeners.get(type) || []) {
            await listener({ target: this, currentTarget: this, ...extra });
        }
    }

    setAttribute() {}
}

test('asset type switches deactivate the previous controller before refreshing the next one', async () => {
    const ids = [
        'assetTypeComicButton', 'assetTypeImageButton', 'assetTypeVideoButton', 'historyPanel',
        'historyGrid', 'historyGroupFilterSelect', 'historySort', 'historySearch',
        'addHistoryFolderButton', 'clearHistoryButton', 'historyGoToComicButton', 'historyStatus'
    ];
    const elements = new Map(ids.map(id => [id, new FakeElement()]));
    const document = {
        getElementById: id => elements.get(id) || null,
        querySelector: () => null
    };
    const context = { document, console };
    context.globalThis = context;
    const source = fs.readFileSync(path.resolve(__dirname, '../js/asset-center.js'), 'utf8');
    vm.runInNewContext(source, context);

    const events = [];
    context.EcrypteesAssetCenter.register('comic', {
        activate() {
            events.push(`comic-active:${context.EcrypteesAssetCenter.getActiveType()}`);
        }
    });
    context.EcrypteesAssetCenter.register('video', {
        activate() { events.push('video-active'); },
        deactivate() { events.push('video-inactive'); }
    });

    await context.EcrypteesAssetCenter.activate('video');
    events.length = 0;
    await elements.get('assetTypeComicButton').emit('click');

    assert.deepEqual(events, ['video-inactive', 'comic-active:comic']);
    assert.equal(context.EcrypteesAssetCenter.isActive('comic'), true);
});

test('only the asset center owns shared shelf control listeners', () => {
    const center = fs.readFileSync(path.resolve(__dirname, '../js/asset-center.js'), 'utf8');
    const comic = fs.readFileSync(path.resolve(__dirname, '../js/comic-app.js'), 'utf8');
    const image = fs.readFileSync(path.resolve(__dirname, '../js/image-assets-app.js'), 'utf8');
    const video = fs.readFileSync(path.resolve(__dirname, '../js/video-app.js'), 'utf8');
    for (const id of ['historyGrid', 'historyGroupFilterSelect', 'historySort', 'historySearch', 'manageHistoryFoldersButton', 'addHistoryFolderButton', 'clearHistoryButton']) {
        assert.match(center, new RegExp(`${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*addEventListener`));
        assert.doesNotMatch(comic, new RegExp(`${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*addEventListener`));
        assert.doesNotMatch(image, new RegExp(`${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*addEventListener`));
        assert.doesNotMatch(video, new RegExp(`${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*addEventListener`));
    }
});

test('all asset types expose non-destructive group management', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
    const center = fs.readFileSync(path.resolve(__dirname, '../js/asset-center.js'), 'utf8');
    const comic = fs.readFileSync(path.resolve(__dirname, '../js/comic-app.js'), 'utf8');
    const imageStore = fs.readFileSync(path.resolve(__dirname, '../js/image-assets.js'), 'utf8');
    const videoStore = fs.readFileSync(path.resolve(__dirname, '../js/video-assets.js'), 'utf8');

    assert.match(html, /id="manageHistoryFoldersButton"[\s\S]*id="historyGroupFilterSelect"/);
    assert.match(html, /删除分组只会移除资产的分组归属/);
    assert.match(center, /renameGroup/);
    assert.match(center, /deleteGroup/);
    assert.match(comic, /renameHistoryGroup/);
    assert.match(comic, /deleteHistoryGroup/);
    assert.match(imageStore, /renameImageFolder/);
    assert.match(imageStore, /deleteImageFolder/);
    assert.match(videoStore, /renameVideoFolder/);
    assert.match(videoStore, /deleteVideoFolder/);
});

test('all asset cards expose a compact direct remove-group control', () => {
    const styles = fs.readFileSync(path.resolve(__dirname, '../css/styles.css'), 'utf8');
    const comic = fs.readFileSync(path.resolve(__dirname, '../js/comic-app.js'), 'utf8');
    const image = fs.readFileSync(path.resolve(__dirname, '../js/image-assets-app.js'), 'utf8');
    const video = fs.readFileSync(path.resolve(__dirname, '../js/video-app.js'), 'utf8');

    for (const source of [comic, image, video]) {
        assert.match(source, /history-card-group-control/);
        assert.match(source, /history-remove-group-button/);
        assert.match(source, /Array\.from\([^)]+\)\.slice\(0, 3\)\.join\(''\)/);
        assert.match(source, /['"]removeGroup['"]/);
    }
    assert.match(comic, /setHistoryBookGroup\(bookId, ''\)/);
    assert.match(image, /setImageAssetFolder\(assetId, ''\)/);
    assert.match(video, /setVideoAssetFolder\(assetId, ''\)/);
    assert.match(styles, /\.history-card-group-label\s*\{[^}]*width:\s*3em/s);
});
