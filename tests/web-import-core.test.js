const test = require('node:test');
const assert = require('node:assert/strict');

require('../js/web-import-core.js');

const webImport = globalThis.Ecryptees.webImport;

test('web import prefers original and lazy image attributes before srcset and src', () => {
    assert.equal(webImport.selectImageSource({
        'data-original': 'original.webp',
        'data-src': 'lazy.webp',
        srcset: 'small.jpg 320w, large.jpg 1280w',
        src: 'fallback.jpg'
    }), 'original.webp');
    assert.equal(webImport.selectImageSource({
        srcset: 'small.jpg 1x, large.jpg 2x',
        src: 'fallback.jpg'
    }), 'large.jpg');
});

test('web import resolves relative URLs, preserves DOM order, and marks duplicates', () => {
    const records = [
        { src: '/pages/001.jpg' },
        { 'data-src': '//cdn.example.com/002.webp' },
        { srcset: '/pages/003-small.jpg 320w, /pages/003.jpg 1600w' },
        { src: '/pages/001.jpg#copy' },
        { src: 'http://insecure.example/004.jpg' },
        { src: 'data:image/png;base64,AAAA' }
    ];
    const result = webImport.resolveImageRecords(records, 'https://reader.example/chapter/1');
    assert.deepEqual(result.map(item => item.url), [
        'https://reader.example/pages/001.jpg',
        'https://cdn.example.com/002.webp',
        'https://reader.example/pages/003.jpg',
        'https://reader.example/pages/001.jpg'
    ]);
    assert.deepEqual(result.map(item => item.duplicateOf), [-1, -1, -1, 0]);
});

test('web import caps candidate records without changing their order', () => {
    const records = Array.from({ length: 510 }, (_, index) => ({ src: `/p/${index}.jpg` }));
    const result = webImport.resolveImageRecords(records, 'https://example.com/', 500);
    assert.equal(result.length, 500);
    assert.equal(result[0].url, 'https://example.com/p/0.jpg');
    assert.equal(result[499].url, 'https://example.com/p/499.jpg');
});

test('18comic scrambled pages receive the deterministic strip restoration plan', () => {
    assert.equal(webImport.md5Hex('41613000001'), '2f7bd47844c13bd7fe289326dc1dd7c7');
    assert.equal(webImport.get18ComicSliceCount('416130', '00001'), 12);
    const transform = webImport.resolve18ComicTransform(
        'https://18comic.vip/photo/1233986',
        'https://cdn.example.net/media/photos/1233986/00001.webp',
        'var aid = 1233986; var scramble_id = 220980;'
    );
    assert.deepEqual(transform, {
        kind: '18comic-scramble',
        aid: '1233986',
        pageId: '00001',
        slices: webImport.get18ComicSliceCount('1233986', '00001')
    });
    assert.equal(webImport.resolve18ComicTransform(
        'https://example.com/photo/1233986',
        'https://cdn.example.net/media/photos/1233986/00001.webp'
    ), null);
});
