import fs from 'node:fs';

const endpoint = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222';
const screenshotPath = process.argv[2] || '';
const pages = await (await fetch(`${endpoint}/json/list`)).json();
const page = pages.find(item => item.type === 'page' && item.url.includes('127.0.0.1:8000'));
if (!page) throw new Error('Ecryptees browser page was not found');

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
});

let sequence = 0;
const pending = new Map();
const exceptions = [];
socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
        exceptions.push(message.params.exceptionDetails.text);
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

async function waitFor(expression, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for: ${expression}`);
}

await send('Runtime.enable');
await send('Page.enable');
await evaluate("window.__readerDrawerSmokeReloading = true");
await send('Page.reload', { ignoreCache: true });
await waitFor("document.readyState === 'complete' && !window.__readerDrawerSmokeReloading && document.body.dataset.lockState === 'unlocked'");
await evaluate(`(() => {
    const dialog = document.getElementById('comicReaderDialog');
    if (!dialog.open) dialog.showModal();
    document.getElementById('openReaderDrawerButton').click();
    return true;
})()`);
await waitFor("document.getElementById('comicReaderDialog').dataset.drawerOpen === 'true'");
await new Promise(resolve => setTimeout(resolve, 500));
await evaluate(`(() => {
    const list = document.getElementById('comicReaderBookList');
    list.replaceChildren();
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'comic-reader-book-button';
    const drag = document.createElement('span');
    drag.className = 'comic-reader-book-drag';
    drag.textContent = '☰';
    const cover = document.createElement('span');
    cover.className = 'comic-reader-book-cover';
    const title = document.createElement('span');
    title.className = 'comic-reader-book-title';
    title.textContent = '这是一个用于验证只有标题文字能够左右滑动的超长漫画标题 · Chapter Twenty Three · 第两百零四话 · '.repeat(5);
    const current = document.createElement('span');
    current.className = 'comic-reader-current-mark';
    current.textContent = '当前';
    row.append(drag, cover, title, current);
    list.append(row);
    return true;
})()`);

const collapsed = await evaluate(`(() => {
    const drawer = document.getElementById('comicReaderDrawer');
    return { width: drawer.getBoundingClientRect().width, dialogWidth: document.getElementById('comicReaderDialog').clientWidth };
})()`);
await evaluate("document.getElementById('toggleReaderDrawerExpandButton').click()");
await waitFor("document.getElementById('comicReaderDialog').dataset.drawerExpanded === 'true'");
await new Promise(resolve => setTimeout(resolve, 300));

const expanded = await evaluate(`(() => {
    const drawer = document.getElementById('comicReaderDrawer');
    const row = document.querySelector('.comic-reader-book-button');
    const title = row.querySelector('.comic-reader-book-title');
    const before = row.getBoundingClientRect().left;
    title.scrollLeft = 180;
    return {
        width: drawer.getBoundingClientRect().width,
        dialogWidth: document.getElementById('comicReaderDialog').clientWidth,
        titleScrollable: title.scrollWidth > title.clientWidth,
        titleScrollLeft: title.scrollLeft,
        rowLeftBefore: before,
        rowLeftAfter: row.getBoundingClientRect().left,
        pressed: document.getElementById('toggleReaderDrawerExpandButton').getAttribute('aria-pressed')
    };
})()`);

if (screenshotPath) {
    const capture = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(screenshotPath, Buffer.from(capture.data, 'base64'));
}

const railRect = await evaluate(`(() => {
    const rect = document.getElementById('readerDrawerExpandRail').getBoundingClientRect();
    return { x: rect.left + rect.width * 0.65, y: rect.top + rect.height / 2 };
})()`);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: railRect.x, y: railRect.y, button: 'left', buttons: 1, clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: railRect.x - 100, y: railRect.y + 2, button: 'left', buttons: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: railRect.x - 100, y: railRect.y + 2, button: 'left', buttons: 0, clickCount: 1 });
await waitFor("document.getElementById('comicReaderDialog').dataset.drawerExpanded === 'false'");

socket.close();
if (exceptions.length) throw new Error(`Browser exceptions: ${exceptions.join('; ')}`);
if (collapsed.width > 370 || expanded.width < expanded.dialogWidth * 0.95
    || !expanded.titleScrollable || expanded.titleScrollLeft <= 0
    || expanded.rowLeftBefore !== expanded.rowLeftAfter || expanded.pressed !== 'true') {
    throw new Error(`Unexpected reader drawer state: ${JSON.stringify({ collapsed, expanded })}`);
}
console.log(JSON.stringify({ collapsed, expanded, swipeCollapsed: true }, null, 2));
