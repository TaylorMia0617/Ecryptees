const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../js/network-adapter.js'), 'utf8');

function loadAdapter(values) {
    const context = vm.createContext({
        console,
        Uint8Array,
        ArrayBuffer,
        atob: value => Buffer.from(value, 'base64').toString('binary'),
        ...values
    });
    vm.runInContext(source, context, { filename: 'network-adapter.js' });
    return context.EcrypteesNetworkAdapter;
}

test('Android network adapter hides Java bridge arity and Base64 differences', async () => {
    const calls = [];
    const bridge = {
        beginRemoteFetch: (...args) => calls.push(['beginRemoteFetch', ...args]) && 'remote-token',
        getRemoteFetchStatus: token => JSON.stringify({ state: 'ready', token }),
        readRemoteFetchChunk: (...args) => calls.push(['readRemoteFetchChunk', ...args]) && 'AQID',
        cancelRemoteFetch: token => calls.push(['cancelRemoteFetch', token]),
        releaseRemoteFetch: token => calls.push(['releaseRemoteFetch', token]),
        beginRenderedPageCapture: (...args) => calls.push(['beginRenderedPageCapture', ...args]) && 'capture-token',
        getRenderedPageCaptureStatus: token => JSON.stringify({ state: 'ready', token }),
        readRenderedPageImageChunk: (...args) => calls.push(['readRenderedPageImageChunk', ...args]) && 'BAUG',
        releaseRenderedPageCapture: token => calls.push(['releaseRenderedPageCapture', token])
    };
    const adapter = loadAdapter({
        navigator: { userAgent: 'Android EcrypteesAndroid/1.0' },
        AndroidFileBridge: {},
        AndroidNetworkBridge: bridge
    });

    assert.equal(adapter.platform, 'android');
    assert.equal(await adapter.beginRenderedPageCapture('https://hitomi.la/reader/1.html#1', 80, true), 'capture-token');
    assert.deepEqual(calls.find(call => call[0] === 'beginRenderedPageCapture'), [
        'beginRenderedPageCapture', 'https://hitomi.la/reader/1.html#1', 80
    ]);
    assert.deepEqual(Array.from(await adapter.readRemoteFetchChunk('remote-token', 4096, 123)), [1, 2, 3]);
    assert.deepEqual(calls.find(call => call[0] === 'readRemoteFetchChunk'), [
        'readRemoteFetchChunk', 'remote-token', 4096
    ]);
    assert.deepEqual(Array.from(await adapter.readRenderedPageImageChunk('capture-token', 7, 8192, 456)), [4, 5, 6]);
    assert.deepEqual(calls.find(call => call[0] === 'readRenderedPageImageChunk'), [
        'readRenderedPageImageChunk', 'capture-token', 7, 456, 8192
    ]);
});

test('Windows network adapter preserves desktop options and raw chunk ordering', async () => {
    const calls = [];
    const bridge = {
        available: true,
        beginRemoteFetch: (...args) => calls.push(['beginRemoteFetch', ...args]) && 'remote-token',
        getRemoteFetchStatus: token => ({ state: 'ready', token }),
        readRemoteFetchChunk: (...args) => calls.push(['readRemoteFetchChunk', ...args]) && [9, 8],
        cancelRemoteFetch: token => calls.push(['cancelRemoteFetch', token]),
        releaseRemoteFetch: token => calls.push(['releaseRemoteFetch', token]),
        beginRenderedPageCapture: (...args) => calls.push(['beginRenderedPageCapture', ...args]) && 'capture-token',
        getRenderedPageCaptureStatus: token => ({ state: 'ready', token }),
        readRenderedPageImageChunk: (...args) => calls.push(['readRenderedPageImageChunk', ...args]) && [7, 6],
        releaseRenderedPageCapture: token => calls.push(['releaseRenderedPageCapture', token])
    };
    const adapter = loadAdapter({
        navigator: { userAgent: 'Windows' },
        EcrypteesDesktopNetwork: bridge
    });

    assert.equal(adapter.platform, 'windows');
    assert.equal(await adapter.beginRenderedPageCapture('https://example.com/reader', 40, true), 'capture-token');
    assert.deepEqual(calls.find(call => call[0] === 'beginRenderedPageCapture'), [
        'beginRenderedPageCapture', 'https://example.com/reader', 40, true
    ]);
    assert.deepEqual(Array.from(await adapter.readRemoteFetchChunk('remote-token', 4096, 123)), [9, 8]);
    assert.deepEqual(calls.find(call => call[0] === 'readRemoteFetchChunk'), [
        'readRemoteFetchChunk', 'remote-token', 4096, 123
    ]);
    assert.deepEqual(Array.from(await adapter.readRenderedPageImageChunk('capture-token', 7, 8192, 456)), [7, 6]);
    assert.deepEqual(calls.find(call => call[0] === 'readRenderedPageImageChunk'), [
        'readRenderedPageImageChunk', 'capture-token', 7, 8192, 456
    ]);
});
