const test = require('node:test');
const assert = require('node:assert/strict');

require('../js/core.js');
require('../js/comic-core.js');
require('../js/history-core.js');

const comic = globalThis.Ecryptees.comic;
const history = globalThis.Ecryptees.history;

function makePage(index, overrides = {}) {
    return {
        name: `page-${index + 1}.png`,
        type: 'image/png',
        size: 10 + index,
        width: 100,
        height: 200,
        lastModified: 1700000000000 + index,
        entryName: `${history.config.HISTORY_PREFIX}fixture-page-${index}`,
        ...overrides
    };
}

function makeRecord(pageCount = 2, overrides = {}) {
    const pages = Array.from({ length: pageCount }, (_, index) => makePage(index));
    return {
        schemaVersion: history.config.SCHEMA_VERSION,
        bookId: '0123456789abcdef0123456789abcdef',
        title: '测试漫画',
        sourceName: 'test.ecomic',
        storageKind: 'indexeddb',
        coverEntryName: `${history.config.HISTORY_PREFIX}fixture-cover.jpg`,
        coverMime: 'image/jpeg',
        totalSize: pages.reduce((sum, page) => sum + page.size, 0),
        pages,
        png: { name: 'test-long.png', width: 100, height: 400, size: 1234, generatedAt: 1700000000000 },
        progress: { pageIndex: 1, pageRatio: 0.5 },
        createdAt: 1700000000000,
        updatedAt: 1700000001000,
        lastOpenedAt: 1700000002000,
        ...overrides
    };
}

test('book ID is stable and changes with the archive size', async () => {
    const header = new Uint8Array(comic.format.HEADER_SIZE);
    const first = await history.createBookId(header, 12345);
    assert.equal(first, await history.createBookId(header, 12345));
    assert.notEqual(first, await history.createBookId(header, 12346));
    assert.match(first, /^[0-9a-f]{32}$/);
});

test('history records normalize progress and expose frozen summaries', () => {
    const valid = history.validateRecord(makeRecord(2, { progress: { pageIndex: 99, pageRatio: -2 } }));
    assert.deepEqual(valid.progress, { pageIndex: 1, pageRatio: 0 });
    assert.equal(valid.pageCount, 2);
    assert.ok(Object.isFrozen(valid));
    assert.ok(Object.isFrozen(valid.pages));
    assert.ok(Object.isFrozen(history.summarizeRecord(valid)));
});

test('history titles are trimmed, bounded, and never empty', () => {
    assert.equal(history.normalizeTitle('  新标题  '), '新标题');
    assert.equal(history.normalizeTitle('   '), '漫画');
    assert.equal(history.normalizeTitle('漫'.repeat(140)).length, 120);
});

test('history validation accepts 80 pages and rejects the 81st', () => {
    assert.equal(history.validateRecord(makeRecord(80)).pageCount, 80);
    assert.throws(() => history.validateRecord(makeRecord(81)), /页数无效/);
});

test('history validation rejects invalid storage keys and totals over 500 MiB', () => {
    const wrongKey = makeRecord(1);
    wrongKey.pages[0].entryName = 'temporary-page';
    assert.throws(() => history.validateRecord(wrongKey), /信息无效/);

    const huge = makeRecord(1);
    huge.pages[0].size = comic.format.MAX_TOTAL_BYTES + 1;
    huge.totalSize = huge.pages[0].size;
    assert.throws(() => history.validateRecord(huge), /大小无效/);
});

test('worker exposes staging cleanup, shelf migration, and all history commands', () => {
    const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'js', 'comic-worker.js'), 'utf8');
    for (const command of ['historyList', 'historyOpen', 'historyDelete', 'historyProgress', 'historyRename', 'historyStorage', 'historyRedownload', 'historyArchive']) {
        assert.match(source, new RegExp(`type === '${command}'`));
    }
    assert.match(source, /STAGING_PREFIX/);
    assert.match(source, /historyCommitted/);
    assert.match(source, /kind: 'uploads'/);
    assert.match(source, /post\('archiveReady'/);
    assert.match(source, /post\('portableArchive'/);
    assert.match(source, /addToShelf: false/);
    assert.match(source, /progressRange: \{ start: 500, end: 1000, total: 1000 \}/);
});
