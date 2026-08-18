import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const outputDirectory = process.argv[2] || '';

function contentType(file) {
    return ({
        '.css': 'text/css; charset=utf-8',
        '.html': 'text/html; charset=utf-8',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.js': 'text/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.svg': 'image/svg+xml; charset=utf-8',
        '.webmanifest': 'application/manifest+json; charset=utf-8'
    })[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

async function startIsolatedServer() {
    const server = http.createServer((request, response) => {
        try {
            const url = new URL(request.url || '/', 'http://127.0.0.1');
            const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
            const file = path.resolve(repositoryRoot, `.${relative}`);
            if (file !== repositoryRoot && !file.startsWith(`${repositoryRoot}${path.sep}`)) {
                response.writeHead(403).end();
                return;
            }
            const stats = fs.statSync(file);
            if (!stats.isFile()) throw new Error('Not a file');
            response.writeHead(200, {
                'Cache-Control': 'no-store',
                'Content-Length': stats.size,
                'Content-Type': contentType(file)
            });
            fs.createReadStream(file).pipe(response);
        } catch (error) {
            response.writeHead(404).end();
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function launchIsolatedEdge() {
    const candidates = [
        process.env.EDGE_PATH,
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    ].filter(Boolean);
    const executable = candidates.find(candidate => fs.existsSync(candidate));
    if (!executable) throw new Error('Microsoft Edge executable was not found');
    const profileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ecryptees-edge-smoke-'));
    const edgeProcess = spawn(executable, [
        '--headless=new',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-sync',
        '--no-first-run',
        '--remote-debugging-port=0',
        `--user-data-dir=${profileDirectory}`,
        'about:blank'
    ], { stdio: 'ignore', windowsHide: true });
    const portFile = path.join(profileDirectory, 'DevToolsActivePort');
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !fs.existsSync(portFile)) {
        if (edgeProcess.exitCode !== null) throw new Error(`Isolated Edge exited with ${edgeProcess.exitCode}`);
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!fs.existsSync(portFile)) throw new Error('Isolated Edge did not expose a debugging port');
    const port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/, 1)[0]);
    return { edgeProcess, profileDirectory, endpoint: `http://127.0.0.1:${port}` };
}

async function main() {
const { server, origin } = await startIsolatedServer();
const { edgeProcess, profileDirectory, endpoint } = await launchIsolatedEdge();
let socket;
try {
let pages = [];
const pageDeadline = Date.now() + 10000;
while (Date.now() < pageDeadline) {
    pages = await (await fetch(`${endpoint}/json/list`)).json();
    if (pages.some(item => item.type === 'page' && item.url === 'about:blank')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
}
const page = pages.find(item => item.type === 'page' && item.url === 'about:blank');
if (!page) throw new Error('The isolated Edge test page was not found');
if (outputDirectory) fs.mkdirSync(outputDirectory, { recursive: true });

socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
});

let sequence = 0;
const pending = new Map();
const exceptions = [];
const consoleErrors = [];
socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
        exceptions.push(message.params.exceptionDetails.text);
    } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
        consoleErrors.push(`${message.params.entry.text}${message.params.entry.url ? ` · ${message.params.entry.url}` : ''}`);
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

async function capture(name) {
    if (!outputDirectory) return '';
    const file = path.join(outputDirectory, `${name}.png`);
    const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    return file;
}

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
    screenOrientation: { type: 'portraitPrimary', angle: 0 }
});
await send('Page.navigate', { url: `${origin}/` });
await waitFor(`location.origin === ${JSON.stringify(origin)} && document.readyState === 'complete'`);
await send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
await evaluate("globalThis.__ecrypteesQaReloadMarker = 'initial-cleanup'");
await send('Page.reload', { ignoreCache: true });
await waitFor("globalThis.__ecrypteesQaReloadMarker !== 'initial-cleanup' && document.readyState === 'complete' && document.body.dataset.lockState === 'unlocked' && !document.getElementById('comicFiles').disabled", 45000);

const titles = ['星海旅行日记', '暮色列车', '无声航线', '月面来信'];
for (let bookIndex = 0; bookIndex < titles.length; bookIndex++) {
    const title = titles[bookIndex];
    await evaluate(`(async () => {
        document.getElementById('comicTab').click();
        const source = await (await fetch('assets/background.jpg')).blob();
        const transfer = new DataTransfer();
        for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
            transfer.items.add(new File([source], 'page-' + (pageIndex + 1) + '-${bookIndex}.jpg', {
                type: 'image/jpeg',
                lastModified: 1700000000000 + ${bookIndex} * 100 + pageIndex
            }));
        }
        const input = document.getElementById('comicFiles');
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('comicArchiveName').value = ${JSON.stringify(title)};
        return true;
    })()`);
    await waitFor("document.getElementById('comicSelectionSummary').textContent.startsWith('4 张') && !document.getElementById('encryptComicButton').disabled", 30000);
    await evaluate("document.getElementById('encryptComicButton').click()");
    try {
        await waitFor("document.getElementById('comicStatus').textContent.includes('漫画已加入资产') && !document.getElementById('encryptComicButton').disabled", 60000);
    } catch (error) {
        const state = await evaluate(`({
            status: document.getElementById('comicStatus').textContent,
            statusKind: document.getElementById('comicStatus').dataset.kind,
            summary: document.getElementById('comicSelectionSummary').textContent,
            encryptDisabled: document.getElementById('encryptComicButton').disabled,
            archiveName: document.getElementById('comicArchiveName').value,
            historyStatus: document.getElementById('historyStatus').textContent
        })`);
        throw new Error(`${error.message}; state=${JSON.stringify(state)}; exceptions=${exceptions.join('; ')}`);
    }
    await evaluate("document.getElementById('clearComicFilesButton').click()");
    await waitFor("document.getElementById('comicSelectionSummary').textContent.includes('尚未选择')");
}

const cleanupFixture = await evaluate(`(async () => {
    const openDatabase = (name, version) => new Promise((resolve, reject) => {
        const request = indexedDB.open(name, version);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const shelf = await openDatabase('ecryptees-library-v1', 1);
    const allRequest = shelf.transaction('books', 'readonly').objectStore('books').getAll();
    const records = await new Promise((resolve, reject) => {
        allRequest.onsuccess = () => resolve(allRequest.result);
        allRequest.onerror = () => reject(allRequest.error);
    });
    const storageKind = records[0].storageKind;
    const oldName = 'ecryptees-history-' + 'a'.repeat(32) + '-'
        + (Date.now() - 8 * 24 * 60 * 60 * 1000).toString(36) + '-qa-old';
    const recentName = 'ecryptees-history-' + 'b'.repeat(32) + '-'
        + Date.now().toString(36) + '-qa-recent';
    const writeArtifact = async name => {
        if (storageKind === 'opfs') {
            const root = await navigator.storage.getDirectory();
            const writable = await (await root.getFileHandle(name, { create: true })).createWritable();
            await writable.write(new Uint8Array([1]));
            await writable.close();
            return;
        }
        const storage = await openDatabase('ecryptees-comic-v1', 1);
        const parts = storage.transaction('parts', 'readwrite');
        parts.objectStore('parts').put(new Blob([new Uint8Array([1])]), name + ':00000000');
        await new Promise((resolve, reject) => { parts.oncomplete = resolve; parts.onerror = () => reject(parts.error); });
        const entries = storage.transaction('entries', 'readwrite');
        entries.objectStore('entries').put({ parts: 1, lastModified: Date.now() }, name);
        await new Promise((resolve, reject) => { entries.oncomplete = resolve; entries.onerror = () => reject(entries.error); });
    };
    await writeArtifact(oldName);
    await writeArtifact(recentName);
    const invalidBookId = 'f'.repeat(32);
    const invalidTransaction = shelf.transaction('books', 'readwrite');
    invalidTransaction.objectStore('books').put({ schemaVersion: 1, bookId: invalidBookId, title: '损坏元数据', pages: [] });
    await new Promise((resolve, reject) => {
        invalidTransaction.oncomplete = resolve;
        invalidTransaction.onerror = () => reject(invalidTransaction.error);
    });
    return { storageKind, oldName, recentName, invalidBookId };
})()`);

const artifactExistsExpression = name => cleanupFixture.storageKind === 'opfs'
    ? `(async () => { try { await (await navigator.storage.getDirectory()).getFileHandle(${JSON.stringify(name)}); return true; } catch (error) { return false; } })()`
    : `(async () => { const request = indexedDB.open('ecryptees-comic-v1', 1); const database = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); const get = database.transaction('entries', 'readonly').objectStore('entries').get(${JSON.stringify(name)}); return Boolean(await new Promise((resolve, reject) => { get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error); })); })()`;

await evaluate("globalThis.__ecrypteesQaReloadMarker = 'guarded-cleanup'");
await send('Page.reload', { ignoreCache: true });
await waitFor("globalThis.__ecrypteesQaReloadMarker !== 'guarded-cleanup' && document.readyState === 'complete' && !document.getElementById('comicFiles').disabled", 45000);
if (!await evaluate(artifactExistsExpression(cleanupFixture.oldName))
        || !await evaluate(artifactExistsExpression(cleanupFixture.recentName))) {
    throw new Error('Aggressive cleanup deleted an orphan while invalid metadata made ownership uncertain');
}
await evaluate(`(async () => {
    const request = indexedDB.open('ecryptees-library-v1', 1);
    const database = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const transaction = database.transaction('books', 'readwrite');
    transaction.objectStore('books').delete(${JSON.stringify(cleanupFixture.invalidBookId)});
    await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
})()`);
await evaluate("globalThis.__ecrypteesQaReloadMarker = 'orphan-cleanup'");
await send('Page.reload', { ignoreCache: true });
await waitFor("globalThis.__ecrypteesQaReloadMarker !== 'orphan-cleanup' && document.readyState === 'complete' && !document.getElementById('comicFiles').disabled", 45000);
if (await evaluate(artifactExistsExpression(cleanupFixture.oldName))) {
    throw new Error('Aggressive cleanup did not reclaim an unreferenced generation older than seven days');
}
if (!await evaluate(artifactExistsExpression(cleanupFixture.recentName))) {
    throw new Error('Aggressive cleanup deleted a recent unreferenced generation inside the grace period');
}

const mediaFixture = await evaluate(`(async () => {
    const source = await (await fetch('assets/background.jpg')).blob();
    const image = await EcrypteesImageAssets.saveImageAsset({
        blob: source,
        fileName: 'upgrade-image.jpg',
        mime: 'image/jpeg',
        width: 864,
        height: 1920
    });
    const bytes = new Uint8Array(4096);
    bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x32]);
    const assetId = EcrypteesVideoAssets.createId();
    const opfsName = EcrypteesVideoAssets.assetFileName(assetId);
    const storageRoot = await navigator.storage.getDirectory();
    const writable = await (await storageRoot.getFileHandle(opfsName, { create: true })).createWritable();
    await writable.write(bytes);
    await writable.close();
    const video = await EcrypteesVideoAssets.saveVideoAsset({
        assetId,
        opfsName,
        title: '升级保留视频',
        fileName: 'upgrade-video.mp4',
        originalName: 'upgrade-video.mp4',
        fileSize: bytes.length,
        createdAt: 1700000000000
    });
    return { imageId: image.assetId, videoId: video.assetId, opfsName };
})()`);
await evaluate("globalThis.__ecrypteesQaReloadMarker = 'media-persistence'");
await send('Page.reload', { ignoreCache: true });
await waitFor("globalThis.__ecrypteesQaReloadMarker !== 'media-persistence' && document.readyState === 'complete' && !document.getElementById('comicFiles').disabled", 45000);
const mediaAfterReload = await evaluate(`(async () => ({
    images: (await EcrypteesImageAssets.listImageAssets()).assets.length,
    videos: (await EcrypteesVideoAssets.listVideoAssets()).assets.length
}))()`);
if (mediaAfterReload.images !== 1 || mediaAfterReload.videos !== 1) {
    throw new Error(`Image/video assets did not survive reload: ${JSON.stringify(mediaAfterReload)}`);
}
await evaluate(`(async () => {
    const request = indexedDB.open('ecryptees-video-assets-v1', 3);
    const database = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const transaction = database.transaction('assets', 'readwrite');
    transaction.objectStore('assets').delete(${JSON.stringify(mediaFixture.videoId)});
    await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
})()`);
const recoveredVideo = await evaluate(`(async () => {
    const state = await EcrypteesVideoAssets.auditVideoAssets();
    return {
        count: state.assets.length,
        recoveredIds: state.recoveredIds || [],
        title: state.assets[0]?.title || '',
        fileExists: await (async () => {
            try {
                await (await navigator.storage.getDirectory()).getFileHandle(${JSON.stringify(mediaFixture.opfsName)});
                return true;
            } catch (error) {
                return false;
            }
        })()
    };
})()`);
if (recoveredVideo.count !== 1 || recoveredVideo.title !== '升级保留视频' || !recoveredVideo.fileExists
        || !recoveredVideo.recoveredIds.includes(mediaFixture.videoId)) {
    throw new Error(`Video index was not recovered from its preserved original file: ${JSON.stringify(recoveredVideo)}`);
}

await evaluate("document.getElementById('historyTab').click(); document.getElementById('assetTypeComicButton').click()");
await waitFor("document.querySelectorAll('.history-card').length === 4", 30000);
await evaluate("scrollTo(0, document.getElementById('historyPanel').offsetTop)");
await new Promise(resolve => setTimeout(resolve, 250));
const shelf = await capture('comic-shelf');

const touchPoint = await evaluate(`(() => {
    globalThis.__ecrypteesQaContextMenus = 0;
    document.getElementById('historyGrid').addEventListener('contextmenu', () => {
        globalThis.__ecrypteesQaContextMenus += 1;
    }, { capture: true });
    const box = document.querySelector('.history-card-open').getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + Math.min(80, box.height / 3) };
})()`);
await send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: touchPoint.x, y: touchPoint.y, radiusX: 1, radiusY: 1, force: 1 }]
});
await new Promise(resolve => setTimeout(resolve, 600));
await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await new Promise(resolve => setTimeout(resolve, 100));
const nativeLongPress = await evaluate(`({
    selected: !document.getElementById('historySelectionBar').hidden,
    contextMenus: globalThis.__ecrypteesQaContextMenus
})`);
if (!nativeLongPress.selected) {
    throw new Error(`Native touch long press did not enter selection mode; contextMenus=${nativeLongPress.contextMenus}`);
}
await evaluate("document.getElementById('historySelectionCancelButton').click()");

await evaluate(`(async () => {
    const card = document.querySelector('.history-card');
    const box = card.getBoundingClientRect();
    const start = { bubbles: true, pointerId: 5, isPrimary: true, button: 0, clientX: box.left + 20, clientY: box.top + 20 };
    card.dispatchEvent(new PointerEvent('pointerdown', start));
    card.dispatchEvent(new PointerEvent('pointermove', { ...start, clientX: start.clientX + 8, clientY: start.clientY + 8 }));
    await new Promise(resolve => setTimeout(resolve, 520));
    document.querySelector('.history-card').dispatchEvent(new PointerEvent('pointerup', start));
})()`);
if (await evaluate("!document.getElementById('historySelectionBar').hidden")) {
    throw new Error('A pointer move beyond 10px incorrectly entered selection mode');
}

await evaluate(`(async () => {
    const card = document.querySelector('.history-card');
    const box = card.getBoundingClientRect();
    const start = { bubbles: true, pointerId: 6, isPrimary: true, button: 0, clientX: box.left + 20, clientY: box.top + 20 };
    card.dispatchEvent(new PointerEvent('pointerdown', start));
    card.dispatchEvent(new PointerEvent('pointercancel', start));
    await new Promise(resolve => setTimeout(resolve, 520));
})()`);
if (await evaluate("!document.getElementById('historySelectionBar').hidden")) {
    throw new Error('pointercancel incorrectly entered selection mode');
}

await evaluate(`(async () => {
    const card = document.querySelector('.history-card');
    const box = card.getBoundingClientRect();
    const init = { bubbles: true, pointerId: 7, isPrimary: true, button: 0, clientX: box.left + 20, clientY: box.top + 20 };
    card.dispatchEvent(new PointerEvent('pointerdown', init));
    card.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: init.clientX + 10 }));
    await new Promise(resolve => setTimeout(resolve, 520));
    const currentCard = document.querySelector('.history-card');
    currentCard.dispatchEvent(new PointerEvent('pointerup', init));
    currentCard.click();
})()`);
await waitFor("!document.getElementById('historySelectionBar').hidden && document.getElementById('historySelectionCount').textContent === '已选 1 本'");
await evaluate("document.querySelector('.history-card').click()");
await waitFor("document.getElementById('historySelectionCount').textContent === '已选 0 本'");
await evaluate("document.querySelector('.history-card').click()");
await waitFor("document.getElementById('historySelectionCount').textContent === '已选 1 本'");
await evaluate("document.getElementById('historySelectionAllButton').click()");
await waitFor("document.getElementById('historySelectionCount').textContent === '已选 4 本'");
await waitFor("Array.from(document.querySelectorAll('.history-cover')).every(image => image.complete && image.naturalWidth > 0)");
const selection = await capture('comic-selection');
await evaluate("document.getElementById('historySelectionCancelButton').click(); document.querySelector('.history-menu-button').click()");
await waitFor("document.getElementById('historyBookMenuDialog').open && !document.getElementById('historyBookMenuView').hidden");
const actionSheet = await capture('comic-action-sheet');
await evaluate("document.getElementById('historyMenuEditButton').click()");
await waitFor("document.getElementById('comicEditorDialog').open && document.querySelectorAll('.comic-editor-page-row').length === 4");
const editorSnapshotBefore = await evaluate(`(async () => {
    const id = document.querySelector('.history-card').dataset.bookId;
    const request = indexedDB.open('ecryptees-library-v1', 1);
    const database = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const recordRequest = database.transaction('books', 'readonly').objectStore('books').get(id);
    const record = await new Promise((resolve, reject) => { recordRequest.onsuccess = () => resolve(recordRequest.result); recordRequest.onerror = () => reject(recordRequest.error); });
    return { updatedAt: record.updatedAt, pages: record.pages.map(page => page.entryName) };
})()`);
await waitFor("Array.from(document.querySelectorAll('.comic-editor-page-thumb')).every(image => image.tagName !== 'IMG' || (image.complete && image.naturalWidth > 0))");
const editor = await capture('comic-editor');
await evaluate(`(async () => {
    const source = await (await fetch('assets/background.jpg')).blob();
    const transfer = new DataTransfer();
    transfer.items.add(new File([source], 'local-added-1.jpg', { type: 'image/jpeg' }));
    transfer.items.add(new File([source], 'local-added-2.jpg', { type: 'image/jpeg' }));
    const input = document.getElementById('comicEditorLocalFiles');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await waitFor("document.querySelectorAll('.comic-editor-page-row').length === 6 && document.querySelectorAll('.comic-editor-added-badge').length === 2");
await evaluate("document.querySelectorAll('.comic-editor-page-delete')[1].click()");
const editorChanged = await capture('comic-editor-changed');
await evaluate("document.getElementById('comicEditorSaveChangesButton').click()");
await waitFor("!document.getElementById('comicEditorSaveConfirm').hidden");
const editorConfirm = await capture('comic-editor-confirm');
await evaluate("document.getElementById('comicEditorConfirmButton').click()");
await waitFor("!document.getElementById('comicEditorDialog').open");
const editorSnapshotAfter = await evaluate(`(async () => {
    const id = document.querySelector('.history-card').dataset.bookId;
    const request = indexedDB.open('ecryptees-library-v1', 1);
    const database = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const recordRequest = database.transaction('books', 'readonly').objectStore('books').get(id);
    const record = await new Promise((resolve, reject) => { recordRequest.onsuccess = () => resolve(recordRequest.result); recordRequest.onerror = () => reject(recordRequest.error); });
    return { updatedAt: record.updatedAt, pages: record.pages.map(page => page.entryName) };
})()`);
if (editorSnapshotAfter.updatedAt <= editorSnapshotBefore.updatedAt
        || editorSnapshotAfter.pages.length !== 5
        || editorSnapshotAfter.pages.some(page => editorSnapshotBefore.pages.includes(page))) {
    throw new Error(`Atomic editor commit failed: before=${JSON.stringify(editorSnapshotBefore)} after=${JSON.stringify(editorSnapshotAfter)}`);
}

await evaluate(`(async () => {
    document.getElementById('historyTab').click();
    document.getElementById('assetTypeComicButton').click();
    const card = document.querySelector('.history-card');
    const box = card.getBoundingClientRect();
    const init = { bubbles: true, pointerId: 18, isPrimary: true, button: 0, clientX: box.left + 20, clientY: box.top + 20 };
    card.dispatchEvent(new PointerEvent('pointerdown', init));
    await new Promise(resolve => setTimeout(resolve, 520));
    card.dispatchEvent(new PointerEvent('pointerup', init));
})()`);
await waitFor("!document.getElementById('historySelectionBar').hidden");
await evaluate(`(() => {
    document.getElementById('historySelectionAllButton').click();
    const originalClick = HTMLAnchorElement.prototype.click;
    globalThis.__ecrypteesQaAnchorClick = originalClick;
    HTMLAnchorElement.prototype.click = function () {
        globalThis.__ecrypteesQaBundleLink = { href: this.href, download: this.download };
    };
    document.getElementById('historyBundleExportButton').click();
})()`);
await waitFor("globalThis.__ecrypteesQaBundleLink && document.getElementById('historyStatus').textContent.includes('已生成')", 60000);
const bundleMeta = await evaluate(`(async () => {
    const response = await fetch(globalThis.__ecrypteesQaBundleLink.href);
    globalThis.__ecrypteesQaBundleBlob = await response.blob();
    HTMLAnchorElement.prototype.click = globalThis.__ecrypteesQaAnchorClick;
    return { size: globalThis.__ecrypteesQaBundleBlob.size, name: globalThis.__ecrypteesQaBundleLink.download };
})()`);
if (!bundleMeta.size || !/\.zip$/i.test(bundleMeta.name)) {
    throw new Error(`Bundle export did not produce a ZIP: ${JSON.stringify(bundleMeta)}`);
}

await evaluate(`(() => {
    document.getElementById('comicTab').click();
    document.getElementById('archiveComicSourceButton').click();
    const transfer = new DataTransfer();
    transfer.items.add(new File([globalThis.__ecrypteesQaBundleBlob], '漫画备份包.ZIP', { type: 'application/zip' }));
    const input = document.getElementById('comicArchiveFile');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    scrollTo(0, document.getElementById('archiveComicSourcePanel').offsetTop);
})()`);
await waitFor("!document.getElementById('comicBundleImportSummary').hidden");
if (!await evaluate("document.getElementById('openComicButton').disabled")) {
    throw new Error('ZIP bundle incorrectly enabled single-archive decoding');
}
const zipImport = await capture('comic-zip-import');
await evaluate("document.getElementById('comicBundleImportButton').click()");
await waitFor("document.getElementById('comicBundleImportState').textContent.includes('导入完成') || document.getElementById('comicBundleImportState').textContent.includes('全部导入完成') || document.getElementById('comicBundleImportState').textContent.includes('导入失败')", 90000);
const bundleImportCounts = await evaluate(`({
    success: Number(document.getElementById('comicBundleSuccessCount').textContent),
    replaced: Number(document.getElementById('comicBundleReplaceCount').textContent),
    skipped: Number(document.getElementById('comicBundleSkippedCount').textContent),
    failed: Number(document.getElementById('comicBundleFailedCount').textContent),
    state: document.getElementById('comicBundleImportState').textContent
})`);
if (bundleImportCounts.success !== 4 || bundleImportCounts.replaced !== 4 || bundleImportCounts.failed !== 0) {
    throw new Error(`Bundle round trip failed: ${JSON.stringify(bundleImportCounts)}`);
}
await evaluate(`(async () => {
    const bytes = new Uint8Array(await globalThis.__ecrypteesQaBundleBlob.arrayBuffer());
    bytes[100] ^= 0x01;
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], '漫画备份包-单本损坏.zip', { type: 'application/zip' }));
    const input = document.getElementById('comicArchiveFile');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await waitFor("!document.getElementById('comicBundleImportButton').disabled");
await evaluate("document.getElementById('comicBundleImportButton').click()");
await waitFor("document.getElementById('comicBundleImportState').textContent.includes('导入完成')", 90000);
const damagedBundleCounts = await evaluate(`({
    success: Number(document.getElementById('comicBundleSuccessCount').textContent),
    failed: Number(document.getElementById('comicBundleFailedCount').textContent),
    failures: document.getElementById('comicBundleFailureList').children.length
})`);
if (damagedBundleCounts.success !== 3 || damagedBundleCounts.failed !== 1 || damagedBundleCounts.failures !== 1) {
    throw new Error(`Damaged bundle did not continue past one failed book: ${JSON.stringify(damagedBundleCounts)}`);
}
const mobileLayout = await evaluate(`({
    bodyWidth: document.body.scrollWidth,
    viewportWidth: innerWidth
})`);

await send('Emulation.setDeviceMetricsOverride', {
    width: 1024,
    height: 768,
    deviceScaleFactor: 1,
    mobile: false,
    screenOrientation: { type: 'landscapePrimary', angle: 90 }
});
await evaluate("document.getElementById('historyTab').click(); document.getElementById('assetTypeComicButton').click(); scrollTo(0, document.getElementById('historyPanel').offsetTop)");
await waitFor("document.querySelectorAll('.history-card').length === 4 && innerWidth === 1024");
await new Promise(resolve => setTimeout(resolve, 250));
const desktopShelf = await capture('comic-shelf-desktop');
const desktopLayout = await evaluate(`({
    bodyWidth: document.body.scrollWidth,
    viewportWidth: innerWidth,
    cardCount: document.querySelectorAll('.history-card').length
})`);

const result = await evaluate(`({
    cards: document.querySelectorAll('.history-card').length,
    selectionHidden: document.getElementById('historySelectionBar').hidden,
    editorRows: document.querySelectorAll('.comic-editor-page-row').length,
    bundlePreview: !document.getElementById('comicBundleImportSummary').hidden,
    bodyWidth: ${JSON.stringify(null)},
    viewportWidth: ${JSON.stringify(null)},
    desktopLayout: ${JSON.stringify(null)}
})`);
result.bodyWidth = mobileLayout.bodyWidth;
result.viewportWidth = mobileLayout.viewportWidth;
result.desktopLayout = desktopLayout;
const report = {
    result,
    screenshots: { shelf, selection, actionSheet, editor, editorChanged, editorConfirm, zipImport, desktopShelf },
    exceptions,
    consoleErrors
};
if (exceptions.length) throw new Error(`Browser exceptions: ${exceptions.join('; ')}`);
if (consoleErrors.length) throw new Error(`Browser console errors: ${consoleErrors.join('; ')}`);
if (result.cards !== 4 || result.bodyWidth > result.viewportWidth
        || result.desktopLayout.cardCount !== 4
        || result.desktopLayout.bodyWidth > result.desktopLayout.viewportWidth) {
    throw new Error(`Browser layout assertion failed: ${JSON.stringify(result)}`);
}
console.log(JSON.stringify(report, null, 2));
} finally {
    socket?.close();
    if (edgeProcess.exitCode === null) {
        edgeProcess.kill();
        await Promise.race([
            new Promise(resolve => edgeProcess.once('exit', resolve)),
            new Promise(resolve => setTimeout(resolve, 5000))
        ]);
    }
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profileDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
}

await main();
