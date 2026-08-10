(function (root) {
    'use strict';

    const core = root.Ecryptees && root.Ecryptees.core;
    const comic = root.Ecryptees && root.Ecryptees.comic;
    const historyCore = root.Ecryptees && root.Ecryptees.history;
    if (!core || !comic || !historyCore) {
        throw new Error('Ecryptees core, comic core, and history core must load before the comic controller.');
    }

    const { format } = comic;
    const { formatBytes, sanitizeDownloadName } = core.utils;
    const androidMedia = root.EcrypteesAndroidMedia;
    const comicFilesInput = document.getElementById('comicFiles');
    const archiveInput = document.getElementById('comicArchiveFile');
    const fileList = document.getElementById('comicFileList');
    const status = document.getElementById('comicStatus');
    const progressGroup = document.getElementById('comicProgressGroup');
    const progress = document.getElementById('comicProgress');
    const progressText = document.getElementById('comicProgressText');
    const reader = document.getElementById('comicReader');
    const readerDialog = document.getElementById('comicReaderDialog');
    const readerNotice = document.getElementById('comicReaderNotice');
    const historyGrid = document.getElementById('historyGrid');
    const historyStatus = document.getElementById('historyStatus');
    const directoryPickerSupported = typeof root.showDirectoryPicker === 'function';
    const DIRECTORY_DATABASE_NAME = 'ecryptees-directory-v1';
    const DIRECTORY_HANDLE_STORE = 'handles';
    const DIRECTORY_HANDLE_KEY = 'library';
    const DIRECTORY_SCHEMA_VERSION = 1;
    const runtimeSupported = !!root.crypto?.subtle
        && !!root.indexedDB
        && typeof root.Ecryptees.LocalComicWorker === 'function';

    let worker = null;
    let items = [];
    let selectedArchive = null;
    let activeJobId = '';
    let activeJobType = '';
    let jobSequence = 0;
    let dragItemId = '';
    let pointerTargetIndex = -1;
    let sessionId = '';
    let readerPages = [];
    let readerCenter = 0;
    let readerObserver = null;
    let readerNoticeTimer = 0;
    let readerReturnFocus = null;
    let autoDownloadLongImage = false;
    let historyBooks = [];
    let browserHistoryBooks = [];
    let directoryBooks = [];
    let libraryDirectoryHandle = null;
    let directoryPermissionGranted = false;
    let pendingArchiveForDirectory = null;
    let openingDirectoryBookId = '';
    let pendingDirectoryExport = false;
    let migrationQueue = [];
    let migrationCurrentBook = null;
    let pendingDirectoryDeletion = null;
    let currentHistoryBookId = '';
    let pendingHistoryStart = false;
    let readerProgressTimer = 0;
    let readerRestoreProgress = null;
    let readerMemoryBytes = 0;
    let pendingHistoryFallback = null;
    let recoveringWorker = false;
    const historyCoverUrls = new Map();
    const directoryMetadataTasks = new Map();
    const pageJobs = new Map();
    const outputState = {
        archive: { url: '', opfsName: '' },
        longImage: { url: '', opfsName: '' }
    };

    function isHeifMime(mime) {
        return mime === 'image/heic' || mime === 'image/heif';
    }

    function nextJobId(prefix) {
        jobSequence += 1;
        return `${prefix}-${Date.now().toString(36)}-${jobSequence}`;
    }

    function setStatus(message, kind = 'info') {
        status.textContent = message;
        status.dataset.kind = kind;
        status.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    }

    function setProgress(processed, total, kind = 'info') {
        const percent = total > 0 ? Math.max(0, Math.min(100, Math.round(processed / total * 100))) : 0;
        progressGroup.hidden = false;
        progressGroup.dataset.kind = kind;
        progress.value = percent;
        progress.setAttribute('aria-valuetext', `${percent}%`);
        progressText.textContent = `${percent}%`;
    }

    function resetProgress() {
        progressGroup.hidden = true;
        progressGroup.dataset.kind = 'info';
        progress.value = 0;
        progressText.textContent = '0%';
    }

    function setBusy(type = '') {
        activeJobType = type;
        const busy = !!type;
        comicFilesInput.disabled = busy || !runtimeSupported;
        archiveInput.disabled = busy || !runtimeSupported;
        document.getElementById('comicArchiveName').disabled = busy || !runtimeSupported;
        document.getElementById('encryptComicButton').disabled = busy || !runtimeSupported || items.length === 0;
        document.getElementById('clearComicFilesButton').disabled = busy || items.length === 0;
        document.getElementById('openComicButton').disabled = busy || !runtimeSupported || !selectedArchive;
        document.getElementById('exportComicLongImageButton').disabled = busy || !sessionId;
        document.getElementById('cancelComicButton').hidden = !busy;
        document.getElementById('clearHistoryButton').disabled = busy || historyBooks.length === 0;
        document.getElementById('historySearch').disabled = busy;
        document.getElementById('historySort').disabled = busy;
        document.getElementById('selectHistoryDirectoryButton').disabled = busy || !directoryPickerSupported;
        document.getElementById('migrateHistoryButton').disabled = busy
            || !directoryPermissionGranted
            || browserHistoryBooks.length === 0;
    }

    function releaseOutput(kind) {
        const output = outputState[kind];
        if (output.url) {
            URL.revokeObjectURL(output.url);
            output.url = '';
        }
        if (worker && output.opfsName) {
            worker.postMessage({ type: 'releaseOutput', jobId: nextJobId('release'), payload: { opfsName: output.opfsName } });
            output.opfsName = '';
        }
    }

    function showDownload(kind, message) {
        releaseOutput(kind);
        const output = outputState[kind];
        const outputBlob = new Blob([message.file], {
            type: kind === 'archive' ? 'application/octet-stream' : 'image/png'
        });
        output.url = URL.createObjectURL(outputBlob);
        output.opfsName = message.opfsName;
        if (message.storageKind === 'indexeddb' && output.opfsName) {
            worker.postMessage({
                type: 'releaseOutput',
                jobId: nextJobId('release'),
                payload: { opfsName: output.opfsName }
            });
            output.opfsName = '';
        }
        const link = kind === 'archive'
            ? document.getElementById('downloadComicArchive')
            : document.getElementById('downloadComicLongImage');
        link.href = output.url;
        link.download = sanitizeDownloadName(message.name, kind === 'archive' ? format.EXTENSION : 'png');
        link.setAttribute('aria-disabled', 'false');
        link.hidden = false;
        if (kind === 'archive') {
            document.getElementById('comicArchiveDownloadRow').hidden = false;
        }
    }

    function setHistoryStatus(message, kind = 'info') {
        historyStatus.textContent = message;
        historyStatus.dataset.kind = kind;
        historyStatus.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    }

    function requestToPromise(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('独立书架设置读取失败'));
        });
    }

    async function openDirectoryDatabase() {
        const request = indexedDB.open(DIRECTORY_DATABASE_NAME, 1);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(DIRECTORY_HANDLE_STORE)) {
                request.result.createObjectStore(DIRECTORY_HANDLE_STORE);
            }
        };
        return requestToPromise(request);
    }

    async function rememberDirectoryHandle(handle) {
        const database = await openDirectoryDatabase();
        try {
            const transaction = database.transaction(DIRECTORY_HANDLE_STORE, 'readwrite');
            transaction.objectStore(DIRECTORY_HANDLE_STORE).put(handle, DIRECTORY_HANDLE_KEY);
            await new Promise((resolve, reject) => {
                transaction.oncomplete = resolve;
                transaction.onerror = () => reject(transaction.error || new Error('无法保存书架目录授权'));
                transaction.onabort = () => reject(transaction.error || new Error('书架目录授权保存已取消'));
            });
        } finally {
            database.close();
        }
    }

    async function readRememberedDirectoryHandle() {
        const database = await openDirectoryDatabase();
        try {
            const transaction = database.transaction(DIRECTORY_HANDLE_STORE, 'readonly');
            return await requestToPromise(transaction.objectStore(DIRECTORY_HANDLE_STORE).get(DIRECTORY_HANDLE_KEY));
        } finally {
            database.close();
        }
    }

    function setDirectorySummary(message, kind = 'info') {
        const summary = document.getElementById('historyDirectorySummary');
        summary.textContent = message;
        summary.dataset.kind = kind;
    }

    async function writeDirectoryFile(directory, name, value) {
        const handle = await directory.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        try {
            await writable.write(value);
            await writable.close();
        } catch (error) {
            await writable.abort();
            throw error;
        }
    }

    async function readJsonFile(directory, name) {
        const handle = await directory.getFileHandle(name);
        const file = await handle.getFile();
        return JSON.parse(await file.text());
    }

    async function getDirectoryBookFolder(bookId, create = false) {
        if (!libraryDirectoryHandle || !directoryPermissionGranted) {
            return null;
        }
        const books = await libraryDirectoryHandle.getDirectoryHandle('books', { create });
        return books.getDirectoryHandle(bookId, { create });
    }

    function mergeHistorySources() {
        const merged = new Map(browserHistoryBooks.map(book => [book.bookId, { ...book, directoryOnly: false }]));
        for (const directoryBook of directoryBooks) {
            const cached = merged.get(directoryBook.bookId);
            merged.set(directoryBook.bookId, cached
                ? {
                    ...cached,
                    ...directoryBook,
                    coverFile: directoryBook.coverFile || cached.coverFile,
                    directoryOnly: false
                }
                : { ...directoryBook, directoryOnly: true });
        }
        historyBooks = Array.from(merged.values());
        renderHistory();
    }

    async function scanLibraryDirectory() {
        if (!libraryDirectoryHandle || !directoryPermissionGranted) {
            directoryBooks = [];
            mergeHistorySources();
            return;
        }
        const booksDirectory = await libraryDirectoryHandle.getDirectoryHandle('books', { create: true });
        const scanned = [];
        for await (const [bookId, handle] of booksDirectory.entries()) {
            if (handle.kind !== 'directory' || !/^[0-9a-f]{32}$/.test(bookId)) {
                continue;
            }
            try {
                const metadata = await readJsonFile(handle, 'metadata.json');
                if (metadata.schemaVersion !== DIRECTORY_SCHEMA_VERSION || metadata.bookId !== bookId) {
                    continue;
                }
                const archiveFile = await (await handle.getFileHandle('archive.ecomic')).getFile();
                let coverFile = null;
                let longFile = null;
                try {
                    coverFile = await (await handle.getFileHandle('cover.jpg')).getFile();
                } catch (error) {
                    coverFile = null;
                }
                try {
                    longFile = await (await handle.getFileHandle('long.png')).getFile();
                } catch (error) {
                    longFile = null;
                }
                const pageCount = Math.max(1, Math.min(format.MAX_PAGES, Math.trunc(Number(metadata.pageCount) || 1)));
                scanned.push({
                    bookId,
                    title: historyCore.normalizeTitle(metadata.title),
                    pageCount,
                    totalSize: Math.max(1, Math.trunc(Number(metadata.totalSize) || archiveFile.size)),
                    progress: historyCore.normalizeProgress(metadata.progress, pageCount),
                    png: {
                        name: 'long.png',
                        width: Math.max(1, Math.trunc(Number(metadata.png?.width) || 1)),
                        height: Math.max(1, Math.trunc(Number(metadata.png?.height) || 1)),
                        size: longFile?.size || Math.max(0, Math.trunc(Number(metadata.png?.size) || 0)),
                        generatedAt: Math.max(0, Math.trunc(Number(metadata.png?.generatedAt) || 0))
                    },
                    coverMime: coverFile ? 'image/jpeg' : '',
                    coverFile,
                    archiveFile,
                    longFile,
                    createdAt: Math.max(0, Math.trunc(Number(metadata.createdAt) || archiveFile.lastModified)),
                    updatedAt: Math.max(0, Math.trunc(Number(metadata.updatedAt) || archiveFile.lastModified)),
                    lastOpenedAt: Math.max(0, Math.trunc(Number(metadata.lastOpenedAt) || 0))
                });
            } catch (error) {
                // Ignore incomplete book folders. A later migration or save can repair them.
            }
        }
        directoryBooks = scanned;
        setDirectorySummary(`已连接“${libraryDirectoryHandle.name}” · ${scanned.length} 本漫画`, 'success');
        mergeHistorySources();
    }

    function createDirectoryMetadata(book, existing = {}) {
        const pageCount = Math.max(1, Math.trunc(Number(book.pageCount) || 1));
        return {
            schemaVersion: DIRECTORY_SCHEMA_VERSION,
            bookId: book.bookId,
            title: historyCore.normalizeTitle(book.title),
            pageCount,
            totalSize: Math.max(1, Math.trunc(Number(book.totalSize) || 1)),
            progress: historyCore.normalizeProgress(book.progress, pageCount),
            png: book.png || existing.png || { name: 'long.png', width: 1, height: 1, size: 0, generatedAt: 0 },
            createdAt: Math.max(0, Math.trunc(Number(book.createdAt) || Number(existing.createdAt) || Date.now())),
            updatedAt: Date.now(),
            lastOpenedAt: Math.max(0, Math.trunc(Number(book.lastOpenedAt) || Number(existing.lastOpenedAt) || 0))
        };
    }

    async function syncBookToDirectory(book, files = {}, refresh = true) {
        if (!book || !libraryDirectoryHandle || !directoryPermissionGranted) {
            return false;
        }
        const folder = await getDirectoryBookFolder(book.bookId, true);
        let existing = {};
        try {
            existing = await readJsonFile(folder, 'metadata.json');
        } catch (error) {
            existing = {};
        }
        const archiveFile = files.archiveFile || book.archiveFile;
        const longFile = files.longFile || book.longFile;
        const coverFile = files.coverFile || book.coverFile;
        if (archiveFile) {
            await writeDirectoryFile(folder, 'archive.ecomic', archiveFile);
        } else {
            try {
                await folder.getFileHandle('archive.ecomic');
            } catch (error) {
                throw new Error('独立书架缺少可保存的 .ecomic 归档');
            }
        }
        if (longFile) {
            await writeDirectoryFile(folder, 'long.png', longFile);
        }
        if (coverFile) {
            await writeDirectoryFile(folder, 'cover.jpg', coverFile);
        }
        const metadata = createDirectoryMetadata(book, existing);
        await writeDirectoryFile(folder, 'metadata.json', new Blob([
            JSON.stringify(metadata, null, 2)
        ], { type: 'application/json' }));
        if (refresh) {
            await scanLibraryDirectory();
        }
        return true;
    }

    function updateDirectoryMetadata(book) {
        const directoryBook = directoryBooks.find(item => item.bookId === book?.bookId);
        if (!book || !directoryBook) {
            return Promise.resolve(false);
        }
        const previousTask = directoryMetadataTasks.get(book.bookId) || Promise.resolve();
        const task = previousTask.catch(() => {}).then(async () => {
            const folder = await getDirectoryBookFolder(book.bookId);
            const metadata = createDirectoryMetadata({ ...directoryBook, ...book }, directoryBook);
            await writeDirectoryFile(folder, 'metadata.json', new Blob([
                JSON.stringify(metadata, null, 2)
            ], { type: 'application/json' }));
            Object.assign(directoryBook, {
                ...metadata,
                archiveFile: directoryBook.archiveFile,
                longFile: directoryBook.longFile,
                coverFile: directoryBook.coverFile
            });
            return true;
        });
        directoryMetadataTasks.set(book.bookId, task);
        return task.finally(() => {
            if (directoryMetadataTasks.get(book.bookId) === task) {
                directoryMetadataTasks.delete(book.bookId);
            }
        });
    }

    async function connectLibraryDirectory() {
        if (!directoryPickerSupported || activeJobType) {
            return;
        }
        try {
            const handle = await root.showDirectoryPicker({ id: 'ecryptees-library', mode: 'readwrite' });
            const permission = await handle.requestPermission({ mode: 'readwrite' });
            if (permission !== 'granted') {
                throw new Error('未获得书架目录读写权限');
            }
            libraryDirectoryHandle = handle;
            directoryPermissionGranted = true;
            await rememberDirectoryHandle(handle);
            await scanLibraryDirectory();
            setHistoryStatus('独立书架目录已连接。以后生成的漫画会自动写入该目录。', 'success');
        } catch (error) {
            if (error?.name !== 'AbortError') {
                setDirectorySummary(error.message || '无法连接独立书架目录', 'error');
            }
        }
        setBusy(activeJobType);
    }

    async function restoreLibraryDirectory() {
        if (!directoryPickerSupported) {
            setDirectorySummary('当前浏览器不支持直接写入普通目录；继续使用浏览器书架和文件下载。', 'error');
            return;
        }
        try {
            const handle = await readRememberedDirectoryHandle();
            if (!handle) {
                return;
            }
            libraryDirectoryHandle = handle;
            const permission = await handle.queryPermission({ mode: 'readwrite' });
            directoryPermissionGranted = permission === 'granted';
            if (directoryPermissionGranted) {
                await scanLibraryDirectory();
            } else {
                setDirectorySummary(`需要重新授权“${handle.name}”，请点击“选择书架目录”`, 'info');
            }
        } catch (error) {
            setDirectorySummary('原书架目录已不可用，请重新选择。', 'error');
        }
        setBusy(activeJobType);
    }

    async function deleteDirectoryBook(bookId) {
        if (!libraryDirectoryHandle || !directoryPermissionGranted) {
            return;
        }
        await (directoryMetadataTasks.get(bookId) || Promise.resolve()).catch(() => {});
        const books = await libraryDirectoryHandle.getDirectoryHandle('books', { create: true });
        try {
            await books.removeEntry(bookId, { recursive: true });
        } catch (error) {
            if (error?.name !== 'NotFoundError') {
                throw error;
            }
        }
        await scanLibraryDirectory();
    }

    async function deleteAllDirectoryBooks() {
        if (!libraryDirectoryHandle || !directoryPermissionGranted) {
            return;
        }
        await Promise.all(Array.from(directoryMetadataTasks.values(), task => task.catch(() => {})));
        const books = await libraryDirectoryHandle.getDirectoryHandle('books', { create: true });
        for (const book of directoryBooks.slice()) {
            try {
                await books.removeEntry(book.bookId, { recursive: true });
            } catch (error) {
                if (error?.name !== 'NotFoundError') {
                    throw error;
                }
            }
        }
        await scanLibraryDirectory();
    }

    function releaseHistoryCovers() {
        historyCoverUrls.forEach(url => URL.revokeObjectURL(url));
        historyCoverUrls.clear();
    }

    function retireHistoryCovers() {
        const staleUrls = Array.from(historyCoverUrls.values());
        historyCoverUrls.clear();
        if (staleUrls.length) {
            // A rapid shelf refresh can remove an image before Chrome starts its Blob request.
            root.setTimeout(() => {
                staleUrls.forEach(url => URL.revokeObjectURL(url));
            }, 30000);
        }
    }

    function formatHistoryDate(timestamp) {
        if (!timestamp) {
            return '尚未阅读';
        }
        return new Intl.DateTimeFormat('zh-CN', {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        }).format(new Date(timestamp));
    }

    function historyProgressPercent(book) {
        if (!book.pageCount) {
            return 0;
        }
        return Math.max(0, Math.min(100,
            Math.round((book.progress.pageIndex + book.progress.pageRatio) / book.pageCount * 100)));
    }

    function createHistoryButton(label, action, bookId, className = 'secondary-button') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.dataset.historyAction = action;
        button.dataset.bookId = bookId;
        button.textContent = label;
        return button;
    }

    function createHistoryRenameButton(book) {
        const button = createHistoryButton('修改标题', 'rename', book.bookId, 'history-rename');
        button.title = '修改标题';
        button.setAttribute('aria-label', `修改《${book.title}》的标题`);
        button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10.6-10.6a2.1 2.1 0 0 0 0-3L17.6 5.4a2.1 2.1 0 0 0-3 0L4 16v4Zm2-3.2 10-10 1.2 1.2-10 10H6v-1.2Z"/></svg>';
        return button;
    }

    function renderHistory() {
        retireHistoryCovers();
        const query = document.getElementById('historySearch').value.trim().toLocaleLowerCase();
        const sort = document.getElementById('historySort').value;
        const books = historyBooks
            .filter(book => !query || book.title.toLocaleLowerCase().includes(query))
            .slice();
        books.sort((left, right) => {
            if (sort === 'title') {
                return left.title.localeCompare(right.title, 'zh-CN');
            }
            if (sort === 'converted') {
                return right.updatedAt - left.updatedAt;
            }
            return (right.lastOpenedAt || right.updatedAt) - (left.lastOpenedAt || left.updatedAt);
        });
        historyGrid.replaceChildren();
        document.getElementById('historyEmptyState').hidden = historyBooks.length !== 0;
        for (const book of books) {
            const card = document.createElement('article');
            card.className = 'history-card';
            card.dataset.bookId = book.bookId;
            const cover = document.createElement('img');
            cover.className = 'history-cover';
            cover.alt = `${book.title} 封面`;
            if (book.coverFile) {
                const url = URL.createObjectURL(new Blob([book.coverFile], { type: book.coverMime || 'image/jpeg' }));
                historyCoverUrls.set(book.bookId, url);
                cover.src = url;
            } else {
                cover.hidden = true;
            }
            const body = document.createElement('div');
            body.className = 'history-card-body';
            const cardHeader = document.createElement('div');
            cardHeader.className = 'history-card-header';
            const title = document.createElement('h3');
            title.className = 'history-card-title';
            title.title = book.title;
            title.textContent = book.title;
            cardHeader.append(title, createHistoryRenameButton(book));
            const percent = historyProgressPercent(book);
            const meta = document.createElement('p');
            meta.className = 'history-card-meta';
            meta.textContent = `${book.pageCount} 页 · ${formatBytes(book.totalSize)} · 已读 ${percent}%${book.archiveFile ? ' · 独立目录' : ''}`;
            const time = document.createElement('p');
            time.className = 'history-card-time';
            time.textContent = `最近：${formatHistoryDate(book.lastOpenedAt || book.updatedAt)}`;
            const track = document.createElement('div');
            track.className = 'history-progress-track';
            const value = document.createElement('span');
            value.className = 'history-progress-value';
            value.style.setProperty('--history-progress', `${percent}%`);
            track.append(value);
            const actions = document.createElement('div');
            actions.className = 'history-card-actions';
            actions.append(
                createHistoryButton('继续阅读', 'open', book.bookId, 'history-open'),
                createHistoryButton('从头阅读', 'restart', book.bookId),
                createHistoryButton('重新生成并下载 PNG', 'download', book.bookId),
                createHistoryButton('删除', 'delete', book.bookId, 'secondary-button history-delete')
            );
            body.append(cardHeader, meta, time, track, actions);
            card.append(cover, body);
            historyGrid.append(card);
        }
        if (historyBooks.length && !books.length) {
            setHistoryStatus('没有符合搜索条件的漫画。');
        } else if (historyStatus.textContent === '没有符合搜索条件的漫画。') {
            setHistoryStatus('');
        }
        setBusy(activeJobType);
    }

    function requestHistoryList() {
        if (!worker) {
            return;
        }
        worker.postMessage({ type: 'historyList', jobId: nextJobId('history-list') });
        worker.postMessage({ type: 'historyStorage', jobId: nextJobId('history-storage') });
    }

    function startNextMigration() {
        if (!migrationQueue.length) {
            migrationCurrentBook = null;
            activeJobId = '';
            setBusy('');
            setHistoryStatus('当前浏览器书架已迁移到独立目录。', 'success');
            scanLibraryDirectory().catch(error => setDirectorySummary(error.message, 'error'));
            return;
        }
        migrationCurrentBook = migrationQueue.shift();
        startJob(
            'historyArchive',
            `正在迁移《${migrationCurrentBook.title}》…`,
            { bookId: migrationCurrentBook.bookId }
        );
    }

    function migrateCurrentShelf() {
        if (!directoryPermissionGranted || activeJobType) {
            return;
        }
        const saved = new Set(directoryBooks.map(book => book.bookId));
        migrationQueue = browserHistoryBooks.filter(book => !saved.has(book.bookId));
        if (!migrationQueue.length) {
            setHistoryStatus('浏览器书架中的漫画已经全部存在于独立目录。', 'success');
            return;
        }
        setHistoryStatus(`准备迁移 ${migrationQueue.length} 本漫画。迁移期间请保持页面打开。`);
        startNextMigration();
    }

    function updateSelectionSummary() {
        const total = items.reduce((sum, item) => sum + item.file.size, 0);
        document.getElementById('comicSelectionSummary').textContent = items.length
            ? `${items.length} 张 · ${formatBytes(total)}`
            : '尚未选择图片';
        document.querySelector('#comicPanel .comic-section')?.toggleAttribute('data-has-files', items.length > 0);
        setBusy(activeJobType);
    }

    function revokeItem(item) {
        if (item && item.url) {
            URL.revokeObjectURL(item.url);
        }
    }

    function updateItemMeta(item) {
        const element = fileList.querySelector(`[data-meta-id="${CSS.escape(item.id)}"]`);
        if (!element) {
            return;
        }
        const dimensions = item.width && item.height ? ` · ${item.width}×${item.height}` : '';
        element.textContent = `${item.format.label} · ${formatBytes(item.file.size)}${dimensions}`;
    }

    function renderFileList() {
        fileList.replaceChildren();
        items.forEach((item, index) => {
            const listItem = document.createElement('li');
            listItem.className = 'comic-file-item';
            listItem.draggable = true;
            listItem.dataset.itemId = item.id;

            const handle = document.createElement('span');
            handle.className = 'comic-drag-handle';
            handle.textContent = '⋮⋮';
            handle.setAttribute('aria-hidden', 'true');
            handle.addEventListener('pointerdown', event => {
                if (activeJobType) {
                    return;
                }
                event.preventDefault();
                dragItemId = item.id;
                pointerTargetIndex = index;
                handle.setPointerCapture(event.pointerId);
                listItem.dataset.dragging = 'true';
            });
            handle.addEventListener('pointermove', event => {
                if (!dragItemId || !handle.hasPointerCapture(event.pointerId)) {
                    return;
                }
                event.preventDefault();
                const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.comic-file-item');
                if (!target) {
                    return;
                }
                const targetIndex = items.findIndex(candidate => candidate.id === target.dataset.itemId);
                if (targetIndex >= 0) {
                    pointerTargetIndex = targetIndex;
                    fileList.querySelectorAll('.comic-file-item').forEach(element => {
                        element.dataset.dropTarget = String(element === target);
                    });
                }
            });
            const finishPointerDrag = event => {
                if (!dragItemId) {
                    return;
                }
                if (handle.hasPointerCapture(event.pointerId)) {
                    handle.releasePointerCapture(event.pointerId);
                }
                const draggedId = dragItemId;
                const targetIndex = pointerTargetIndex;
                dragItemId = '';
                pointerTargetIndex = -1;
                fileList.querySelectorAll('.comic-file-item').forEach(element => {
                    element.dataset.dragging = 'false';
                    element.dataset.dropTarget = 'false';
                });
                moveItemTo(draggedId, targetIndex);
            };
            handle.addEventListener('pointerup', finishPointerDrag);
            handle.addEventListener('pointercancel', finishPointerDrag);

            const image = document.createElement('img');
            image.className = 'comic-thumbnail';
            image.src = item.url;
            image.alt = `第 ${index + 1} 页：${item.file.name}`;
            image.loading = 'lazy';
            image.decoding = 'async';
            image.addEventListener('load', () => {
                if (!item.width || !item.height) {
                    item.width = image.naturalWidth;
                    item.height = image.naturalHeight;
                }
                updateItemMeta(item);
            }, { once: true });

            const info = document.createElement('div');
            info.className = 'comic-file-info';
            const nameRow = document.createElement('span');
            nameRow.className = 'comic-file-name-row';
            const pageIndex = document.createElement('span');
            pageIndex.className = 'comic-file-index';
            pageIndex.textContent = `${index + 1}.`;
            const name = document.createElement('span');
            name.className = 'comic-file-name';
            name.textContent = item.file.name;
            name.title = item.file.name;
            nameRow.append(pageIndex, name);
            const meta = document.createElement('span');
            meta.className = 'comic-file-meta';
            meta.dataset.metaId = item.id;
            info.append(nameRow, meta);

            const actions = document.createElement('div');
            actions.className = 'comic-order-actions';
            const up = document.createElement('button');
            up.className = 'comic-order-button';
            up.type = 'button';
            up.textContent = '↑';
            up.title = '上移';
            up.setAttribute('aria-label', `上移 ${item.file.name}`);
            up.dataset.action = 'up';
            up.dataset.itemId = item.id;
            up.disabled = index === 0 || !!activeJobType;
            const down = document.createElement('button');
            down.className = 'comic-order-button';
            down.type = 'button';
            down.textContent = '↓';
            down.title = '下移';
            down.setAttribute('aria-label', `下移 ${item.file.name}`);
            down.dataset.action = 'down';
            down.dataset.itemId = item.id;
            down.disabled = index === items.length - 1 || !!activeJobType;
            const remove = document.createElement('button');
            remove.className = 'comic-order-button comic-remove-button';
            remove.type = 'button';
            remove.textContent = '删除';
            remove.dataset.action = 'remove';
            remove.dataset.itemId = item.id;
            remove.disabled = !!activeJobType;
            actions.append(up, down, remove);

            listItem.append(handle, image, info, actions);
            listItem.addEventListener('dragstart', event => {
                if (activeJobType) {
                    event.preventDefault();
                    return;
                }
                dragItemId = item.id;
                listItem.dataset.dragging = 'true';
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', item.id);
            });
            listItem.addEventListener('dragend', () => {
                dragItemId = '';
                listItem.dataset.dragging = 'false';
            });
            listItem.addEventListener('dragover', event => {
                if (dragItemId && dragItemId !== item.id) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                }
            });
            listItem.addEventListener('drop', event => {
                event.preventDefault();
                moveItemTo(dragItemId || event.dataTransfer.getData('text/plain'), index);
            });
            fileList.append(listItem);
            updateItemMeta(item);
        });
    }

    function moveItemTo(id, targetIndex) {
        const sourceIndex = items.findIndex(item => item.id === id);
        if (sourceIndex < 0 || sourceIndex === targetIndex || activeJobType) {
            return;
        }
        const [item] = items.splice(sourceIndex, 1);
        items.splice(Math.max(0, Math.min(targetIndex, items.length)), 0, item);
        renderFileList();
        setStatus('页面顺序已更新。');
    }

    function moveItem(id, delta) {
        const index = items.findIndex(item => item.id === id);
        const target = index + delta;
        if (index < 0 || target < 0 || target >= items.length) {
            return;
        }
        const [item] = items.splice(index, 1);
        items.splice(target, 0, item);
        renderFileList();
        setStatus('页面顺序已更新。');
    }

    function removeItem(id) {
        const index = items.findIndex(item => item.id === id);
        if (index < 0) {
            return;
        }
        revokeItem(items[index]);
        items.splice(index, 1);
        renderFileList();
        updateSelectionSummary();
        setStatus(items.length ? '图片已从漫画中移除。' : '列表已清空。');
    }

    function clearItems() {
        items.forEach(revokeItem);
        items = [];
        comicFilesInput.value = '';
        renderFileList();
        updateSelectionSummary();
        setStatus('列表已清空。');
    }

    async function validateSelectedFile(file) {
        if (file.size <= 0) {
            throw new Error(`“${file.name}”为空文件`);
        }
        const prefix = new Uint8Array(await file.slice(0, 64).arrayBuffer());
        const detected = core.image.sniffImageType(prefix);
        if (!detected || !format.SUPPORTED_MIME_TYPES.includes(detected.mime)) {
            throw new Error(`“${file.name}”不是支持的 PNG、JPEG、GIF、WebP、BMP、AVIF、HEIC 或 HEIF`);
        }
        return detected;
    }

    async function prepareComicItem(file, detected) {
        let previewFile = file;
        let width = 0;
        let height = 0;
        if (isHeifMime(detected.mime) && androidMedia?.isHeicSupported()) {
            const decoded = await androidMedia.decodeHeic(file, { name: file.name, maxDimension: 256 });
            previewFile = decoded.file;
            width = decoded.sourceWidth;
            height = decoded.sourceHeight;
        }
        const url = URL.createObjectURL(previewFile);
        if (isHeifMime(detected.mime) && previewFile === file) {
            const probe = new Image();
            probe.src = url;
            try {
                await probe.decode();
                width = probe.naturalWidth;
                height = probe.naturalHeight;
            } catch (error) {
                URL.revokeObjectURL(url);
                throw new Error(`“${file.name}”是 HEIC/HEIF；当前环境无法解码，请使用 Android APK`);
            }
        }
        return {
            id: nextJobId('item'),
            file,
            format: detected,
            url,
            width,
            height
        };
    }

    async function handleFilesSelected() {
        const selected = Array.from(comicFilesInput.files || []);
        const validated = [];
        comicFilesInput.value = '';
        if (selected.length === 0) {
            return;
        }
        try {
            if (items.length + selected.length > format.MAX_PAGES) {
                throw new Error(`漫画最多包含 ${format.MAX_PAGES} 张图片`);
            }
            const currentTotal = items.reduce((sum, item) => sum + item.file.size, 0);
            const addedTotal = selected.reduce((sum, file) => sum + file.size, 0);
            if (currentTotal + addedTotal > format.MAX_TOTAL_BYTES) {
                throw new Error('漫画原图总体积不能超过 500 MiB');
            }

            for (const file of selected) {
                const detected = await validateSelectedFile(file);
                validated.push(await prepareComicItem(file, detected));
            }
            items.push(...validated);
            renderFileList();
            updateSelectionSummary();
            resetProgress();
            setStatus(`已加入 ${selected.length} 张图片，请拖动或使用箭头确认页面顺序。`, 'success');
        } catch (error) {
            validated.forEach(revokeItem);
            setStatus(error.message || '图片导入失败', 'error');
        }
    }

    function startJob(type, message, payload) {
        if (!worker || activeJobType) {
            return;
        }
        activeJobId = nextJobId(type);
        setBusy(type);
        setProgress(0, 1);
        setStatus(message);
        worker.postMessage({ type, jobId: activeJobId, payload });
    }

    function encryptComic() {
        if (items.length === 0) {
            setStatus('请先选择漫画图片', 'error');
            return;
        }
        releaseOutput('archive');
        document.getElementById('comicArchiveDownloadRow').hidden = true;
        const rawName = document.getElementById('comicArchiveName').value.trim() || 'comic';
        const outputName = sanitizeDownloadName(rawName, format.EXTENSION).replace(/\.ecomic$/i, '');
        startJob('encrypt', '正在创建无损漫画归档…', {
            files: items.map(item => item.file),
            outputName
        });
    }

    function handleArchiveSelected() {
        const file = archiveInput.files && archiveInput.files[0];
        if (sessionId) {
            closeReaderSession();
        }
        selectedArchive = null;
        if (!file) {
            setBusy(activeJobType);
            return;
        }
        if (!/\.ecomic$/i.test(file.name)) {
            archiveInput.value = '';
            document.getElementById('comicArchiveMeta').textContent = '文件格式无效';
            setStatus('请选择 .ecomic 漫画归档', 'error');
            setBusy(activeJobType);
            return;
        }
        selectedArchive = file;
        document.getElementById('comicArchiveMeta').textContent = `${file.name} · ${formatBytes(file.size)}`;
        resetProgress();
        setStatus('漫画归档已选择，可以开始解密。');
        setBusy(activeJobType);
    }

    function closeReaderSession(saveProgress = true) {
        if (!saveProgress) {
            currentHistoryBookId = '';
        }
        closeReaderDialog(false);
        if (readerObserver) {
            readerObserver.disconnect();
            readerObserver = null;
        }
        pageJobs.forEach((index, jobId) => {
            worker?.postMessage({ type: 'cancel', jobId });
        });
        pageJobs.clear();
        readerPages.forEach((page, index) => {
            if (page.url) {
                URL.revokeObjectURL(page.url);
            }
            if (sessionId && page.loaded) {
                worker?.postMessage({ type: 'releasePage', jobId: nextJobId('release-page'), payload: { sessionId, index } });
            }
        });
        if (sessionId) {
            worker?.postMessage({ type: 'closeSession', jobId: nextJobId('close-session'), payload: { sessionId } });
        }
        sessionId = '';
        currentHistoryBookId = '';
        readerRestoreProgress = null;
        clearTimeout(readerProgressTimer);
        readerProgressTimer = 0;
        readerMemoryBytes = 0;
        readerPages = [];
        reader.replaceChildren();
        document.getElementById('openComicButton').textContent = '解密、转存并阅读';
        releaseOutput('longImage');
        document.getElementById('downloadComicLongImage').hidden = true;
    }

    function openComic() {
        if (!selectedArchive) {
            setStatus('请先选择 .ecomic 漫画归档', 'error');
            return;
        }
        if (sessionId) {
            openReaderDialog();
            return;
        }
        closeReaderSession();
        startJob('open', '正在验证并打开漫画归档…', { file: selectedArchive });
    }

    function openHistoryBook(bookId, restart = false) {
        if (!bookId || activeJobType) {
            return;
        }
        const book = historyBooks.find(item => item.bookId === bookId);
        if (!book) {
            return;
        }
        closeReaderSession();
        pendingHistoryStart = restart;
        if (book.directoryOnly && book.archiveFile) {
            openingDirectoryBookId = bookId;
            startJob('open', '正在从独立书架目录打开漫画…', { file: book.archiveFile });
            return;
        }
        startJob('historyOpen', '正在从本地书架打开漫画…', { bookId });
    }

    function redownloadHistoryBook(bookId) {
        if (!bookId || activeJobType) {
            return;
        }
        const book = historyBooks.find(item => item.bookId === bookId);
        if (book?.directoryOnly && book.archiveFile) {
            pendingDirectoryExport = true;
            openHistoryBook(bookId, false);
            return;
        }
        autoDownloadLongImage = true;
        releaseOutput('longImage');
        startJob('historyRedownload', '正在从书架重新生成 PNG…', { bookId });
    }

    async function renameHistoryBook(bookId) {
        const book = historyBooks.find(item => item.bookId === bookId);
        if (!book || activeJobType) {
            return;
        }
        const input = root.prompt('修改漫画标题', book.title);
        if (input === null) {
            return;
        }
        const title = input.trim().slice(0, 120);
        if (!title) {
            setHistoryStatus('标题不能为空。', 'error');
            return;
        }
        if (title === book.title) {
            return;
        }
        if (book.directoryOnly) {
            const previousTitle = book.title;
            book.title = title;
            try {
                await updateDirectoryMetadata(book);
                renderHistory();
                setHistoryStatus(`标题已修改为“${title}”。`, 'success');
            } catch (error) {
                book.title = previousTitle;
                setHistoryStatus(error.message || '标题修改失败', 'error');
            }
            return;
        }
        startJob('historyRename', '正在修改漫画标题…', { bookId, title });
    }

    async function requestDeleteHistoryBook(bookId) {
        if (!bookId || activeJobType) {
            return;
        }
        const book = historyBooks.find(item => item.bookId === bookId);
        if (!book) {
            return;
        }
        const cached = browserHistoryBooks.some(item => item.bookId === bookId);
        const external = directoryBooks.some(item => item.bookId === bookId);
        if (!cached && external) {
            if (!root.confirm(`确定删除独立书架目录中的《${book.title}》吗？这会删除其中的 .ecomic、PNG 和封面文件，无法撤销。`)) {
                return;
            }
            try {
                if (currentHistoryBookId === bookId) {
                    closeReaderSession(false);
                }
                await deleteDirectoryBook(bookId);
                setHistoryStatus(`已从独立书架目录删除《${book.title}》。`, 'success');
            } catch (error) {
                setHistoryStatus(`删除失败：${error.message}`, 'error');
            }
            return;
        }
        if (!root.confirm(`确定从浏览器书架移除《${book.title}》吗？`)) {
            return;
        }
        const deleteExternal = external && root.confirm('这本漫画也保存在独立目录中。是否同时删除目录里的原件？\n\n选择“取消”只清理浏览器缓存，独立目录中的漫画仍会显示在书架。');
        pendingDirectoryDeletion = { bookId, deleteExternal };
        startJob('historyDelete', '正在删除漫画…', { bookId });
    }

    async function requestClearHistory() {
        if (!historyBooks.length || activeJobType) {
            return;
        }
        if (!browserHistoryBooks.length) {
            if (!root.confirm('确定删除独立书架目录中的全部漫画吗？其中的 .ecomic、PNG 和封面文件都会被删除，无法撤销。')) {
                return;
            }
            try {
                closeReaderSession(false);
                await deleteAllDirectoryBooks();
                setHistoryStatus('独立书架目录已清空。', 'success');
            } catch (error) {
                setHistoryStatus(`清空失败：${error.message}`, 'error');
            }
            return;
        }
        if (!root.confirm('确定清空当前浏览器中的全部漫画缓存吗？此操作无法撤销。')) {
            return;
        }
        const deleteExternal = directoryBooks.length > 0 && root.confirm('是否同时删除独立书架目录中的全部漫画原件？\n\n选择“取消”只清理浏览器缓存，目录中的漫画仍会显示在书架。');
        pendingDirectoryDeletion = { bookId: '*', deleteExternal };
        startJob('historyDelete', '正在清空漫画书架…', { bookId: '*' });
    }

    function showReaderNotice(message) {
        clearTimeout(readerNoticeTimer);
        readerNotice.textContent = message;
        readerNotice.hidden = false;
        readerNoticeTimer = root.setTimeout(() => {
            readerNotice.hidden = true;
        }, 2600);
    }

    function openReaderDialog() {
        if (!sessionId || readerDialog.open) {
            return;
        }
        readerReturnFocus = document.activeElement;
        document.body.classList.add('comic-reader-open');
        if (typeof readerDialog.showModal === 'function') {
            readerDialog.showModal();
        } else {
            readerDialog.setAttribute('open', '');
        }
        document.getElementById('closeComicReaderButton').focus({ preventScroll: true });
    }

    function closeReaderDialog(restoreFocus = true) {
        saveReaderProgressNow();
        if (readerDialog.open) {
            if (typeof readerDialog.close === 'function') {
                readerDialog.close();
            } else {
                readerDialog.removeAttribute('open');
            }
        }
        document.body.classList.remove('comic-reader-open');
        readerNotice.hidden = true;
        clearTimeout(readerNoticeTimer);
        if (restoreFocus && readerReturnFocus instanceof HTMLElement) {
            readerReturnFocus.focus({ preventScroll: true });
        }
        readerReturnFocus = null;
    }

    function requestReaderPage(index) {
        const page = readerPages[index];
        if (!page || page.loaded || page.pending || !sessionId) {
            return;
        }
        page.pending = true;
        const jobId = nextJobId(`page-${index}`);
        page.jobId = jobId;
        pageJobs.set(jobId, index);
        worker.postMessage({ type: 'page', jobId, payload: { sessionId, index } });
    }

    function getReaderMemoryBudget() {
        const compact = root.matchMedia('(max-width: 600px)').matches
            || (Number(navigator.deviceMemory) > 0 && Number(navigator.deviceMemory) <= 4);
        return compact ? 96 * 1024 * 1024 : 256 * 1024 * 1024;
    }

    function updateReaderWindow(centerIndex) {
        readerCenter = centerIndex;
        const priority = [centerIndex, centerIndex - 1, centerIndex + 1, centerIndex - 2, centerIndex + 2, centerIndex + 3]
            .filter((index, position, all) => index >= 0 && index < readerPages.length && all.indexOf(index) === position);
        let reserved = 0;
        const budget = getReaderMemoryBudget();
        for (const index of priority) {
            const page = readerPages[index];
            const estimate = Math.max(1, Number(page.meta.width) || 1)
                * Math.max(1, Number(page.meta.height) || 1) * 4;
            if (index === centerIndex || reserved + estimate <= budget) {
                reserved += estimate;
                page.lastUsed = Date.now();
                requestReaderPage(index);
            }
        }
    }

    function createReaderPlaceholder(page, index, errorMessage = '') {
        const placeholder = document.createElement('div');
        placeholder.className = 'comic-reader-placeholder';
        if (page.aspectRatio) {
            placeholder.style.aspectRatio = page.aspectRatio;
        }
        placeholder.textContent = errorMessage || `正在准备第 ${index + 1} 页 · ${page.meta.name}`;
        return placeholder;
    }

    function renderReader(message) {
        sessionId = message.sessionId;
        currentHistoryBookId = message.bookId || '';
        readerRestoreProgress = currentHistoryBookId
            ? (pendingHistoryStart ? { pageIndex: 0, pageRatio: 0 } : historyCore.normalizeProgress(message.progress, message.pages.length))
            : { pageIndex: 0, pageRatio: 0 };
        pendingHistoryStart = false;
        readerMemoryBytes = 0;
        readerPages = message.pages.map(meta => ({
            meta,
            url: '',
            loaded: false,
            pending: false,
            jobId: '',
            aspectRatio: meta.width && meta.height ? `${meta.width} / ${meta.height}` : '',
            memoryBytes: 0,
            lastUsed: 0
        }));
        reader.replaceChildren();
        readerPages.forEach((page, index) => {
            const section = document.createElement('figure');
            section.className = 'comic-reader-page';
            section.dataset.readerIndex = String(index);
            section.setAttribute('aria-label', `第 ${index + 1} 页：${page.meta.name}`);
            section.append(createReaderPlaceholder(page, index));
            reader.append(section);
        });
        document.getElementById('comicReaderMeta').textContent = `${message.pages.length} 页 · ${formatBytes(message.totalSize)}`;
        document.getElementById('openComicButton').textContent = '继续阅读';
        reader.scrollTop = 0;
        openReaderDialog();
        readerObserver = new IntersectionObserver(entries => {
            const visible = entries
                .filter(entry => entry.isIntersecting)
                .sort((left, right) => right.intersectionRatio - left.intersectionRatio);
            if (visible.length) {
                updateReaderWindow(Number(visible[0].target.dataset.readerIndex));
            }
        }, { root: reader, rootMargin: '75% 0px', threshold: [0, 0.25, 0.75] });
        reader.querySelectorAll('.comic-reader-page').forEach(page => readerObserver.observe(page));
        const restore = readerRestoreProgress || { pageIndex: 0, pageRatio: 0 };
        const targetIndex = Math.min(readerPages.length - 1, restore.pageIndex);
        requestAnimationFrame(() => {
            const target = reader.querySelector(`[data-reader-index="${targetIndex}"]`);
            if (target) {
                reader.scrollTop = target.offsetTop + target.offsetHeight * restore.pageRatio;
            }
            updateReaderWindow(targetIndex);
        });
    }

    function exportLongImage(automaticDownload = true, saveHistory = true) {
        if (!sessionId) {
            return;
        }
        const link = document.getElementById('downloadComicLongImage');
        if (outputState.longImage.url && link.getAttribute('aria-disabled') === 'false') {
            link.click();
            showReaderNotice('已开始下载整本单文件长图');
            return;
        }
        if (activeJobType) {
            showReaderNotice('当前任务尚未完成，请稍候。');
            return;
        }
        autoDownloadLongImage = automaticDownload;
        releaseOutput('longImage');
        link.hidden = true;
        link.setAttribute('aria-disabled', 'true');
        const historyBook = historyBooks.find(book => book.bookId === currentHistoryBookId);
        const effectiveSaveHistory = historyBook?.directoryOnly ? false : saveHistory;
        const outputName = (historyBook?.title || selectedArchive?.name || 'comic').replace(/\.ecomic$/i, '');
        pendingHistoryFallback = effectiveSaveHistory ? { sessionId, outputName, sourceName: selectedArchive?.name || '' } : null;
        startJob('exportLongImage', '正在生成整本无损长图…', {
            sessionId,
            outputName,
            sourceName: selectedArchive?.name || '',
            saveHistory: effectiveSaveHistory,
            bookId: currentHistoryBookId
        });
        showReaderNotice('正在逐页合并整本漫画，完成后会提供一个 PNG 长图文件。');
    }

    function attachPageDownloadGesture(image, index) {
        let timer = 0;
        let startX = 0;
        let startY = 0;

        const cancelPress = () => {
            clearTimeout(timer);
            timer = 0;
            image.dataset.longPress = 'false';
        };

        image.tabIndex = 0;
        image.title = '长按下载整本长图';
        image.setAttribute('aria-label', `${image.alt}，长按或按回车下载整本长图`);
        image.addEventListener('pointerdown', event => {
            if (event.button !== 0) {
                return;
            }
            startX = event.clientX;
            startY = event.clientY;
            image.dataset.longPress = 'true';
            timer = root.setTimeout(() => {
                timer = 0;
                image.dataset.longPress = 'false';
                exportLongImage(true);
            }, 650);
        });
        image.addEventListener('pointermove', event => {
            if (Math.hypot(event.clientX - startX, event.clientY - startY) > 12) {
                cancelPress();
            }
        });
        image.addEventListener('pointerup', cancelPress);
        image.addEventListener('pointercancel', cancelPress);
        image.addEventListener('pointerleave', cancelPress);
        image.addEventListener('contextmenu', event => {
            event.preventDefault();
        });
        image.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                exportLongImage(true);
            }
        });
    }

    async function showReaderPage(message) {
        const index = Number(message.index);
        const page = readerPages[index];
        pageJobs.delete(message.jobId);
        if (!page || message.sessionId !== sessionId) {
            if (message.sessionId) {
                worker.postMessage({ type: 'releasePage', jobId: nextJobId('release-page'), payload: { sessionId: message.sessionId, index } });
            }
            return;
        }
        page.pending = false;
        page.jobId = '';
        let blob = new Blob([message.file], { type: message.mime });
        if (isHeifMime(message.mime) && androidMedia?.isHeicSupported()) {
            try {
                const decoded = await androidMedia.decodeHeic(blob, { name: message.name || page.meta.name });
                blob = decoded.file;
            } catch (error) {
                const pageElement = reader.querySelector(`[data-reader-index="${index}"]`);
                if (pageElement) {
                    pageElement.replaceChildren(createReaderPlaceholder(page, index, error.message || 'HEIC/HEIF 解码失败'));
                }
                return;
            }
        }
        const pageUrl = URL.createObjectURL(blob);
        const image = document.createElement('img');
        image.src = pageUrl;
        image.alt = `第 ${index + 1} 页：${page.meta.name}`;
        image.decoding = 'async';
        attachPageDownloadGesture(image, index);
        try {
            await image.decode();
        } catch (error) {
            URL.revokeObjectURL(pageUrl);
            const pageElement = reader.querySelector(`[data-reader-index="${index}"]`);
            if (pageElement) {
                pageElement.replaceChildren(createReaderPlaceholder(page, index, '该页无法在浏览器中显示，但仍可无损导出。'));
            }
            return;
        }
        if (message.sessionId !== sessionId) {
            URL.revokeObjectURL(pageUrl);
            return;
        }
        page.url = pageUrl;
        page.loaded = true;
        page.aspectRatio = `${image.naturalWidth} / ${image.naturalHeight}`;
        page.memoryBytes = image.naturalWidth * image.naturalHeight * 4;
        page.lastUsed = Date.now();
        readerMemoryBytes += page.memoryBytes;
        const pageElement = reader.querySelector(`[data-reader-index="${index}"]`);
        if (pageElement) {
            pageElement.replaceChildren(image);
        }
    }

    function getReaderProgress() {
        if (!readerPages.length) {
            return { pageIndex: 0, pageRatio: 0 };
        }
        const top = reader.scrollTop;
        let selected = reader.querySelector(`[data-reader-index="${readerCenter}"]`);
        for (const section of reader.querySelectorAll('.comic-reader-page')) {
            if (section.offsetTop <= top + 2) {
                selected = section;
            } else {
                break;
            }
        }
        const pageIndex = Number(selected?.dataset.readerIndex) || 0;
        const pageRatio = selected?.offsetHeight
            ? Math.max(0, Math.min(1, (top - selected.offsetTop) / selected.offsetHeight))
            : 0;
        return { pageIndex, pageRatio };
    }

    function queueReaderProgressSave() {
        if (!currentHistoryBookId || !worker || !readerDialog.open) {
            return;
        }
        clearTimeout(readerProgressTimer);
        readerProgressTimer = root.setTimeout(saveReaderProgressNow, 500);
    }

    function saveReaderProgressNow() {
        clearTimeout(readerProgressTimer);
        readerProgressTimer = 0;
        if (!currentHistoryBookId || !worker || !readerPages.length) {
            return;
        }
        const bookId = currentHistoryBookId;
        const progressValue = getReaderProgress();
        const book = historyBooks.find(item => item.bookId === bookId);
        if (book) {
            book.progress = progressValue;
            book.lastOpenedAt = Date.now();
            updateDirectoryMetadata(book).catch(error => {
                setDirectorySummary(`阅读进度写入目录失败：${error.message}`, 'error');
            });
        }
        if (browserHistoryBooks.some(item => item.bookId === bookId)) {
            worker.postMessage({
                type: 'historyProgress',
                jobId: nextJobId('history-progress'),
                payload: { bookId, progress: progressValue }
            });
        }
    }

    async function handleWorkerMessage(event) {
        const message = event.data || {};
        if (message.type === 'nativeDecodeRequest') {
            try {
                if (!androidMedia?.isHeicSupported()) {
                    throw new Error('当前环境没有可用的 HEIC/HEIF 解码器');
                }
                const decoded = await androidMedia.decodeHeic(message.file, { name: message.name });
                worker?.postMessage({
                    type: 'nativeDecodeResult',
                    jobId: message.jobId,
                    payload: { requestId: message.requestId, file: decoded.file }
                });
            } catch (error) {
                worker?.postMessage({
                    type: 'nativeDecodeResult',
                    jobId: message.jobId,
                    payload: { requestId: message.requestId, error: error.message || 'HEIC/HEIF 解码失败' }
                });
            }
            return;
        }
        if (message.type === 'history') {
            browserHistoryBooks = Array.isArray(message.books) ? message.books : [];
            mergeHistorySources();
            return;
        }
        if (message.type === 'historyStorage') {
            const used = message.usage ? formatBytes(message.usage) : '未知';
            const quota = message.quota ? formatBytes(message.quota) : '未知';
            const persistence = message.persisted ? '已获持久存储保护' : '可能随浏览器清理而移除';
            document.getElementById('historyStorageSummary').textContent = `浏览器存储：${used} / ${quota} · ${persistence}`;
            return;
        }
        if (message.type === 'historyProgressed') {
            const book = historyBooks.find(item => item.bookId === message.bookId);
            if (book) {
                book.progress = message.progress;
                book.lastOpenedAt = Date.now();
            }
            return;
        }
        if (message.type === 'historyRenamed' && message.jobId === activeJobId) {
            activeJobId = '';
            setBusy('');
            try {
                await updateDirectoryMetadata({
                    ...(historyBooks.find(item => item.bookId === message.book.bookId) || {}),
                    ...message.book
                });
            } catch (error) {
                setDirectorySummary(`标题已修改，但目录同步失败：${error.message}`, 'error');
            }
            setHistoryStatus(`标题已修改为“${message.book.title}”。`, 'success');
            requestHistoryList();
            return;
        }
        if (message.type === 'historyDeleted' && message.jobId === activeJobId) {
            if (currentHistoryBookId && (message.bookId === '*' || message.bookId === currentHistoryBookId)) {
                closeReaderSession(false);
            }
            const deletion = pendingDirectoryDeletion;
            pendingDirectoryDeletion = null;
            activeJobId = '';
            setBusy('');
            try {
                if (deletion?.deleteExternal) {
                    if (deletion.bookId === '*') {
                        await deleteAllDirectoryBooks();
                    } else {
                        await deleteDirectoryBook(deletion.bookId);
                    }
                }
                setHistoryStatus(deletion?.deleteExternal
                    ? '浏览器缓存和独立目录原件均已删除。'
                    : (message.count ? '浏览器缓存已删除，独立目录原件已保留。' : '这本漫画已不在浏览器缓存中。'), 'success');
            } catch (error) {
                setHistoryStatus(`浏览器缓存已删除，但目录原件删除失败：${error.message}`, 'error');
            }
            requestHistoryList();
            return;
        }
        if (message.type === 'progress' && message.jobId === activeJobId) {
            setProgress(message.processed, message.total);
            setStatus(`${message.message}… ${progressText.textContent}`);
            if (activeJobType === 'exportLongImage') {
                showReaderNotice(`${message.message}… ${progressText.textContent}`);
            }
            return;
        }
        if (message.type === 'page') {
            showReaderPage(message);
            return;
        }
        if (message.type === 'archiveReady' && message.jobId === activeJobId) {
            showDownload('archive', message);
            pendingArchiveForDirectory = { file: message.file, name: message.name };
            setStatus(`漫画归档已生成：${message.pages} 页 · ${formatBytes(message.size)}。正在生成 PNG 并加入书架…`, 'success');
            setHistoryStatus('正在把本次上传的图片加入书架…');
            return;
        }
        if (message.type === 'portableArchive' && message.jobId === activeJobId) {
            const book = migrationCurrentBook;
            try {
                await syncBookToDirectory(book, {
                    archiveFile: message.file,
                    coverFile: book?.coverFile
                });
                if (message.opfsName) {
                    worker.postMessage({
                        type: 'releaseOutput',
                        jobId: nextJobId('release-migration'),
                        payload: { opfsName: message.opfsName }
                    });
                }
                setHistoryStatus(`《${book.title}》已迁移，剩余 ${migrationQueue.length} 本。`, 'success');
                activeJobId = '';
                setBusy('');
                migrationCurrentBook = null;
                startNextMigration();
            } catch (error) {
                if (message.opfsName) {
                    worker.postMessage({
                        type: 'releaseOutput',
                        jobId: nextJobId('release-migration'),
                        payload: { opfsName: message.opfsName }
                    });
                }
                migrationQueue = [];
                migrationCurrentBook = null;
                activeJobId = '';
                setBusy('');
                setHistoryStatus(`迁移失败：${error.message}`, 'error');
            }
            return;
        }
        if (message.type === 'opened' && message.jobId === activeJobId) {
            const directoryBookId = openingDirectoryBookId;
            const directoryBook = historyBooks.find(book => book.bookId === directoryBookId);
            openingDirectoryBookId = '';
            const shouldConvertArchive = !message.bookId && !directoryBookId;
            renderReader(directoryBookId ? {
                ...message,
                bookId: directoryBookId,
                progress: directoryBook?.progress || { pageIndex: 0, pageRatio: 0 }
            } : message);
            setProgress(1, 1, 'success');
            if (directoryBookId) {
                setHistoryStatus('已从独立书架目录打开漫画。', 'success');
            } else if (message.bookId) {
                setHistoryStatus('已从本地书架恢复高清阅读。', 'success');
                requestHistoryList();
            } else {
                setStatus('漫画归档验证成功，正在转存 PNG 并加入书架。', 'success');
            }
            activeJobId = '';
            setBusy('');
            if (shouldConvertArchive) {
                exportLongImage(true, true);
            } else if (directoryBookId && pendingDirectoryExport) {
                pendingDirectoryExport = false;
                exportLongImage(true, false);
            }
            return;
        }
        if (message.type === 'complete' && message.jobId === activeJobId) {
            showDownload(message.kind, message);
            setProgress(1, 1, 'success');
            const label = message.kind === 'archive' ? '漫画归档' : '整本长图';
            const dimensions = message.kind === 'longImage' ? ` · ${message.width}×${message.height}` : '';
            setStatus(`${label}已生成：${message.pages} 页 · ${formatBytes(message.size)}${dimensions}。请点击下载。`, 'success');
            if (message.kind === 'longImage') {
                const link = document.getElementById('downloadComicLongImage');
                link.click();
                showReaderNotice('PNG 已生成；若浏览器拦截下载，请点击下载按钮。');
                autoDownloadLongImage = false;
                pendingHistoryFallback = null;
                const existingDirectoryBook = directoryBooks.find(book => book.bookId === message.bookId);
                const directoryBook = message.book
                    || historyBooks.find(book => book.bookId === message.bookId)
                    || existingDirectoryBook;
                if (directoryPermissionGranted && message.bookId && directoryBook) {
                    try {
                        await syncBookToDirectory(directoryBook, {
                            archiveFile: pendingArchiveForDirectory?.file
                                || existingDirectoryBook?.archiveFile
                                || (message.book ? selectedArchive : null),
                            longFile: message.file,
                            coverFile: message.coverFile || existingDirectoryBook?.coverFile || directoryBook.coverFile
                        });
                        setHistoryStatus(`已加入独立书架目录“${libraryDirectoryHandle.name}”。`, 'success');
                    } catch (error) {
                        setDirectorySummary(`漫画已保存到浏览器，但目录写入失败：${error.message}`, 'error');
                    }
                }
                pendingArchiveForDirectory = null;
                if (message.bookId) {
                    currentHistoryBookId = message.bookId;
                    if (!directoryPermissionGranted) {
                        setHistoryStatus('已加入浏览器书架。连接独立目录后可获得可迁移备份。', 'success');
                    }
                    requestHistoryList();
                }
            }
            activeJobId = '';
            setBusy('');
            return;
        }
        if (message.type === 'cancelled') {
            if (pageJobs.has(message.jobId)) {
                const index = pageJobs.get(message.jobId);
                pageJobs.delete(message.jobId);
                if (readerPages[index]) {
                    readerPages[index].pending = false;
                    readerPages[index].jobId = '';
                }
                return;
            }
            if (message.jobId === activeJobId) {
                const archiveWasCreated = activeJobType === 'encrypt' && !!outputState.archive.url;
                const cancelledType = activeJobType;
                activeJobId = '';
                autoDownloadLongImage = false;
                openingDirectoryBookId = '';
                pendingDirectoryExport = false;
                pendingArchiveForDirectory = null;
                pendingDirectoryDeletion = null;
                if (cancelledType === 'historyArchive') {
                    migrationQueue = [];
                    migrationCurrentBook = null;
                    setHistoryStatus('书架迁移已取消。');
                }
                setBusy('');
                resetProgress();
                setStatus(archiveWasCreated
                    ? '漫画归档已生成，加入书架的后续处理已取消；仍可下载 .ecomic。'
                    : '操作已取消。');
            }
            return;
        }
        if (message.type === 'error') {
            if (pageJobs.has(message.jobId)) {
                const index = pageJobs.get(message.jobId);
                pageJobs.delete(message.jobId);
                const page = readerPages[index];
                if (page) {
                    page.pending = false;
                    page.jobId = '';
                    const pageElement = reader.querySelector(`[data-reader-index="${index}"]`);
                    if (pageElement) {
                        pageElement.replaceChildren(createReaderPlaceholder(page, index, message.message));
                    }
                }
                setStatus(message.message, 'error');
                return;
            }
            if (message.jobId === activeJobId) {
                const archiveWasCreated = activeJobType === 'encrypt' && !!outputState.archive.url;
                const failedType = activeJobType;
                const fallback = pendingHistoryFallback;
                const shouldFallback = message.code === 'INSUFFICIENT_HISTORY_STORAGE'
                    && fallback
                    && root.confirm('本地空间不足，无法加入书架。是否改为仅生成并下载 PNG？');
                activeJobId = '';
                autoDownloadLongImage = false;
                openingDirectoryBookId = '';
                pendingDirectoryExport = false;
                pendingArchiveForDirectory = null;
                pendingDirectoryDeletion = null;
                if (failedType === 'historyArchive') {
                    migrationQueue = [];
                    migrationCurrentBook = null;
                    setHistoryStatus(`迁移失败：${message.message || '未知错误'}`, 'error');
                }
                setBusy('');
                progressGroup.dataset.kind = 'error';
                setStatus(archiveWasCreated
                    ? `漫画归档已生成，但加入书架失败：${message.message || '未知错误'}。仍可下载 .ecomic。`
                    : (message.message || '漫画处理失败'), 'error');
                if (shouldFallback) {
                    pendingHistoryFallback = null;
                    autoDownloadLongImage = true;
                    startJob('exportLongImage', '正在仅生成 PNG…', { ...fallback, saveHistory: false });
                }
            }
        }
    }

    function activateFilePicker(event, input) {
        if ((event.key === 'Enter' || event.key === ' ') && !input.disabled) {
            event.preventDefault();
            input.click();
        }
    }

    function createComicWorker() {
        const canLoadExternalWorker = location.protocol === 'http:' || location.protocol === 'https:';
        if (canLoadExternalWorker && typeof root.Worker === 'function') {
            try {
                return new Worker('js/comic-worker.js');
            } catch (error) {
                return new root.Ecryptees.LocalComicWorker();
            }
        }
        return new root.Ecryptees.LocalComicWorker();
    }

    function startWorker(reopenBookId = '') {
        worker = createComicWorker();
        worker.addEventListener('message', handleWorkerMessage);
        worker.addEventListener('error', () => {
            if (recoveringWorker) {
                return;
            }
            recoveringWorker = true;
            const recoverBookId = currentHistoryBookId;
            worker?.terminate();
            activeJobId = '';
            activeJobType = '';
            openingDirectoryBookId = '';
            pendingDirectoryExport = false;
            pendingArchiveForDirectory = null;
            pendingDirectoryDeletion = null;
            migrationQueue = [];
            migrationCurrentBook = null;
            sessionId = '';
            pageJobs.clear();
            readerPages.forEach(page => page.url && URL.revokeObjectURL(page.url));
            readerPages = [];
            reader.replaceChildren();
            setBusy('');
            setStatus('漫画后台已重新启动，正在恢复书架阅读…');
            root.setTimeout(() => {
                startWorker(recoverBookId);
                recoveringWorker = false;
            }, 100);
        });
        worker.postMessage({ type: 'cleanup', jobId: nextJobId('cleanup') });
        requestHistoryList();
        if (reopenBookId) {
            root.setTimeout(() => openHistoryBook(reopenBookId, false), 0);
        }
    }

    function initialize() {
        if (!runtimeSupported) {
            const warning = document.getElementById('comicEnvironmentWarning');
            warning.hidden = false;
            warning.textContent = '当前浏览器缺少 Web Crypto 或本地数据库能力，无法处理大型漫画归档。请升级浏览器后重试。';
            setStatus('当前打开方式不支持漫画模式。', 'error');
            setBusy('');
            return;
        }

        startWorker();
        restoreLibraryDirectory();
        setStatus(location.protocol === 'file:'
            ? '本地漫画模式已就绪。图片将按列表顺序无损封装。'
            : '漫画模式已就绪。图片将按列表顺序无损封装。');
        setBusy('');
    }

    comicFilesInput.addEventListener('change', handleFilesSelected);
    archiveInput.addEventListener('change', handleArchiveSelected);
    document.getElementById('comicFilesPicker').addEventListener('keydown', event => activateFilePicker(event, comicFilesInput));
    document.getElementById('comicArchiveFilePicker').addEventListener('keydown', event => activateFilePicker(event, archiveInput));
    document.getElementById('encryptComicButton').addEventListener('click', encryptComic);
    document.getElementById('clearComicFilesButton').addEventListener('click', clearItems);
    document.getElementById('openComicButton').addEventListener('click', openComic);
    document.getElementById('exportComicLongImageButton').addEventListener('click', () => exportLongImage(true, true));
    document.getElementById('closeComicReaderButton').addEventListener('click', () => closeReaderDialog());
    readerDialog.addEventListener('cancel', event => {
        event.preventDefault();
        closeReaderDialog();
    });
    document.getElementById('cancelComicButton').addEventListener('click', () => {
        if (worker && activeJobId) {
            worker.postMessage({ type: 'cancel', jobId: activeJobId });
            setStatus('正在取消当前操作…');
        }
    });
    fileList.addEventListener('click', event => {
        const button = event.target.closest('button[data-action]');
        if (!button) {
            return;
        }
        if (button.dataset.action === 'up') {
            moveItem(button.dataset.itemId, -1);
        } else if (button.dataset.action === 'down') {
            moveItem(button.dataset.itemId, 1);
        } else if (button.dataset.action === 'remove') {
            removeItem(button.dataset.itemId);
        }
    });
    reader.addEventListener('scroll', queueReaderProgressSave, { passive: true });
    historyGrid.addEventListener('click', event => {
        const button = event.target.closest('button[data-history-action]');
        if (!button) {
            return;
        }
        const { historyAction, bookId } = button.dataset;
        if (historyAction === 'open') {
            openHistoryBook(bookId, false);
        } else if (historyAction === 'restart') {
            openHistoryBook(bookId, true);
        } else if (historyAction === 'download') {
            redownloadHistoryBook(bookId);
        } else if (historyAction === 'rename') {
            renameHistoryBook(bookId);
        } else if (historyAction === 'delete') {
            requestDeleteHistoryBook(bookId);
        }
    });
    document.getElementById('clearHistoryButton').addEventListener('click', requestClearHistory);
    document.getElementById('selectHistoryDirectoryButton').addEventListener('click', connectLibraryDirectory);
    document.getElementById('migrateHistoryButton').addEventListener('click', migrateCurrentShelf);
    document.getElementById('historySearch').addEventListener('input', renderHistory);
    document.getElementById('historySort').addEventListener('change', renderHistory);
    document.getElementById('historyGoToComicButton').addEventListener('click', () => document.getElementById('comicTab').click());
    document.getElementById('historyTab').addEventListener('click', requestHistoryList);
    root.addEventListener('pageshow', () => requestHistoryList());
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            saveReaderProgressNow();
        }
    });
    root.addEventListener('beforeunload', () => {
        items.forEach(revokeItem);
        Object.keys(outputState).forEach(releaseOutput);
        readerPages.forEach(page => {
            if (page.url) {
                URL.revokeObjectURL(page.url);
            }
        });
        releaseHistoryCovers();
        worker?.terminate();
    });

    initialize();
})(globalThis);
