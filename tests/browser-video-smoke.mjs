import fs from 'node:fs';

const endpoint = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222';
const screenshotPath = process.argv[2] || '';
const pages = await (await fetch(`${endpoint}/json/list`)).json();
const page = pages.find(item => item.type === 'page' && (
    item.url.includes('127.0.0.1:8000') || item.url.startsWith('file:///D:/DevFiles/Ecryptees/')
));
if (!page) throw new Error('Ecryptees browser page was not found');

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
});

let sequence = 0;
const pending = new Map();
const exceptions = [];
const navigations = [];
socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
        exceptions.push(message.params.exceptionDetails.text);
    } else if (message.method === 'Page.frameNavigated' && !message.params.frame.parentId) {
        navigations.push(message.params.frame.url);
    }
});

function send(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
    });
}

async function evaluate(expression) {
    const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
}

async function waitFor(expression, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for: ${expression}`);
}

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
    width: 412,
    height: 915,
    deviceScaleFactor: 1,
    mobile: true,
    screenOrientation: { type: 'portraitPrimary', angle: 0 }
});
if (!page.url.includes('127.0.0.1:8000')) {
    await send('Page.navigate', { url: 'http://127.0.0.1:8000/' });
    await waitFor("location.origin === 'http://127.0.0.1:8000' && document.readyState === 'complete'");
}
await send('Storage.clearDataForOrigin', {
    origin: 'http://127.0.0.1:8000',
    storageTypes: 'all'
});
await evaluate("window.__ecrypteesSmokeReloading = true");
await send('Page.reload', { ignoreCache: true });
await waitFor("document.readyState === 'complete' && !window.__ecrypteesSmokeReloading && document.body.dataset.lockState === 'unlocked'");
await evaluate("navigator.serviceWorker.ready.then(() => true)");
if (!await evaluate("Boolean(navigator.serviceWorker.controller)")) {
    await evaluate("window.__ecrypteesSmokeReloading = true");
    await send('Page.reload', { ignoreCache: true });
    await waitFor("document.readyState === 'complete' && !window.__ecrypteesSmokeReloading && document.body.dataset.lockState === 'unlocked'");
}
await waitFor("Boolean(navigator.serviceWorker.controller)");
await evaluate("document.getElementById('videoTab').click()");
await waitFor("!document.getElementById('videoPanel').hidden");
await evaluate(`(() => {
    const bytes = new Uint8Array(4096);
    bytes.set([0,0,0,24,0x66,0x74,0x79,0x70,0x69,0x73,0x6f,0x6d,0,0,0,0,0x69,0x73,0x6f,0x6d,0x6d,0x70,0x34,0x32]);
    const file = new File([bytes], 'browser-smoke.mp4', { type: 'video/mp4', lastModified: 1700000000000 });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.getElementById('videoSourceFile');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('encryptVideoButton').click();
    return true;
})()`);
await waitFor("document.getElementById('videoStatus').textContent.includes('已写入应用数据并加入视频资产') && !document.getElementById('viewSavedVideoButton').hidden", 45000);
await evaluate("document.getElementById('viewSavedVideoButton').click()");
try {
    await waitFor("document.querySelectorAll('.video-asset-card').length === 1", 5000);
} catch (error) {
    const diagnostic = await evaluate(`(async () => {
        const state = await EcrypteesVideoAssets.listVideoAssets();
        return {
            historyHidden: document.getElementById('historyPanel').hidden,
            videoAssetsActive: document.getElementById('assetTypeVideoButton').classList.contains('is-active'),
            videoAssetsControllerActive: EcrypteesVideoAssetsUI.isActive(),
            gridHtml: document.getElementById('historyGrid').innerHTML.slice(0, 600),
            folderValue: document.getElementById('historyGroupFilterSelect').value,
            folderOptions: document.getElementById('historyGroupFilterSelect').textContent,
            searchValue: document.getElementById('historySearch').value,
            sortValue: document.getElementById('historySort').value,
            historyStatus: document.getElementById('historyStatus').textContent,
            videoStatus: document.getElementById('videoStatus').textContent,
            databaseAssets: state.assets
        };
    })()`);
    throw new Error(`${error.message}; state=${JSON.stringify(diagnostic)}; navigations=${JSON.stringify(navigations)}; exceptions=${exceptions.join('; ')}`);
}
const cardUiResult = await evaluate(`(() => {
    const card = document.querySelector('.video-asset-card');
    const poster = card.querySelector('[data-video-asset-action="play"]');
    return {
        posterTag: poster?.tagName || '',
        posterLabel: poster?.getAttribute('aria-label') || '',
        actionLabels: Array.from(card.querySelectorAll('.video-asset-actions button'), button => button.textContent.trim()),
        standalonePlayButtons: Array.from(card.querySelectorAll('button')).filter(button => button.textContent.trim() === '播放').length
    };
})()`);
await evaluate("document.querySelector('[data-video-asset-action=menu]').click()");
await waitFor("document.getElementById('videoAssetMenuDialog').open && !document.getElementById('videoAssetMenuView').hidden");
if (screenshotPath) {
    const sheetCapture = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(screenshotPath.replace(/\.png$/i, '-action-sheet.png'), Buffer.from(sheetCapture.data, 'base64'));
}
await evaluate("document.getElementById('videoAssetRenameButton').click(); document.getElementById('videoAssetRenameInput').value = 'UI smoke video'; document.getElementById('videoAssetRenameForm').requestSubmit()");
await waitFor("!document.getElementById('videoAssetMenuDialog').open && document.querySelector('.history-card-title').textContent === 'UI smoke video'");
await evaluate("document.querySelector('[data-video-asset-action=menu]').click(); document.getElementById('videoAssetGroupButton').click(); document.getElementById('videoAssetNewGroupInput').value = 'Smoke group'; document.getElementById('videoAssetCreateGroupButton').click()");
await waitFor("document.getElementById('videoAssetGroupSelect').value && document.getElementById('videoAssetGroupMessage').textContent.includes('已新建分组')");
await evaluate("document.getElementById('videoAssetGroupForm').requestSubmit()");
await waitFor("!document.getElementById('videoAssetMenuDialog').open");
await waitFor("Array.from(document.getElementById('historyGroupFilterSelect').options).some(option => option.textContent.includes('Smoke group'))");
await evaluate(`(() => {
    const select = document.getElementById('historyGroupFilterSelect');
    select.value = Array.from(select.options).find(option => option.textContent.includes('Smoke group')).value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await waitFor("document.querySelectorAll('.video-asset-card').length === 1");
await evaluate("document.getElementById('historyGroupFilterSelect').value = 'all'; document.getElementById('historyGroupFilterSelect').dispatchEvent(new Event('change', { bubbles: true }))");
await waitFor("document.querySelectorAll('.video-asset-card').length === 1");
await evaluate("document.getElementById('videoTab').click()");
await waitFor("!document.getElementById('videoPanel').hidden");
await evaluate(`(() => {
    const bytes = new Uint8Array(4096);
    bytes.set([0,0,0,24,0x66,0x74,0x79,0x70,0x69,0x73,0x6f,0x6d,0,0,0,0,0x69,0x73,0x6f,0x6d,0x6d,0x70,0x34,0x32]);
    bytes[bytes.length - 1] = 7;
    const file = new File([bytes], 'second-smoke.mp4', { type: 'video/mp4', lastModified: 1700000001000 });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.getElementById('videoSourceFile');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('videoArchiveName').value = 'Second smoke video';
    document.getElementById('encryptVideoButton').click();
})()`);
await waitFor("document.getElementById('videoStatus').textContent.includes('已写入应用数据并加入视频资产') && !document.getElementById('viewSavedVideoButton').hidden", 45000);
await evaluate("document.getElementById('viewSavedVideoButton').click()");
await waitFor("document.querySelectorAll('.video-asset-card').length === 2");
await evaluate(`(() => {
    const card = Array.from(document.querySelectorAll('.video-asset-card')).find(item => item.querySelector('.history-card-title')?.textContent === 'UI smoke video');
    card.querySelector('[data-video-asset-action=play]').click();
})()`);
await waitFor("document.getElementById('videoPlayerDialog').open && document.getElementById('videoAssetPlayer').src", 45000);
await evaluate("document.getElementById('openVideoEpisodeRowButton').click()");
await waitFor("document.getElementById('videoPlayerShell').dataset.drawerOpen === 'true' && document.querySelectorAll('.video-episode-item').length === 2");
await new Promise(resolve => setTimeout(resolve, 250));
const playerUiResult = await evaluate(`(() => ({
    nativeControls: document.getElementById('videoAssetPlayer').controls,
    drawerSide: getComputedStyle(document.getElementById('videoEpisodeDrawer')).left,
    groups: Array.from(document.querySelectorAll('.video-episode-group-button'), button => button.textContent.trim()),
    currentItems: document.querySelectorAll('.video-episode-item[aria-current="true"]').length,
    currentTitle: document.querySelector('.video-episode-copy strong')?.textContent || ''
}))()`);
if (screenshotPath) {
    const portraitCapture = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(screenshotPath.replace(/\.png$/i, '-player-portrait.png'), Buffer.from(portraitCapture.data, 'base64'));
    await send('Emulation.setDeviceMetricsOverride', {
        width: 915,
        height: 412,
        deviceScaleFactor: 1,
        mobile: true,
        screenOrientation: { type: 'landscapePrimary', angle: 90 }
    });
    await new Promise(resolve => setTimeout(resolve, 250));
    const landscapeCapture = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(screenshotPath.replace(/\.png$/i, '-player-landscape.png'), Buffer.from(landscapeCapture.data, 'base64'));
    await send('Emulation.setDeviceMetricsOverride', {
        width: 412,
        height: 915,
        deviceScaleFactor: 1,
        mobile: true,
        screenOrientation: { type: 'portraitPrimary', angle: 0 }
    });
}
await evaluate("document.querySelector('.video-episode-item:not([aria-current=true])').click()");
await waitFor("document.getElementById('videoPlayerShell').dataset.drawerOpen === 'false' && document.getElementById('videoPlayerTitleText').textContent === 'Second smoke video'", 45000);
const switchUiResult = await evaluate(`({
    title: document.getElementById('videoPlayerTitleText').textContent,
    drawerOpen: document.getElementById('videoPlayerShell').dataset.drawerOpen,
    sourceIsBlob: document.getElementById('videoAssetPlayer').src.startsWith('blob:')
})`);
await evaluate("document.getElementById('videoMoreButton').click()");
await waitFor("!document.getElementById('videoPlayerMoreMenu').hidden");

const archiveRoundTrip = await evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    const state = await EcrypteesVideoAssets.listVideoAssets();
    const assetName = state.assets[0].opfsName;
    const source = await (await root.getFileHandle(assetName)).getFile();
    const worker = new Worker('js/video-worker.js');
    let sequence = 0;
    const run = (type, payload, expectedType) => new Promise((resolve, reject) => {
        const id = 'browser-roundtrip-' + (++sequence);
        const onMessage = event => {
            if (event.data?.id !== id || (event.data.type !== expectedType && event.data.type !== 'error')) return;
            worker.removeEventListener('message', onMessage);
            if (event.data.type === 'error') reject(new Error(event.data.message));
            else resolve(event.data);
        };
        worker.addEventListener('message', onMessage);
        worker.postMessage({ id, type, payload });
    });
    try {
        const encrypted = await run('encrypt', {
            file: source,
            title: 'browser-roundtrip',
            parallelism: 2,
            opfsName: 'browser-roundtrip.emp4'
        }, 'encrypted');
        const archiveBytes = new Uint8Array(await encrypted.file.arrayBuffer());
        const fingerprinted = await run('fingerprint', { file: source }, 'fingerprinted');
        const imported = await run('import', {
            file: encrypted.file,
            opfsName: 'browser-roundtrip.mp4'
        }, 'imported');
        const importedBytes = new Uint8Array(await imported.file.arrayBuffer());
        const sourceBytes = new Uint8Array(await source.arrayBuffer());
        return {
            archiveBytes: Array.from(archiveBytes),
            sourceBytes: Array.from(sourceBytes),
            archiveMagic: String.fromCharCode(...archiveBytes.slice(0, 8)),
            contentId: fingerprinted.contentId,
            importedContentId: imported.contentId,
            exact: sourceBytes.length === importedBytes.length
                && sourceBytes.every((byte, index) => byte === importedBytes[index])
        };
    } finally {
        worker.terminate();
        await root.removeEntry('browser-roundtrip.emp4').catch(() => {});
        await root.removeEntry('browser-roundtrip.mp4').catch(() => {});
    }
})()`);

const result = await evaluate(`(async () => {
    const player = document.getElementById('videoAssetPlayer');
    const root = await navigator.storage.getDirectory();
    const stored = [];
    for await (const [name, handle] of root.entries()) {
        if (name.startsWith('ecryptees-video-asset-')) stored.push({ name, file: await handle.getFile() });
    }
    const storedBytes = stored[0]
        ? Array.from(new Uint8Array(await stored[0].file.slice(0, 24).arrayBuffer()))
        : [];
    const state = await EcrypteesVideoAssets.listVideoAssets();
    return {
        selectedTab: document.querySelector('[role=tab][aria-selected=true]')?.dataset.mode,
        cards: document.querySelectorAll('.video-asset-card').length,
        dialogOpen: document.getElementById('videoPlayerDialog').open,
        playerSource: player.src,
        playerStatus: document.getElementById('videoPlayerStatus').textContent,
        videoStatus: document.getElementById('videoStatus').textContent,
        hasVideoPasswordControl: Boolean(document.querySelector('#videoPanel input[type=password]')),
        storedNames: stored.map(item => item.name),
        storedSize: stored[0]?.file.size || 0,
        storedType: String.fromCharCode(...storedBytes.slice(4, 8)),
        contentId: state.assets[0]?.contentId || ''
    };
})()`);

await evaluate("document.getElementById('closeVideoPlayerButton').click(); document.getElementById('videoTab').click()");
await waitFor("!document.getElementById('videoPanel').hidden");
await evaluate(`(() => {
    const file = new File([new Uint8Array(${JSON.stringify(archiveRoundTrip.sourceBytes)})], 'renamed-copy.mp4', { type: 'video/mp4' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.getElementById('videoSourceFile');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('encryptVideoButton').click();
})()`);
await waitFor("document.getElementById('videoStatus').textContent.includes('未重复导入')", 45000);
await evaluate("document.getElementById('videoOpenModeButton').click()");
await evaluate(`(() => {
    const file = new File([new Uint8Array(${JSON.stringify(archiveRoundTrip.archiveBytes)})], 'same-video.emp4', { type: 'application/vnd.ecryptees.emp4' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.getElementById('videoArchiveFile');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('openVideoButton').click();
})()`);
await waitFor("document.getElementById('videoStatus').textContent.includes('已直接打开原有资产')", 45000);
const duplicateResult = await evaluate(`(async () => {
    const state = await EcrypteesVideoAssets.listVideoAssets();
    const root = await navigator.storage.getDirectory();
    const names = [];
    for await (const name of root.keys()) if (name.startsWith('ecryptees-video-asset-')) names.push(name);
    return { assets: state.assets.length, files: names.length, contentId: state.assets[0]?.contentId || '' };
})()`);
await evaluate("document.getElementById('closeVideoPlayerButton').click(); document.getElementById('assetTypeComicButton').click()");
await waitFor("EcrypteesAssetCenter.isActive('comic') && !EcrypteesVideoAssetsUI.isActive()");
const switchResult = await evaluate(`({
    activeType: EcrypteesAssetCenter.getActiveType(),
    videoCards: document.querySelectorAll('.video-asset-card').length,
    videoCount: document.querySelector('[data-asset-count=video]').textContent
})`);
await evaluate("document.getElementById('assetTypeVideoButton').click()");
await waitFor("EcrypteesAssetCenter.isActive('video') && document.querySelectorAll('.video-asset-card').length === 2");

if (screenshotPath) {
    const capture = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(screenshotPath, Buffer.from(capture.data, 'base64'));
}

await send('Page.navigate', { url: 'file:///D:/DevFiles/Ecryptees/index.html' });
await waitFor("document.readyState === 'complete' && document.body.dataset.lockState === 'unlocked'");
await evaluate("document.getElementById('videoTab').click(); document.getElementById('videoOpenModeButton').click()");
await waitFor("!document.getElementById('videoPanel').hidden && !document.getElementById('videoOpenPanel').hidden");
await evaluate(`(() => {
    const file = new File([new Uint8Array(${JSON.stringify(archiveRoundTrip.archiveBytes)})], 'browser-roundtrip.emp4', {
        type: 'application/vnd.ecryptees.emp4'
    });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.getElementById('videoArchiveFile');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('openVideoButton').click();
})()`);
try {
    await waitFor("document.getElementById('videoStatus').textContent.includes('已解密为原始 MP4')", 45000);
} catch (error) {
    const diagnostic = await evaluate(`({
        status: document.getElementById('videoStatus').textContent,
        openDisabled: document.getElementById('openVideoButton').disabled,
        selectedName: document.getElementById('videoArchiveFile').files?.[0]?.name || '',
        hasOpfs: Boolean(navigator.storage?.getDirectory),
        panelVisible: !document.getElementById('videoOpenPanel').hidden
    })`);
    throw new Error(`${error.message}; localFileState=${JSON.stringify(diagnostic)}; exceptions=${exceptions.join('; ')}`);
}
const localFileResult = await evaluate(`(async () => {
    const names = [];
    let persistentStorage = true;
    try {
        const root = await navigator.storage.getDirectory();
        for await (const name of root.keys()) {
            if (name.startsWith('ecryptees-video-asset-')) names.push(name);
        }
    } catch (error) {
        persistentStorage = false;
    }
    return {
        openPanelVisible: !document.getElementById('videoOpenPanel').hidden,
        dialogOpen: document.getElementById('videoPlayerDialog').open,
        status: document.getElementById('videoStatus').textContent,
        storedNames: names,
        persistentStorage
    };
})()`);

socket.close();
if (exceptions.length) throw new Error(`Browser exceptions: ${exceptions.join('; ')}`);
if (result.cards !== 2 || !result.dialogOpen || result.hasVideoPasswordControl
    || !result.playerSource.startsWith('blob:') || result.storedNames.length !== 2
    || result.storedNames.some(name => !name.endsWith('.mp4') || name.endsWith('.emp4'))
    || result.storedSize !== 4096 || result.storedType !== 'ftyp') {
    throw new Error(`Unexpected browser state: ${JSON.stringify(result)}`);
}
if (cardUiResult.posterTag !== 'BUTTON' || cardUiResult.standalonePlayButtons !== 0
    || cardUiResult.actionLabels.join('|') !== '导出 .emp4|导出 MP4') {
    throw new Error(`Unexpected video card UI: ${JSON.stringify(cardUiResult)}`);
}
if (playerUiResult.nativeControls || playerUiResult.currentItems !== 1
    || playerUiResult.currentTitle !== 'UI smoke video'
    || !playerUiResult.groups.includes('Smoke group 1')) {
    throw new Error(`Unexpected player UI: ${JSON.stringify(playerUiResult)}`);
}
if (switchUiResult.title !== 'Second smoke video' || switchUiResult.drawerOpen !== 'false'
    || !switchUiResult.sourceIsBlob) {
    throw new Error(`Unexpected player switch UI: ${JSON.stringify(switchUiResult)}`);
}
if (archiveRoundTrip.archiveMagic !== 'ECRVID1\u0000' || !archiveRoundTrip.exact
    || archiveRoundTrip.contentId !== archiveRoundTrip.importedContentId
    || archiveRoundTrip.contentId !== result.contentId) {
    throw new Error(`Unexpected .emp4 round trip: ${JSON.stringify({
        archiveMagic: archiveRoundTrip.archiveMagic,
        exact: archiveRoundTrip.exact
    })}`);
}
if (duplicateResult.assets !== 2 || duplicateResult.files !== 2
    || duplicateResult.contentId !== archiveRoundTrip.contentId) {
    throw new Error(`Unexpected duplicate state: ${JSON.stringify(duplicateResult)}`);
}
if (switchResult.activeType !== 'comic' || switchResult.videoCards !== 0 || switchResult.videoCount !== '2') {
    throw new Error(`Unexpected asset switch state: ${JSON.stringify(switchResult)}`);
}
if (!localFileResult.openPanelVisible || !localFileResult.dialogOpen
    || localFileResult.storedNames.some(name => !name.endsWith('.mp4') || name.endsWith('.emp4'))) {
    throw new Error(`Unexpected local HTML state: ${JSON.stringify(localFileResult)}`);
}
console.log(JSON.stringify({ http: result, cardUi: cardUiResult, playerUi: playerUiResult, playerSwitch: switchUiResult, archive: {
    archiveMagic: archiveRoundTrip.archiveMagic,
    exact: archiveRoundTrip.exact
}, localFile: localFileResult }, null, 2));
