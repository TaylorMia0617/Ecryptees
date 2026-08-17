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

test('web import resolves relative URLs, preserves DOM order, and removes duplicates from display candidates', () => {
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
        'https://reader.example/pages/003.jpg'
    ]);
    assert.deepEqual(result.map(item => item.duplicateOf), [-1, -1, -1]);
    assert.deepEqual(
        webImport.uniqueImageCandidates([...result, result[0]]).map(item => item.url),
        result.map(item => item.url)
    );
    assert.deepEqual(
        webImport.resolveImageRecords([
            { src: '/same.jpg' }, { src: '/same.jpg#copy' }, { src: '/next.jpg' }
        ], 'https://reader.example/', 2).map(item => item.url),
        ['https://reader.example/same.jpg', 'https://reader.example/next.jpg']
    );
});

test('web import caps candidate records without changing their order', () => {
    const records = Array.from({ length: 510 }, (_, index) => ({ src: `/p/${index}.jpg` }));
    const result = webImport.resolveImageRecords(records, 'https://example.com/', 500);
    assert.equal(result.length, 500);
    assert.equal(result[0].url, 'https://example.com/p/0.jpg');
    assert.equal(result[499].url, 'https://example.com/p/499.jpg');
});

test('web import extracts a complete embedded image list instead of the visible reader window', () => {
    const slides = Array.from({ length: 17 }, (_, index) =>
        `{\\"src\\":\\"https:\\/\\/cdn.example.com\\/book\\/hash-${index + 1}\\/${index + 1}.webp\\"}`
    ).join(',');
    const html = `<script>self.readerData={\\"slides\\":[${slides}],\\"startingPage\\":0}</script>`;
    const result = webImport.extractEmbeddedImageCandidates(html, 'https://reader.example/viewer?page=1');
    assert.equal(result.length, 17);
    assert.equal(result[0].url, 'https://cdn.example.com/book/hash-1/1.webp');
    assert.equal(result[16].url, 'https://cdn.example.com/book/hash-17/17.webp');
    assert.deepEqual(result.map(item => item.duplicateOf), Array(17).fill(-1));
});

test('web import keeps one semantic page track and ignores larger recommendation arrays', () => {
    const pages = Array.from({ length: 8 }, (_, index) =>
        `{url:"https://cdn.example.com/chapter/${index + 1}.jpg",url1280:"https://cdn.example.com/chapter/${index + 1}.webp-t.w1280.jpg.h"}`
    ).join(',');
    const recommendations = Array.from({ length: 30 }, (_, index) =>
        `{cover:"https://cdn.example.com/recommend/${index + 1}.jpg"}`
    ).join(',');
    const html = `<script>window.data={comic_images:[${pages}],recommendations:[${recommendations}]}</script>`;
    const result = webImport.extractEmbeddedImageCandidates(html, 'https://reader.example/chapter/1');
    assert.equal(result.length, 8);
    assert.equal(result[0].url, 'https://cdn.example.com/chapter/1.webp-t.w1280.jpg.h');
    assert.equal(result[7].url, 'https://cdn.example.com/chapter/8.webp-t.w1280.jpg.h');
    assert.equal(result[0].attributes.trackName, 'comic_images');
    const unrelatedDom = webImport.resolveImageRecords(Array.from({ length: 500 }, (_, index) => ({
        src: `https://cdn.example.com/recommend/${index + 1}.jpg`
    })), 'https://reader.example/chapter/1');
    assert.equal(webImport.selectBestCandidateSet(unrelatedDom, result), result);
});

test('web import uses generic reader hints for small preview sets', () => {
    const previews = webImport.resolveImageRecords([
        { src: '/thumbnails/1.webp' },
        { src: '/thumbnails/2.webp' },
        { src: '/thumbnails/3.webp' }
    ], 'https://example.com/gallery/1');
    const originals = webImport.resolveImageRecords(Array.from({ length: 12 }, (_, index) => ({
        src: `/original/${index + 1}.webp`
    })), 'https://example.com/viewer/1');
    assert.equal(webImport.selectBestCandidateSet(previews, originals), originals);
    assert.equal(webImport.shouldCaptureRenderedPage(previews, '<a id="read-online-button">Read Online</a>'), true);
    assert.equal(webImport.shouldCaptureRenderedPage(originals, '<main class="reader"></main>'), false);
    assert.equal(webImport.shouldCaptureRenderedPage([], '<ul class="comic-contain" id="images"></ul>'), true);
});

test('Hitomi gallery pages bypass decorative images and open the real scripted reader', () => {
    const decorative = webImport.resolveImageRecords([
        { src: '//ltn.gold-usergeneratedcontent.net/logo.png' },
        { src: '//ltn.gold-usergeneratedcontent.net/down-arrow.png' },
        { src: '//ltn.gold-usergeneratedcontent.net/cover.webp' }
    ], 'https://hitomi.la/doujinshi/example-2970668.html#7');
    const plan = webImport.planRenderedPageCapture(
        decorative,
        '<a href="#" id="read-online-button">Read Online</a><ul class="thumbnail-list"></ul>',
        'https://hitomi.la/doujinshi/example-2970668.html#7'
    );

    assert.deepEqual({ ...plan }, {
        required: true,
        preferRendered: true,
        discardStaticFallback: true,
        url: 'https://hitomi.la/reader/2970668.html#7',
        reason: 'scripted-gallery-reader'
    });
    assert.equal(webImport.planRenderedPageCapture(
        decorative,
        '<main></main>',
        'https://example.com/gallery/2970668'
    ).required, false);
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
