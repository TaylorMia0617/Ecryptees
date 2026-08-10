const test = require('node:test');
const assert = require('node:assert/strict');

require('../js/core.js');
require('../js/comic-core.js');

const comic = globalThis.Ecryptees.comic;
const { format, crypto: comicCrypto, ComicError } = comic;

function concatBytes(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.length;
    }
    return output;
}

async function buildFixture(files) {
    const records = files.map(file => ({
        name: file.name,
        type: file.type,
        size: file.bytes.length,
        lastModified: file.lastModified || 0
    }));
    const manifest = format.createManifest(records, 1700000000000);
    const manifestBytes = format.encodeManifest(manifest);
    const salt = Uint8Array.from({ length: 16 }, (_, index) => index);
    const noncePrefix = Uint8Array.from({ length: 8 }, (_, index) => 0xA0 + index);
    const keyId = await comicCrypto.getBuiltinKeyId();
    const headerBytes = format.encodeHeader({
        salt,
        noncePrefix,
        keyId,
        manifestCipherLength: manifestBytes.length + format.AUTH_TAG_SIZE,
        totalPlainSize: manifest.totalSize
    });
    const header = format.decodeHeader(headerBytes);
    const key = await comicCrypto.deriveBuiltinKey(salt);
    const parts = [
        headerBytes,
        await comicCrypto.encryptChunk(key, headerBytes, noncePrefix, 0, manifestBytes)
    ];
    let counter = 1;
    for (const file of files) {
        for (let offset = 0; offset < file.bytes.length; offset += format.CHUNK_SIZE) {
            const plain = file.bytes.slice(offset, offset + format.CHUNK_SIZE);
            parts.push(await comicCrypto.encryptChunk(key, headerBytes, noncePrefix, counter, plain));
            counter += 1;
        }
    }
    return { bytes: concatBytes(parts), header, key, manifest, files };
}

async function readFixture(archiveBytes) {
    const header = format.decodeHeader(archiveBytes.slice(0, format.HEADER_SIZE));
    const key = await comicCrypto.deriveBuiltinKey(header.salt);
    const manifestCipher = archiveBytes.slice(format.HEADER_SIZE, header.dataOffset);
    const manifestBytes = await comicCrypto.decryptChunk(
        key,
        header.bytes,
        header.noncePrefix,
        0,
        manifestCipher,
        header.manifestCipherLength - format.AUTH_TAG_SIZE
    );
    const manifest = format.validateManifest(format.decodeManifest(manifestBytes), header, archiveBytes.length);
    const files = [];
    for (const page of manifest.pages) {
        const chunks = [];
        for (let localIndex = 0; localIndex < page.chunkCount; localIndex++) {
            const plainLength = format.getPageChunkPlainLength(page, localIndex);
            const offset = format.getPageChunkCipherOffset(header, page, localIndex);
            const cipher = archiveBytes.slice(offset, offset + plainLength + format.AUTH_TAG_SIZE);
            chunks.push(await comicCrypto.decryptChunk(
                key,
                header.bytes,
                header.noncePrefix,
                page.firstChunk + localIndex,
                cipher,
                plainLength
            ));
        }
        files.push(concatBytes(chunks));
    }
    return { header, manifest, files };
}

test('built-in codebook key id is stable and HKDF is deterministic for a salt', async () => {
    assert.equal(Buffer.from(await comicCrypto.getBuiltinKeyId()).toString('hex'), 'e4c0af3803f6ed58');
    const salt = new Uint8Array(16);
    const header = new Uint8Array(format.HEADER_SIZE);
    const nonce = new Uint8Array(8);
    const plaintext = new TextEncoder().encode('deterministic fixture');
    const first = await comicCrypto.encryptChunk(
        await comicCrypto.deriveBuiltinKey(salt),
        header,
        nonce,
        1,
        plaintext
    );
    const second = await comicCrypto.encryptChunk(
        await comicCrypto.deriveBuiltinKey(salt),
        header,
        nonce,
        1,
        plaintext
    );
    assert.deepEqual(first, second);
});

test('nonce counter produces unique 12-byte nonces', () => {
    const prefix = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const first = comicCrypto.createNonce(prefix, 1);
    const second = comicCrypto.createNonce(prefix, 2);
    assert.equal(first.length, 12);
    assert.notDeepEqual(first, second);
    assert.deepEqual(first.slice(0, 8), prefix);
});

test('manifest plans page-aligned chunks and enforces count and total limits', () => {
    assert.equal(format.MAX_PAGES, 80);
    const manifest = format.createManifest([
        { name: '001.png', type: 'image/png', size: format.CHUNK_SIZE + 1, lastModified: 1 },
        { name: '002.gif', type: 'image/gif', size: 12, lastModified: 2 }
    ], 3);
    assert.equal(manifest.pages[0].firstChunk, 1);
    assert.equal(manifest.pages[0].chunkCount, 2);
    assert.equal(manifest.pages[1].firstChunk, 3);
    assert.equal(manifest.pages[1].cipherOffset, format.CHUNK_SIZE + 1 + 2 * format.AUTH_TAG_SIZE);

    const exactLimit = format.createManifest([
        { name: 'limit.png', type: 'image/png', size: format.MAX_TOTAL_BYTES }
    ]);
    assert.equal(exactLimit.totalSize, format.MAX_TOTAL_BYTES);
    assert.throws(() => format.createManifest([
        { name: 'large.png', type: 'image/png', size: format.MAX_TOTAL_BYTES + 1 }
    ]), error => error instanceof ComicError && error.code === 'TOTAL_TOO_LARGE');
    assert.equal(format.createManifest(Array.from({ length: 80 }, (_, index) => ({
        name: `${index}.png`, type: 'image/png', size: 1
    }))).pages.length, 80);
    assert.throws(() => format.createManifest(Array.from({ length: format.MAX_PAGES + 1 }, (_, index) => ({
        name: `${index}.png`, type: 'image/png', size: 1
    }))), error => error instanceof ComicError && error.code === 'TOO_MANY_PAGES');
});

test('multi-page archive round-trips exact bytes across a chunk boundary', async () => {
    const large = new Uint8Array(format.CHUNK_SIZE + 3);
    for (let index = 0; index < large.length; index++) {
        large[index] = index & 0xFF;
    }
    const small = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3]);
    const fixture = await buildFixture([
        { name: '第一话.png', type: 'image/png', bytes: large },
        { name: '第二话.gif', type: 'image/gif', bytes: small }
    ]);
    const restored = await readFixture(fixture.bytes);
    assert.equal(restored.manifest.pages.length, 2);
    assert.equal(restored.manifest.pages[0].name, '第一话.png');
    assert.deepEqual(restored.files[0], large);
    assert.deepEqual(restored.files[1], small);
});

test('header validation rejects bad magic, version, key mode, and reserved flags', async () => {
    const fixture = await buildFixture([{ name: 'a.png', type: 'image/png', bytes: Uint8Array.from([1]) }]);
    for (const [offset, code] of [[0, 'BAD_MAGIC'], [8, 'UNSUPPORTED_VERSION'], [9, 'UNSUPPORTED_KEY_MODE'], [12, 'UNSUPPORTED_OPTIONS']]) {
        const damaged = fixture.bytes.slice(0, format.HEADER_SIZE);
        damaged[offset] ^= 0x01;
        assert.throws(
            () => format.decodeHeader(damaged),
            error => error instanceof ComicError && error.code === code
        );
    }
});

test('authentication and size checks reject manifest/data damage, truncation, and append', async () => {
    const fixture = await buildFixture([{ name: 'a.png', type: 'image/png', bytes: Uint8Array.from([1, 2, 3, 4]) }]);
    const manifestDamage = fixture.bytes.slice();
    manifestDamage[format.HEADER_SIZE] ^= 0x01;
    await assert.rejects(() => readFixture(manifestDamage), error => error instanceof ComicError && error.code === 'AUTH_FAILED');

    const dataDamage = fixture.bytes.slice();
    dataDamage[dataDamage.length - 1] ^= 0x01;
    await assert.rejects(() => readFixture(dataDamage), error => error instanceof ComicError && error.code === 'AUTH_FAILED');

    await assert.rejects(
        () => readFixture(fixture.bytes.slice(0, -1)),
        error => error instanceof ComicError && error.code === 'INVALID_ARCHIVE_SIZE'
    );
    await assert.rejects(
        () => readFixture(concatBytes([fixture.bytes, Uint8Array.from([0])])),
        error => error instanceof ComicError && error.code === 'INVALID_ARCHIVE_SIZE'
    );
});
