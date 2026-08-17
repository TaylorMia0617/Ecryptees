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
    for (const id of ['historyGrid', 'historyGroupFilterSelect', 'historySort', 'historySearch', 'addHistoryFolderButton', 'clearHistoryButton']) {
        assert.match(center, new RegExp(`${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*addEventListener`));
        assert.doesNotMatch(comic, new RegExp(`${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*addEventListener`));
        assert.doesNotMatch(image, new RegExp(`${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*addEventListener`));
        assert.doesNotMatch(video, new RegExp(`${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*addEventListener`));
    }
});
