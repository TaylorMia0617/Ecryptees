const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

require('../js/core.js');

const { codec, config } = globalThis.Ecryptees.core;
const repositoryRoot = path.resolve(__dirname, '..');
const pngBytes = Uint8Array.from([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    0x00, 0x00, 0x00, 0x0D
]);

function makeImage(type = 'image/png') {
    return {
        bytes: pngBytes,
        metadata: {
            name: 'fixture.png',
            type,
            size: pngBytes.length,
            compression: { mode: 'balanced' }
        }
    };
}

function makePayload(version = config.IMAGE_VERSION, type = 'image/png') {
    const payload = codec.buildImagePayload(makeImage(type));
    payload[8] = version;
    return payload;
}

test('text codec round-trips empty, ASCII, Chinese, and emoji input', () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    for (const value of ['', 'hello', '文本密文', 'emoji 😀❤']) {
        const encoded = codec.encodeBytes(encoder.encode(value));
        assert.equal(decoder.decode(codec.decodeCode(encoded)), value);
    }
});

test('text decoder rejects odd length and illegal characters', () => {
    assert.throws(
        () => codec.decodeCode(config.codebook[0]),
        error => error instanceof codec.CipherError && error.code === 'ODD_LENGTH'
    );
    assert.throws(
        () => codec.decodeCode('xx'),
        error => error instanceof codec.CipherError && error.code === 'ILLEGAL_CHARACTER'
    );
});

test('CRC32 matches the standard check value', () => {
    const input = new TextEncoder().encode('123456789');
    assert.equal(codec.calculateCrc32(input), 0xCBF43926);
});

test('v1, v2, and v3 image ciphertext remains decodable', async () => {
    const versions = [
        [config.LEGACY_IMAGE_VERSION, 'legacy'],
        [config.COMPACT_IMAGE_VERSION, 'compact'],
        [config.IMAGE_VERSION, 'compact']
    ];

    for (const [version, family] of versions) {
        const payload = makePayload(version);
        const ciphertext = family === 'legacy'
            ? codec.encodeBytes(payload)
            : await codec.encodeImageByteSegmentsChunked([payload], () => {});
        const decoded = await codec.decodeImageCodeChunked(ciphertext, () => {});
        const parsed = codec.parseImagePayload(decoded.payload);

        assert.equal(decoded.cipherFamily, family);
        assert.equal(decoded.payload[8], version);
        assert.equal(parsed.metadata.name, 'fixture.png');
        assert.deepEqual(parsed.imageBytes, pngBytes);
    }
});

test('payload parser rejects bad magic, unknown versions, and truncation', () => {
    const badMagic = makePayload();
    badMagic[0] ^= 0xFF;
    assert.throws(() => codec.parseImagePayload(badMagic), /有效的图片密文/);

    const unknownVersion = makePayload();
    unknownVersion[8] = 99;
    assert.throws(() => codec.parseImagePayload(unknownVersion), /不支持的图片密文版本/);

    const truncated = makePayload().slice(0, -1);
    assert.throws(() => codec.parseImagePayload(truncated), /长度不完整/);
});

test('payload parser rejects corrupt metadata, MIME mismatch, and CRC damage', () => {
    const corruptMetadata = makePayload();
    corruptMetadata[config.IMAGE_HEADER_SIZE] = 0xFF;
    assert.throws(() => codec.parseImagePayload(corruptMetadata), /文件信息已损坏/);

    const mimeMismatch = makePayload(config.IMAGE_VERSION, 'image/gif');
    assert.throws(() => codec.parseImagePayload(mimeMismatch), /格式信息与图片内容不一致/);

    const crcDamage = makePayload();
    crcDamage[crcDamage.length - 1] ^= 0x01;
    assert.throws(() => codec.parseImagePayload(crcDamage), /校验失败/);
});

test('static entry point references ordered external files without inline handlers', () => {
    const index = fs.readFileSync(path.join(repositoryRoot, 'index.html'), 'utf8');
    const styles = fs.readFileSync(path.join(repositoryRoot, 'css', 'styles.css'), 'utf8');
    const comicWorker = fs.readFileSync(path.join(repositoryRoot, 'js', 'comic-worker.js'), 'utf8');
    const background = fs.readFileSync(path.join(repositoryRoot, 'assets', 'background.jpg'));
    const corePosition = index.indexOf('src="js/core.js"');
    const comicCorePosition = index.indexOf('src="js/comic-core.js"');
    const historyCorePosition = index.indexOf('src="js/history-core.js"');
    const appPosition = index.indexOf('src="js/app.js"');
    const comicWorkerPosition = index.indexOf('src="js/comic-worker.js"');
    const comicAppPosition = index.indexOf('src="js/comic-app.js"');

    assert.ok(
        corePosition >= 0
            && comicCorePosition > corePosition
            && historyCorePosition > comicCorePosition
            && appPosition > historyCorePosition
            && comicWorkerPosition > appPosition
            && comicAppPosition > comicWorkerPosition,
        'scripts must load in core, comic-core, history-core, app, comic-worker, comic-app order'
    );
    assert.match(index, /href="css\/styles\.css"/);
    assert.match(index, /<script src="js\/core\.js" defer><\/script>/);
    assert.match(index, /<script src="js\/comic-core\.js" defer><\/script>/);
    assert.match(index, /<script src="js\/history-core\.js" defer><\/script>/);
    assert.match(index, /<script src="js\/app\.js" defer><\/script>/);
    assert.match(index, /<script src="js\/comic-worker\.js" defer><\/script>/);
    assert.match(index, /<script src="js\/comic-app\.js" defer><\/script>/);
    assert.doesNotMatch(index, /<style\b/);
    assert.doesNotMatch(index, /<script(?![^>]*\bsrc=)/);
    assert.doesNotMatch(index, /onclick\s*=/);
    assert.match(index, /<dialog[\s\S]*id="comicReaderDialog"/);
    assert.match(index, /id="comicReaderHint">长按任意图片可生成并下载整本单文件长图（PNG，动画取首帧）/);
    assert.match(index, /最多 80 张，导入原图总体积不超过 500 MiB/);
    assert.match(index, /id="exportComicLongImageButton"/);
    assert.match(index, /id="downloadComicLongImage"/);
    assert.match(index, /id="historyTab"[\s\S]*data-mode="history"/);
    assert.match(index, /id="historyPanel"/);
    assert.match(index, /id="selectHistoryDirectoryButton"/);
    assert.match(index, /id="migrateHistoryButton"/);
    assert.match(index, /id="openComicButton"[^>]*>解密、转存并阅读</);
    assert.match(index, /id="encryptComicButton"[^>]*>加密并加入书架</);
    assert.doesNotMatch(index, /id="exportComicZipButton"/);
    assert.doesNotMatch(index, /id="comicReaderSection"/);
    assert.match(comicWorker, /new self\.CompressionStream\('deflate'\)/);
    assert.match(comicWorker, /new self\.OffscreenCanvas/);
    assert.match(comicWorker, /name: `\$\{baseName\}-long\.png`/);
    assert.doesNotMatch(comicWorker, /-long\.svg/);
    const comicApp = fs.readFileSync(path.join(repositoryRoot, 'js', 'comic-app.js'), 'utf8');
    assert.match(comicApp, /exportLongImage\(true, true\)/);
    assert.match(comicApp, /historyAction === 'rename'/);
    assert.match(comicApp, /showDirectoryPicker/);
    assert.match(comicApp, /ecryptees-directory-v1/);
    assert.match(comicApp, /getFileHandle\('archive\.ecomic'/);
    assert.match(comicApp, /writeDirectoryFile\(folder, 'metadata\.json'/);
    assert.match(comicApp, /removeEntry\(bookId, \{ recursive: true \}\)/);
    assert.doesNotMatch(comicApp, /visibilityState === 'hidden'[\s\S]{0,500}releaseReaderPage/);
    assert.match(styles, /url\("\.\.\/assets\/background\.jpg"\)/);
    assert.equal(background[0], 0xFF);
    assert.equal(background[1], 0xD8);
    assert.equal(background.at(-2), 0xFF);
    assert.equal(background.at(-1), 0xD9);
    assert.equal(
        crypto.createHash('sha256').update(background).digest('hex'),
        '742807f8331c790cc92e679ff270202a614b733fb14ceef9d5922d3eb6977505'
    );
});
