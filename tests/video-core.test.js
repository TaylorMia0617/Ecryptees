const test = require('node:test');
const assert = require('node:assert/strict');

require('../js/video-core.js');

const video = globalThis.Ecryptees.video;
const { format, crypto: videoCrypto, VideoError } = video;

function concat(parts) {
    const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.length;
    }
    return output;
}

async function buildArchive(bytes) {
    const file = {
        name: 'movie.mp4',
        type: 'video/mp4',
        size: bytes.length,
        lastModified: 1700000000000
    };
    const manifest = format.createManifest(file, '测试视频');
    const manifestBytes = format.encodeManifest(manifest);
    const keyMode = format.KEY_MODE_BUILTIN;
    const builtinSource = new TextEncoder().encode('test builtin source');
    const rawKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const salt = Uint8Array.from({ length: 16 }, (_, index) => 0x20 + index);
    const wrapNonce = Uint8Array.from({ length: 12 }, (_, index) => 0x40 + index);
    const noncePrefix = Uint8Array.from({ length: 8 }, (_, index) => 0x60 + index);
    const keyId = await videoCrypto.getBuiltinKeyId(builtinSource);
    const headerOptions = {
        keyMode,
        iterations: 0,
        totalPlainSize: bytes.length,
        manifestCipherLength: manifestBytes.length + format.AUTH_TAG_SIZE,
        salt,
        wrapNonce,
        noncePrefix,
        keyId
    };
    const draft = format.encodeHeader(headerOptions);
    const kek = await videoCrypto.deriveKek({
        keyMode,
        builtinSource,
        salt
    });
    headerOptions.wrappedKey = await videoCrypto.wrapContentKey(kek, rawKey, draft, wrapNonce);
    const headerBytes = format.encodeHeader(headerOptions);
    const header = format.decodeHeader(headerBytes);
    const key = await videoCrypto.importContentKey(rawKey);
    const parts = [headerBytes, await videoCrypto.encryptChunk(key, header, 0, manifestBytes)];
    for (let index = 0; index < header.chunkCount; index++) {
        const plain = bytes.slice(index * format.CHUNK_SIZE, (index + 1) * format.CHUNK_SIZE);
        parts.push(await videoCrypto.encryptChunk(key, header, index + 1, plain));
    }
    return { archive: concat(parts), header, manifest, rawKey, builtinSource };
}

test('.emp4 v1 preserves exact MP4 bytes across chunk boundaries', async () => {
    const source = Uint8Array.from({ length: format.CHUNK_SIZE + 37 }, (_, index) => index % 251);
    source.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70], 0);
    const fixture = await buildArchive(source);
    const expectedSize = fixture.header.dataOffset + source.length
        + fixture.header.chunkCount * format.AUTH_TAG_SIZE;
    assert.equal(fixture.archive.length, expectedSize);
    const key = await videoCrypto.importContentKey(fixture.rawKey);
    const restored = [];
    for (let index = 0; index < fixture.header.chunkCount; index++) {
        const length = format.getChunkPlainLength(source.length, index);
        const offset = format.getChunkCipherOffset(fixture.header, index);
        restored.push(await videoCrypto.decryptChunk(
            key,
            fixture.header,
            index + 1,
            fixture.archive.slice(offset, offset + length + format.AUTH_TAG_SIZE),
            length
        ));
    }
    assert.deepEqual(concat(restored), source);
    assert.equal(format.validateManifest(fixture.manifest, fixture.header, fixture.archive.length).title, '测试视频');
});

test('.emp4 v1 rejects password-mode headers and only accepts the built-in key mode', () => {
    const header = new Uint8Array(format.HEADER_SIZE);
    header.set(format.MAGIC);
    const view = new DataView(header.buffer);
    view.setUint8(8, format.VERSION);
    view.setUint8(9, 1);
    view.setUint8(10, 2);
    view.setUint8(11, 1);
    assert.throws(
        () => format.decodeHeader(header),
        error => error instanceof VideoError && error.code === 'UNSUPPORTED_CRYPTO'
    );
});

test('authenticated chunks reject corruption and counter substitution', async () => {
    const source = Uint8Array.from({ length: 100 }, (_, index) => index);
    const fixture = await buildArchive(source);
    const key = await videoCrypto.importContentKey(fixture.rawKey);
    const offset = format.getChunkCipherOffset(fixture.header, 0);
    const cipher = fixture.archive.slice(offset);
    cipher[10] ^= 0x80;
    await assert.rejects(
        videoCrypto.decryptChunk(key, fixture.header, 1, cipher, source.length),
        error => error.code === 'AUTH_FAILED'
    );
    const clean = fixture.archive.slice(offset);
    await assert.rejects(
        videoCrypto.decryptChunk(key, fixture.header, 2, clean, source.length),
        error => error.code === 'AUTH_FAILED'
    );
});

test('video byte ranges support full, open, bounded, and suffix forms', () => {
    assert.deepEqual(format.parseRangeHeader('', 1000), { start: 0, end: 999, partial: false });
    assert.deepEqual(format.parseRangeHeader('bytes=100-199', 1000), { start: 100, end: 199, partial: true });
    assert.deepEqual(format.parseRangeHeader('bytes=900-', 1000), { start: 900, end: 999, partial: true });
    assert.deepEqual(format.parseRangeHeader('bytes=-25', 1000), { start: 975, end: 999, partial: true });
    assert.throws(() => format.parseRangeHeader('bytes=1000-', 1000), error => error.code === 'INVALID_RANGE');
    assert.throws(() => format.parseRangeHeader('bytes=0-1,4-5', 1000), error => error.code === 'INVALID_RANGE');
});

test('MP4 prefix validation requires an ftyp box', () => {
    assert.equal(format.isMp4Prefix(Uint8Array.from([
        0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70,
        0x69, 0x73, 0x6F, 0x6D, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
    ])), true);
    assert.equal(format.isMp4Prefix(Uint8Array.from([0, 0, 0, 8, 0x6D, 0x64, 0x61, 0x74])), false);
});
