(function (root) {
    'use strict';

    const core = root.Ecryptees && root.Ecryptees.core;
    const comic = root.Ecryptees && root.Ecryptees.comic;
    const historyCore = root.Ecryptees && root.Ecryptees.history;
    const webImportCore = root.Ecryptees && root.Ecryptees.webImport;
    if (!core || !comic || !historyCore || !webImportCore) {
        throw new Error('Ecryptees core modules must load before the comic controller.');
    }

    const { format } = comic;
    const { formatBytes, sanitizeDownloadName } = core.utils;
    const androidMedia = root.EcrypteesAndroidMedia;
    const androidNetwork = root.AndroidNetworkBridge;
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
    const isAndroidRuntime = !!root.AndroidFileBridge || /EcrypteesAndroid\//.test(root.navigator.userAgent);
    const directoryPickerSupported = typeof root.showDirectoryPicker === 'function';
    const DIRECTORY_DATABASE_NAME = 'ecryptees-directory-v1';
    const DIRECTORY_HANDLE_STORE = 'handles';
    const DIRECTORY_HANDLE_KEY = 'library';
    const DIRECTORY_SCHEMA_VERSION = 1;
    const GROUP_DATABASE_NAME = 'ecryptees-groups-v1';
    const GROUP_DATABASE_VERSION = 1;
    const GROUP_STORE = 'groups';
    const GROUP_MEMBERSHIP_STORE = 'memberships';
    const READER_HEADER_STORAGE_KEY = 'ecryptees-reader-header-collapsed-v1';
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
    let readerHeaderRestoreTimer = 0;
    let readerReturnFocus = null;
    let readerHeaderCollapsed = false;
    let selectedArchiveTempName = '';
    let historyBooks = [];
    let browserHistoryBooks = [];
    let directoryBooks = [];
    let historyGroups = [];
    let historyGroupMemberships = new Map();
    let selectedHistoryGroup = 'all';
    let activeHistoryMenuBookId = '';
    let folderAssignmentBookId = '';
    let libraryDirectoryHandle = null;
    let directoryPermissionGranted = false;
    let pendingArchiveForDirectory = null;
    let openingDirectoryBookId = '';
    let migrationQueue = [];
    let migrationCurrentBook = null;
    let pendingDirectoryDeletion = null;
    let currentHistoryBookId = '';
    let pendingHistoryStart = false;
    let readerProgressTimer = 0;
    let readerRestoreProgress = null;
    let readerMemoryBytes = 0;
    let recoveringWorker = false;
    let webImportCandidates = [];
    let webImportFinalUrl = '';
    let webImportRenderedToken = '';
    let webImportAbortController = null;
    let webImportDragId = '';
    let webImportSessionId = '';
    let savedComicBookId = '';
    const activeRemoteFetchTokens = new Set();
    const historyCoverUrls = new Map();
    const directoryMetadataTasks = new Map();
    const pageJobs = new Map();
    const outputState = {
        archive: { url: '', opfsName: '', name: '', releaseTimer: 0 },
        historyArchive: { url: '', opfsName: '', name: '', releaseTimer: 0 },
        longExport: { url: '', opfsName: '', name: '', releaseTimer: 0 }
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
        const previewingWebImages = type === 'webPreview';
        comicFilesInput.disabled = busy || !runtimeSupported;
        archiveInput.disabled = busy || !runtimeSupported;
        document.getElementById('comicArchiveName').disabled = busy || !runtimeSupported;
        document.getElementById('localComicSourceButton').disabled = busy;
        document.getElementById('webComicSourceButton').disabled = busy;
        document.getElementById('webImportUrl').disabled = busy;
        document.getElementById('clearWebImportUrlButton').disabled = false;
        document.getElementById('analyzeWebImportButton').disabled = busy || !runtimeSupported;
        document.getElementById('webImportSelectionMenuButton').disabled = busy && !previewingWebImages;
        document.getElementById('clearWebImportButton').disabled = busy;
        const selectedWebImages = webImportCandidates.filter(candidate => candidate.selected && !candidate.duplicate);
        document.getElementById('downloadWebImportButton').disabled = busy
            || !runtimeSupported
            || !selectedWebImages.length
            || selectedWebImages.some(candidate => !candidate.prepared);
        const encryptButton = document.getElementById('encryptComicButton');
        encryptButton.disabled = busy || !runtimeSupported || items.length === 0;
        encryptButton.textContent = type === 'encrypt' ? '正在加密并加入资产…' : '加密并加入资产';
        document.getElementById('clearComicFilesButton').disabled = busy || items.length === 0;
        document.getElementById('openComicButton').disabled = busy || !runtimeSupported || !selectedArchive;
        document.getElementById('cancelComicButton').hidden = !busy;
        if (!root.EcrypteesImageAssetsUI?.isActive()) {
            document.getElementById('clearHistoryButton').disabled = busy || historyBooks.length === 0;
        }
        document.getElementById('historySearch').disabled = busy;
        document.getElementById('historySort').disabled = busy;
        document.getElementById('historyGroupFilterSelect').disabled = busy;
        document.getElementById('historyViewMenu').dataset.disabled = String(busy);
        if (busy) {
            document.getElementById('historyViewMenu').open = false;
        }
        document.getElementById('addHistoryFolderButton').disabled = busy;
        document.getElementById('selectHistoryDirectoryButton').disabled = busy || !directoryPickerSupported;
        document.getElementById('migrateHistoryButton').disabled = busy
            || !directoryPermissionGranted
            || browserHistoryBooks.length === 0;
    }

    function releaseOutput(kind) {
        const output = outputState[kind];
        if (!output) {
            return;
        }
        clearTimeout(output.releaseTimer);
        output.releaseTimer = 0;
        if (output.url) {
            URL.revokeObjectURL(output.url);
            output.url = '';
        }
        if (worker && output.opfsName) {
            worker.postMessage({ type: 'releaseOutput', jobId: nextJobId('release'), payload: { opfsName: output.opfsName } });
            output.opfsName = '';
        }
        output.name = '';
    }

    function captureOutput(kind, message, mime) {
        releaseOutput(kind);
        const output = outputState[kind];
        const outputBlob = new Blob([message.file], {
            type: mime
        });
        output.url = URL.createObjectURL(outputBlob);
        output.opfsName = message.opfsName;
        output.name = message.name;
        if (message.storageKind === 'indexeddb' && output.opfsName) {
            worker.postMessage({
                type: 'releaseOutput',
                jobId: nextJobId('release'),
                payload: { opfsName: output.opfsName }
            });
            output.opfsName = '';
        }
        return output;
    }

    function resetArchiveAction(release = true) {
        if (release) {
            releaseOutput('archive');
        }
        const link = document.getElementById('downloadComicArchive');
        link.href = '#';
        link.download = '';
        link.textContent = '下载 .ecomic';
        link.setAttribute('aria-disabled', 'true');
        link.hidden = true;
        const encryptButton = document.getElementById('encryptComicButton');
        encryptButton.hidden = false;
        encryptButton.textContent = '加密并加入资产';
        savedComicBookId = '';
        document.getElementById('viewSavedComicButton').hidden = true;
    }

    function prepareArchiveDownload(message) {
        const output = captureOutput('archive', message, 'application/octet-stream');
        const link = document.getElementById('downloadComicArchive');
        link.href = output.url;
        link.download = sanitizeDownloadName(message.name, format.EXTENSION);
        link.textContent = `下载 ${link.download}`;
        link.setAttribute('aria-disabled', 'false');
        link.hidden = true;
    }

    function revealArchiveDownload() {
        if (!outputState.archive.url) {
            return;
        }
        document.getElementById('encryptComicButton').hidden = true;
        document.getElementById('downloadComicArchive').hidden = false;
    }

    function revealSavedComic(bookId) {
        savedComicBookId = String(bookId || '');
        document.getElementById('encryptComicButton').hidden = true;
        document.getElementById('downloadComicArchive').hidden = true;
        document.getElementById('viewSavedComicButton').hidden = !savedComicBookId;
    }

    function scheduleOutputRelease(kind, resetCreateAction = false) {
        const output = outputState[kind];
        clearTimeout(output.releaseTimer);
        output.releaseTimer = root.setTimeout(() => {
            if (resetCreateAction) {
                resetArchiveAction();
            } else {
                releaseOutput(kind);
            }
            requestHistoryList();
        }, 60000);
    }

    function downloadOutput(kind, message, fallbackName) {
        const output = captureOutput(kind, message, 'application/octet-stream');
        const link = document.createElement('a');
        link.href = output.url;
        link.download = sanitizeDownloadName(message.name, fallbackName);
        link.hidden = true;
        document.body.append(link);
        link.click();
        link.remove();
        if (!isAndroidRuntime) {
            scheduleOutputRelease(kind);
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
            request.onerror = () => reject(request.error || new Error('独立漫画目录设置读取失败'));
        });
    }

    function transactionToPromise(transaction, fallbackMessage) {
        return new Promise((resolve, reject) => {
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error || new Error(fallbackMessage));
            transaction.onabort = () => reject(transaction.error || new Error(fallbackMessage));
        });
    }

    async function openHistoryGroupDatabase() {
        const request = indexedDB.open(GROUP_DATABASE_NAME, GROUP_DATABASE_VERSION);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(GROUP_STORE)) {
                request.result.createObjectStore(GROUP_STORE, { keyPath: 'groupId' });
            }
            if (!request.result.objectStoreNames.contains(GROUP_MEMBERSHIP_STORE)) {
                request.result.createObjectStore(GROUP_MEMBERSHIP_STORE, { keyPath: 'bookId' });
            }
        };
        return requestToPromise(request);
    }

    function normalizeHistoryGroupName(value) {
        return String(value || '').trim().slice(0, 40);
    }

    function createHistoryGroupId() {
        if (typeof root.crypto.randomUUID === 'function') {
            return root.crypto.randomUUID();
        }
        const bytes = root.crypto.getRandomValues(new Uint8Array(16));
        return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    }

    async function loadHistoryGroupState() {
        const database = await openHistoryGroupDatabase();
        try {
            const transaction = database.transaction([GROUP_STORE, GROUP_MEMBERSHIP_STORE], 'readonly');
            const [groups, memberships] = await Promise.all([
                requestToPromise(transaction.objectStore(GROUP_STORE).getAll()),
                requestToPromise(transaction.objectStore(GROUP_MEMBERSHIP_STORE).getAll())
            ]);
            historyGroups = groups
                .map(group => ({
                    groupId: String(group?.groupId || ''),
                    name: normalizeHistoryGroupName(group?.name),
                    createdAt: Math.max(0, Number(group?.createdAt) || 0)
                }))
                .filter(group => group.groupId && group.name)
                .sort((left, right) => left.createdAt - right.createdAt || left.name.localeCompare(right.name, 'zh-CN'));
            const validGroupIds = new Set(historyGroups.map(group => group.groupId));
            historyGroupMemberships = new Map(memberships
                .filter(item => item?.bookId && validGroupIds.has(String(item.groupId || '')))
                .map(item => [String(item.bookId), String(item.groupId)]));
            if (selectedHistoryGroup !== 'all'
                && selectedHistoryGroup !== 'ungrouped'
                && !validGroupIds.has(selectedHistoryGroup)) {
                selectedHistoryGroup = 'all';
            }
        } finally {
            database.close();
        }
        renderHistory();
    }

    async function createHistoryGroup(name, bookId = '') {
        const normalizedName = normalizeHistoryGroupName(name);
        if (!normalizedName) {
            throw new Error('文件夹名称不能为空。');
        }
        if (historyGroups.some(group => group.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase())) {
            throw new Error('已经存在同名文件夹。');
        }
        const now = Date.now();
        const group = { groupId: createHistoryGroupId(), name: normalizedName, createdAt: now, updatedAt: now };
        const database = await openHistoryGroupDatabase();
        try {
            const transaction = database.transaction([GROUP_STORE, GROUP_MEMBERSHIP_STORE], 'readwrite');
            transaction.objectStore(GROUP_STORE).add(group);
            if (bookId) {
                transaction.objectStore(GROUP_MEMBERSHIP_STORE).put({ bookId, groupId: group.groupId, updatedAt: now });
            }
            await transactionToPromise(transaction, '无法保存文件夹');
        } finally {
            database.close();
        }
        await loadHistoryGroupState();
        return group;
    }

    async function setHistoryBookGroup(bookId, groupId) {
        const normalizedGroupId = String(groupId || '');
        if (normalizedGroupId && !historyGroups.some(group => group.groupId === normalizedGroupId)) {
            throw new Error('所选文件夹已不存在。');
        }
        const database = await openHistoryGroupDatabase();
        try {
            const transaction = database.transaction(GROUP_MEMBERSHIP_STORE, 'readwrite');
            const store = transaction.objectStore(GROUP_MEMBERSHIP_STORE);
            if (normalizedGroupId) {
                store.put({ bookId, groupId: normalizedGroupId, updatedAt: Date.now() });
            } else {
                store.delete(bookId);
            }
            await transactionToPromise(transaction, '无法保存漫画分组');
        } finally {
            database.close();
        }
        if (normalizedGroupId) {
            historyGroupMemberships.set(bookId, normalizedGroupId);
        } else {
            historyGroupMemberships.delete(bookId);
        }
        renderHistory();
    }

    async function removeHistoryMemberships(bookId) {
        const database = await openHistoryGroupDatabase();
        try {
            const transaction = database.transaction(GROUP_MEMBERSHIP_STORE, 'readwrite');
            const store = transaction.objectStore(GROUP_MEMBERSHIP_STORE);
            if (bookId === '*') {
                store.clear();
                historyGroupMemberships.clear();
            } else {
                store.delete(bookId);
                historyGroupMemberships.delete(bookId);
            }
            await transactionToPromise(transaction, '无法清理漫画分组');
        } finally {
            database.close();
        }
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
                transaction.onerror = () => reject(transaction.error || new Error('无法保存漫画目录授权'));
                transaction.onabort = () => reject(transaction.error || new Error('漫画目录授权保存已取消'));
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
        const png = Number(book.png?.size) > 0
            ? book.png
            : (existing.png || book.png || { name: 'long.png', width: 1, height: 1, size: 0, generatedAt: 0 });
        return {
            schemaVersion: DIRECTORY_SCHEMA_VERSION,
            bookId: book.bookId,
            title: historyCore.normalizeTitle(book.title),
            pageCount,
            totalSize: Math.max(1, Math.trunc(Number(book.totalSize) || 1)),
            progress: historyCore.normalizeProgress(book.progress, pageCount),
            png,
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
                throw new Error('独立漫画目录缺少可保存的 .ecomic 归档');
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
                throw new Error('未获得漫画目录读写权限');
            }
            libraryDirectoryHandle = handle;
            directoryPermissionGranted = true;
            await rememberDirectoryHandle(handle);
            await scanLibraryDirectory();
            setHistoryStatus('独立漫画目录已连接。以后生成的漫画会自动写入该目录。', 'success');
        } catch (error) {
            if (error?.name !== 'AbortError') {
                setDirectorySummary(error.message || '无法连接独立漫画目录', 'error');
            }
        }
        setBusy(activeJobType);
    }

    async function restoreLibraryDirectory() {
        if (!directoryPickerSupported) {
            setDirectorySummary('当前浏览器不支持直接写入普通目录；继续使用浏览器资产和文件下载。', 'error');
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
                setDirectorySummary(`需要重新授权“${handle.name}”，请点击“选择漫画目录”`, 'info');
            }
        } catch (error) {
            setDirectorySummary('原漫画目录已不可用，请重新选择。', 'error');
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

    function createHistoryButton(label, action, bookId, className = 'secondary-button') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.dataset.historyAction = action;
        button.dataset.bookId = bookId;
        button.textContent = label;
        return button;
    }

    function createHistoryMenuButton(book) {
        const button = createHistoryButton('更多操作', 'menu', book.bookId, 'history-menu-button');
        button.title = '更多操作';
        button.setAttribute('aria-label', `打开《${book.title}》的更多操作`);
        button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/></svg>';
        return button;
    }

    function renderHistoryViewMenu() {
        const select = document.getElementById('historyGroupFilterSelect');
        select.replaceChildren();
        const definitions = [
            { groupId: 'all', name: '全部' },
            { groupId: 'ungrouped', name: '未分组' },
            ...historyGroups
        ];
        for (const group of definitions) {
            const option = document.createElement('option');
            option.value = group.groupId;
            const count = group.groupId === 'all'
                ? historyBooks.length
                : historyBooks.filter(book => {
                    const membership = historyGroupMemberships.get(book.bookId) || '';
                    return group.groupId === 'ungrouped' ? !membership : membership === group.groupId;
                }).length;
            option.textContent = `${group.name}（${count}）`;
            select.append(option);
        }
        select.value = selectedHistoryGroup;
        const groupName = definitions.find(group => group.groupId === selectedHistoryGroup)?.name || '全部';
        document.getElementById('historyViewSummary').textContent = groupName === '全部' ? '全部文件夹' : groupName;
    }

    function renderHistory() {
        if (root.EcrypteesImageAssetsUI?.isActive()) {
            root.EcrypteesImageAssetsUI.render();
            return;
        }
        retireHistoryCovers();
        const query = document.getElementById('historySearch').value.trim().toLocaleLowerCase();
        const sort = document.getElementById('historySort').value;
        const books = historyBooks
            .filter(book => {
                if (query && !book.title.toLocaleLowerCase().includes(query)) {
                    return false;
                }
                const membership = historyGroupMemberships.get(book.bookId) || '';
                if (selectedHistoryGroup === 'ungrouped') {
                    return !membership;
                }
                return selectedHistoryGroup === 'all' || membership === selectedHistoryGroup;
            })
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
        renderHistoryViewMenu();
        document.getElementById('historyEmptyState').hidden = historyBooks.length !== 0;
        document.getElementById('historyEmptyTitle').textContent = '漫画资产还是空的';
        document.getElementById('historyEmptyDescription').textContent = '加密或解密 `.ecomic` 后会自动加入漫画资产。';
        document.getElementById('historyGoToComicButton').textContent = '前往漫画模式';
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
            cardHeader.append(title, createHistoryMenuButton(book));
            const meta = document.createElement('p');
            meta.className = 'history-card-meta';
            meta.textContent = `${book.pageCount} 页 · ${formatBytes(book.totalSize)}${book.archiveFile ? ' · 独立目录' : ''}`;
            const time = document.createElement('p');
            time.className = 'history-card-time';
            time.textContent = `最近：${formatHistoryDate(book.lastOpenedAt || book.updatedAt)}`;
            const actions = document.createElement('div');
            actions.className = 'history-card-actions';
            actions.append(
                createHistoryButton('阅读', 'open', book.bookId, 'history-open'),
                createHistoryButton('导出 .ecomic', 'exportArchive', book.bookId),
                createHistoryButton('导出长图', 'exportLong', book.bookId),
                createHistoryButton('删除', 'delete', book.bookId, 'secondary-button history-delete')
            );
            body.append(cardHeader, meta, time, actions);
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

    function closeHistoryDialog(dialog) {
        if (dialog.open) {
            dialog.close();
        }
    }

    function openHistoryBookMenu(bookId) {
        const book = historyBooks.find(item => item.bookId === bookId);
        if (!book || activeJobType) {
            return;
        }
        activeHistoryMenuBookId = bookId;
        document.getElementById('historyBookMenuTitle').textContent = book.title;
        document.getElementById('historyBookMenuDialog').showModal();
    }

    function openHistoryFolderDialog(bookId = '') {
        folderAssignmentBookId = bookId;
        const dialog = document.getElementById('historyFolderDialog');
        const input = document.getElementById('historyFolderName');
        const error = document.getElementById('historyFolderError');
        input.value = '';
        error.hidden = true;
        error.textContent = '';
        dialog.showModal();
        root.setTimeout(() => input.focus(), 0);
    }

    function openHistoryGroupDialog(bookId) {
        const book = historyBooks.find(item => item.bookId === bookId);
        if (!book || activeJobType) {
            return;
        }
        activeHistoryMenuBookId = bookId;
        const select = document.getElementById('historyGroupSelect');
        select.replaceChildren();
        const ungrouped = document.createElement('option');
        ungrouped.value = '';
        ungrouped.textContent = '未分组';
        select.append(ungrouped);
        for (const group of historyGroups) {
            const option = document.createElement('option');
            option.value = group.groupId;
            option.textContent = group.name;
            select.append(option);
        }
        select.value = historyGroupMemberships.get(bookId) || '';
        document.getElementById('historyGroupDialogTitle').textContent = `添加分组 · ${book.title}`;
        document.getElementById('historyGroupDialog').showModal();
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
            setHistoryStatus('当前浏览器漫画资产已迁移到独立目录。', 'success');
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
            setHistoryStatus('浏览器资产中的漫画已经全部存在于独立目录。', 'success');
            return;
        }
        setHistoryStatus(`准备迁移 ${migrationQueue.length} 本漫画。迁移期间请保持页面打开。`);
        startNextMigration();
    }

    function waitForRemoteStatus() {
        return new Promise(resolve => root.setTimeout(resolve, 60));
    }

    function decodeBase64Chunk(value) {
        const binary = root.atob(value);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) {
            bytes[index] = binary.charCodeAt(index);
        }
        return bytes;
    }

    function concatByteChunks(chunks, size) {
        const output = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            output.set(chunk, offset);
            offset += chunk.length;
        }
        return output;
    }

    function decodeHtmlBytes(bytes, contentType) {
        const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType || '')?.[1] || 'utf-8';
        try {
            return new TextDecoder(charset).decode(bytes);
        } catch (error) {
            return new TextDecoder('utf-8').decode(bytes);
        }
    }

    async function awaitNativeRemoteFetch(token, signal) {
        activeRemoteFetchTokens.add(token);
        const cancel = () => {
            try {
                androidNetwork.cancelRemoteFetch(token);
            } catch (error) {
                // The task may already have finished.
            }
        };
        signal?.addEventListener('abort', cancel, { once: true });
        try {
            while (true) {
                if (signal?.aborted) {
                    throw new DOMException('操作已取消', 'AbortError');
                }
                const info = JSON.parse(androidNetwork.getRemoteFetchStatus(token) || '{}');
                if (info.state === 'ready') {
                    return info;
                }
                if (info.state === 'error' || info.state === 'cancelled' || !info.state) {
                    throw new Error(info.error || '网络请求失败');
                }
                await waitForRemoteStatus();
            }
        } finally {
            signal?.removeEventListener('abort', cancel);
        }
    }

    function releaseNativeRemoteFetch(token) {
        activeRemoteFetchTokens.delete(token);
        try {
            androidNetwork.releaseRemoteFetch(token);
        } catch (error) {
            // Native cold-start cleanup is the fallback.
        }
    }

    function releaseRenderedPageCapture() {
        if (!webImportRenderedToken || typeof androidNetwork?.releaseRenderedPageCapture !== 'function') {
            webImportRenderedToken = '';
            return;
        }
        try {
            androidNetwork.releaseRenderedPageCapture(webImportRenderedToken);
        } catch (error) {
            // Native Activity cleanup is the final fallback.
        }
        webImportRenderedToken = '';
    }

    async function captureRenderedPage(url, maximum, signal) {
        if (!isAndroidRuntime || typeof androidNetwork?.beginRenderedPageCapture !== 'function') {
            throw new Error('网页依赖脚本生成图片；请使用支持动态网页分析的 Android APK');
        }
        const token = androidNetwork.beginRenderedPageCapture(url, maximum);
        if (!token) {
            throw new Error('无法启动动态网页分析');
        }
        webImportRenderedToken = token;
        const cancel = () => {
            try {
                androidNetwork.releaseRenderedPageCapture(token);
            } catch (error) {
                // Native cleanup also runs when the Activity closes.
            }
        };
        signal.addEventListener('abort', cancel, { once: true });
        try {
            while (true) {
                if (signal.aborted) {
                    throw new DOMException('操作已取消', 'AbortError');
                }
                const status = JSON.parse(androidNetwork.getRenderedPageCaptureStatus(token) || '{}');
                if (status.state === 'ready') {
                    return status;
                }
                if (status.state === 'error' || status.state === 'cancelled') {
                    throw new Error(status.error || '动态网页分析失败');
                }
                await new Promise(resolve => root.setTimeout(resolve, 350));
            }
        } catch (error) {
            releaseRenderedPageCapture();
            throw error;
        } finally {
            signal.removeEventListener('abort', cancel);
        }
    }

    async function fetchHtmlForImport(url, signal) {
        const maximumBytes = 5 * 1024 * 1024;
        if (isAndroidRuntime) {
            if (!androidNetwork) {
                throw new Error('当前 APK 缺少网页导入网络桥，请安装 1.0.11 或更高版本');
            }
            const token = androidNetwork.beginRemoteFetch(url, 'html', '');
            if (!token) {
                throw new Error('无法启动网页请求');
            }
            try {
                const info = await awaitNativeRemoteFetch(token, signal);
                const chunks = [];
                let size = 0;
                while (true) {
                    const encoded = androidNetwork.readRemoteFetchChunk(token, 768 * 1024);
                    if (!encoded) {
                        break;
                    }
                    const chunk = decodeBase64Chunk(encoded);
                    size += chunk.length;
                    if (size > maximumBytes) {
                        throw new Error('网页 HTML 不能超过 5 MiB');
                    }
                    chunks.push(chunk);
                }
                return {
                    html: decodeHtmlBytes(concatByteChunks(chunks, size), info.contentType),
                    finalUrl: info.finalUrl || url
                };
            } finally {
                releaseNativeRemoteFetch(token);
            }
        }

        let response;
        try {
            response = await root.fetch(url, {
                cache: 'no-store',
                credentials: 'omit',
                mode: 'cors',
                redirect: 'follow',
                signal,
                headers: { Accept: 'text/html,application/xhtml+xml' }
            });
        } catch (error) {
            if (error.name === 'AbortError') {
                throw error;
            }
            throw new Error('浏览器受跨域限制，无法读取该网页；请改用 Android APK');
        }
        if (!response.ok) {
            throw new Error(`网页请求失败：HTTP ${response.status}`);
        }
        if (!webImportCore.normalizeHttpsUrl(response.url, response.url)) {
            throw new Error('网页重定向到了非 HTTPS 地址');
        }
        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error('当前浏览器不支持流式读取网页');
        }
        const chunks = [];
        let size = 0;
        while (true) {
            const result = await reader.read();
            if (result.done) {
                break;
            }
            size += result.value.length;
            if (size > maximumBytes) {
                await reader.cancel();
                throw new Error('网页 HTML 不能超过 5 MiB');
            }
            chunks.push(result.value);
        }
        return {
            html: decodeHtmlBytes(concatByteChunks(chunks, size), response.headers.get('content-type')),
            finalUrl: response.url
        };
    }

    function createWebTempName(index) {
        return `ecryptees-temp-web-${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2)}.image`;
    }

    async function removeWebTemp(entryName) {
        if (!entryName || !root.navigator.storage?.getDirectory) {
            return;
        }
        try {
            const storageRoot = await root.navigator.storage.getDirectory();
            await storageRoot.removeEntry(entryName);
        } catch (error) {
            // Worker cold-start cleanup is the fallback.
        }
    }

    function deriveRemoteFileName(finalUrl, detected, index, usedNames) {
        let candidate = '';
        try {
            candidate = decodeURIComponent(new URL(finalUrl).pathname.split('/').pop() || '');
        } catch (error) {
            candidate = '';
        }
        candidate = sanitizeDownloadName(candidate, `page-${String(index + 1).padStart(3, '0')}.${detected.extension}`);
        if (!/\.[a-z0-9]{2,5}$/i.test(candidate)) {
            candidate += `.${detected.extension}`;
        }
        const dot = candidate.lastIndexOf('.');
        const stem = dot > 0 ? candidate.slice(0, dot) : candidate;
        const extension = dot > 0 ? candidate.slice(dot) : `.${detected.extension}`;
        let unique = candidate;
        let suffix = 2;
        while (usedNames.has(unique.toLowerCase())) {
            unique = `${stem}-${suffix}${extension}`;
            suffix += 1;
        }
        usedNames.add(unique.toLowerCase());
        return unique;
    }

    async function streamBrowserImageToWritable(candidate, writable, signal, budget) {
        let response;
        try {
            response = await root.fetch(candidate.url, {
                cache: 'no-store',
                credentials: 'omit',
                mode: 'cors',
                redirect: 'follow',
                signal,
                headers: { Accept: 'image/*' }
            });
        } catch (error) {
            if (error.name === 'AbortError') {
                throw error;
            }
            throw new Error('图片服务器不允许浏览器跨域读取，请改用 Android APK');
        }
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        if (!webImportCore.normalizeHttpsUrl(response.url, response.url)) {
            throw new Error('图片重定向到了非 HTTPS 地址');
        }
        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error('当前浏览器不支持流式下载图片');
        }
        let localBytes = 0;
        try {
            while (true) {
                const result = await reader.read();
                if (result.done) {
                    break;
                }
                localBytes += result.value.length;
                budget.bytes += result.value.length;
                if (budget.bytes > budget.limit) {
                    await reader.cancel();
                    throw new Error('漫画原图总体积不能超过 500 MiB');
                }
                await writable.write(result.value);
            }
            return { finalUrl: response.url, bytes: localBytes };
        } catch (error) {
            budget.bytes -= localBytes;
            throw error;
        }
    }

    async function streamNativeImageToWritable(candidate, writable, signal, budget) {
        const token = androidNetwork.beginRemoteFetch(candidate.url, 'image', webImportFinalUrl);
        if (!token) {
            throw new Error('无法启动图片请求');
        }
        let localBytes = 0;
        try {
            const info = await awaitNativeRemoteFetch(token, signal);
            while (true) {
                const encoded = androidNetwork.readRemoteFetchChunk(token, 768 * 1024);
                if (!encoded) {
                    break;
                }
                const chunk = decodeBase64Chunk(encoded);
                localBytes += chunk.length;
                budget.bytes += chunk.length;
                if (budget.bytes > budget.limit) {
                    throw new Error('漫画原图总体积不能超过 500 MiB');
                }
                await writable.write(chunk);
            }
            return { finalUrl: info.finalUrl || candidate.url, bytes: localBytes };
        } catch (error) {
            budget.bytes -= localBytes;
            throw error;
        } finally {
            releaseNativeRemoteFetch(token);
        }
    }

    async function streamCapturedImageToWritable(candidate, writable, signal, budget) {
        if (!webImportRenderedToken || typeof androidNetwork?.readRenderedPageImageChunk !== 'function') {
            throw new Error('动态网页图片已经释放，请重新分析网页');
        }
        let localBytes = 0;
        try {
            while (true) {
                if (signal.aborted) {
                    throw new DOMException('操作已取消', 'AbortError');
                }
                const encoded = androidNetwork.readRenderedPageImageChunk(
                    webImportRenderedToken,
                    candidate.capturedIndex,
                    localBytes,
                    768 * 1024
                );
                if (!encoded) {
                    break;
                }
                const chunk = decodeBase64Chunk(encoded);
                localBytes += chunk.length;
                budget.bytes += chunk.length;
                if (budget.bytes > budget.limit) {
                    throw new Error('漫画原图总体积不能超过 500 MiB');
                }
                await writable.write(chunk);
            }
            if (localBytes !== candidate.capturedSize) {
                throw new Error('动态网页图片读取不完整');
            }
            return {
                finalUrl: `https://capture.invalid/${encodeURIComponent(candidate.capturedName || 'page.jpg')}`,
                bytes: localBytes
            };
        } catch (error) {
            budget.bytes -= localBytes;
            throw error;
        }
    }

    async function canvasToImageBlob(canvas, mime) {
        if (typeof canvas.convertToBlob === 'function') {
            return canvas.convertToBlob({ type: mime, quality: 1 });
        }
        return new Promise((resolve, reject) => {
            canvas.toBlob(blob => {
                if (blob) {
                    resolve(blob);
                } else {
                    reject(new Error('还原后的图片编码失败'));
                }
            }, mime, 1);
        });
    }

    async function materializeWebImage(stored, detected, transform, signal) {
        if (!transform || transform.kind !== '18comic-scramble') {
            return null;
        }
        if (signal.aborted) {
            throw new DOMException('操作已取消', 'AbortError');
        }
        let bitmap;
        try {
            bitmap = await root.createImageBitmap(stored, { imageOrientation: 'from-image' });
        } catch (error) {
            bitmap = await root.createImageBitmap(stored);
        }
        try {
            const width = bitmap.width;
            const height = bitmap.height;
            const slices = Math.max(2, Math.min(20, Math.trunc(transform.slices)));
            if (!width || !height || width * height > core.config.MAX_IMAGE_PIXELS) {
                throw new Error('网页图片像素尺寸无效或超过处理限制');
            }
            const canvas = typeof root.OffscreenCanvas === 'function'
                ? new root.OffscreenCanvas(width, height)
                : Object.assign(document.createElement('canvas'), { width, height });
            const context = canvas.getContext('2d');
            if (!context) {
                throw new Error('当前设备无法还原分段漫画图片');
            }
            const remainder = height % slices;
            const stripHeight = Math.floor(height / slices);
            for (let index = 0; index < slices; index += 1) {
                let copyHeight = stripHeight;
                let destinationY = stripHeight * index;
                const sourceY = height - stripHeight * (index + 1) - remainder;
                if (index === 0) {
                    copyHeight += remainder;
                } else {
                    destinationY += remainder;
                }
                context.drawImage(
                    bitmap,
                    0,
                    sourceY,
                    width,
                    copyHeight,
                    0,
                    destinationY,
                    width,
                    copyHeight
                );
            }
            const outputMime = ['image/jpeg', 'image/png', 'image/webp'].includes(detected.mime)
                ? detected.mime
                : 'image/png';
            let blob = await canvasToImageBlob(canvas, outputMime);
            if (!blob.size && outputMime !== 'image/png') {
                blob = await canvasToImageBlob(canvas, 'image/png');
            }
            if (!blob.size) {
                throw new Error('还原后的图片为空');
            }
            return blob;
        } finally {
            bitmap.close?.();
        }
    }

    async function downloadWebCandidate(candidate, index, signal, budget, usedNames) {
        const storageRoot = await root.navigator.storage.getDirectory();
        const entryName = createWebTempName(index);
        const handle = await storageRoot.getFileHandle(entryName, { create: true });
        let writable;
        let completedBytes = 0;
        try {
            writable = await handle.createWritable();
            const result = candidate.capturedIndex >= 0
                ? await streamCapturedImageToWritable(candidate, writable, signal, budget)
                : (isAndroidRuntime
                    ? await streamNativeImageToWritable(candidate, writable, signal, budget)
                    : await streamBrowserImageToWritable(candidate, writable, signal, budget));
            completedBytes = result.bytes;
            await writable.close();
            writable = null;
            let stored = await handle.getFile();
            if (stored.size <= 0) {
                throw new Error('下载结果为空');
            }
            let prefix = new Uint8Array(await stored.slice(0, 64).arrayBuffer());
            let detected = core.image.sniffImageType(prefix);
            if (!detected || !format.SUPPORTED_MIME_TYPES.includes(detected.mime)) {
                throw new Error('下载内容不是支持的漫画图片');
            }
            const materialized = await materializeWebImage(stored, detected, candidate.transform, signal);
            if (materialized) {
                const projectedBytes = budget.bytes - stored.size + materialized.size;
                if (projectedBytes > budget.limit) {
                    throw new Error('还原后的漫画原图总体积不能超过 500 MiB');
                }
                budget.bytes = projectedBytes;
                completedBytes = materialized.size;
                writable = await handle.createWritable();
                await writable.write(materialized);
                await writable.close();
                writable = null;
                stored = await handle.getFile();
                prefix = new Uint8Array(await stored.slice(0, 64).arrayBuffer());
                detected = core.image.sniffImageType(prefix);
                if (!detected || !format.SUPPORTED_MIME_TYPES.includes(detected.mime)) {
                    throw new Error('还原后的内容不是支持的漫画图片');
                }
            }
            const fileName = deriveRemoteFileName(result.finalUrl, detected, index, usedNames);
            const file = new File([stored], fileName, { type: detected.mime, lastModified: Date.now() });
            const item = await prepareComicItem(file, detected);
            item.sourceUrl = candidate.url;
            item.tempEntryName = entryName;
            return item;
        } catch (error) {
            if (completedBytes) {
                budget.bytes = Math.max(0, budget.bytes - completedBytes);
            }
            try {
                await writable?.abort(error);
            } catch (abortError) {
                // Preserve the original failure.
            }
            await removeWebTemp(entryName);
            throw error;
        }
    }

    function releasePreparedCandidate(candidate) {
        candidate?.abortController?.abort();
        if (!candidate?.prepared) {
            if (candidate) {
                candidate.loading = false;
                candidate.abortController = null;
            }
            return;
        }
        revokeItem(candidate.prepared);
        candidate.prepared = null;
        candidate.loading = false;
        candidate.abortController = null;
    }

    function clearWebImportCandidates(message = '') {
        webImportCandidates.forEach(releasePreparedCandidate);
        releaseRenderedPageCapture();
        webImportCandidates = [];
        webImportFinalUrl = '';
        document.getElementById('webImportList').replaceChildren();
        document.getElementById('webImportResults').hidden = true;
        if (message) {
            setStatus(message);
        }
        setBusy(activeJobType);
    }

    function clearWebImportSession() {
        const cancellingWebTask = activeJobType === 'webAnalyze'
            || activeJobType === 'webPreview'
            || activeJobType === 'webDownload';
        if (cancellingWebTask) {
            webImportAbortController?.abort();
            webImportAbortController = null;
            activeJobType = '';
        }
        clearWebImportCandidates();
        const retained = [];
        for (const item of items) {
            if (webImportSessionId && item.webImportSessionId === webImportSessionId) {
                revokeItem(item);
            } else {
                retained.push(item);
            }
        }
        items = retained;
        webImportSessionId = '';
        document.getElementById('webImportUrl').value = '';
        renderFileList();
        updateSelectionSummary();
        resetProgress();
        setBusy('');
        setStatus('网页链接和本次网页任务已清除；本地导入页面已保留。');
        document.getElementById('webImportUrl').focus();
    }

    function selectedWebCandidates() {
        return webImportCandidates.filter(candidate => candidate.selected && !candidate.duplicate);
    }

    function closeWebImportSelectionMenu() {
        const menu = document.getElementById('webImportSelectionMenu');
        const trigger = document.getElementById('webImportSelectionMenuButton');
        menu.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
    }

    function applyWebImportSelection(mode) {
        const maximum = Math.max(0, format.MAX_PAGES - items.length);
        const eligible = webImportCandidates.filter(candidate => !candidate.duplicate);
        const invertedCandidates = mode === 'invert'
            ? eligible.filter(candidate => !candidate.selected)
            : [];
        const desired = new Set();
        if (mode === 'all') {
            eligible.slice(0, maximum).forEach(candidate => desired.add(candidate));
        } else if (mode === 'invert') {
            invertedCandidates
                .slice(0, maximum)
                .forEach(candidate => desired.add(candidate));
        }
        for (const candidate of eligible) {
            const shouldSelect = desired.has(candidate);
            if (!shouldSelect && candidate.selected) {
                releasePreparedCandidate(candidate);
            }
            candidate.selected = shouldSelect;
            if (shouldSelect) {
                candidate.error = '';
            }
        }
        renderWebImportCandidates();
        previewWebCandidates(selectedWebCandidates());
        if (mode === 'invert' && invertedCandidates.length > maximum) {
            setStatus(`反转结果超过剩余页数，已按列表顺序选择前 ${maximum} 张。`, 'info');
        }
    }

    function updateWebImportSummary() {
        const selectedCandidates = selectedWebCandidates();
        const totalAfterImport = Math.min(format.MAX_PAGES, items.length + selectedCandidates.length);
        const ready = selectedCandidates.filter(candidate => candidate.prepared).length;
        document.getElementById('webImportSummary').textContent = `${totalAfterImport}/${format.MAX_PAGES}`;
        const action = document.getElementById('downloadWebImportButton');
        action.textContent = selectedCandidates.length === 0
            ? '请先选择图片'
            : (ready === selectedCandidates.length ? '加入漫画' : `正在预览 ${ready}/${selectedCandidates.length}`);
        setBusy(activeJobType);
    }

    function renderWebImportCandidates() {
        const list = document.getElementById('webImportList');
        list.replaceChildren();
        webImportCandidates.forEach((candidate, index) => {
            const item = document.createElement('li');
            item.className = 'web-import-item';
            item.dataset.candidateId = candidate.id;
            item.dataset.duplicate = String(candidate.duplicate);
            item.dataset.error = String(!!candidate.error);
            item.draggable = !candidate.duplicate && activeJobType !== 'webAnalyze' && activeJobType !== 'webDownload';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = candidate.selected;
            checkbox.disabled = candidate.duplicate || activeJobType === 'webAnalyze' || activeJobType === 'webDownload';
            checkbox.setAttribute('aria-label', `选择第 ${index + 1} 个图片地址`);
            checkbox.addEventListener('change', () => {
                const maximum = Math.max(0, format.MAX_PAGES - items.length);
                if (checkbox.checked && selectedWebCandidates().length >= maximum) {
                    checkbox.checked = false;
                    setStatus(`当前漫画最多还能加入 ${maximum} 张图片`, 'error');
                    return;
                }
                candidate.selected = checkbox.checked;
                if (!candidate.selected) {
                    releasePreparedCandidate(candidate);
                } else {
                    candidate.error = '';
                    previewWebCandidates([candidate]);
                }
                renderWebImportCandidates();
            });

            const number = document.createElement('span');
            number.className = 'web-import-index';
            number.textContent = String(index + 1).padStart(2, '0');

            const preview = document.createElement('span');
            preview.className = 'web-import-preview';
            preview.dataset.state = candidate.duplicate
                ? 'duplicate'
                : (candidate.loading ? 'loading' : (candidate.prepared ? 'ready' : (candidate.error ? 'error' : 'waiting')));
            if (candidate.prepared) {
                const image = document.createElement('img');
                image.src = candidate.prepared.url;
                image.alt = `第 ${index + 1} 张网页图片预览`;
                image.loading = 'lazy';
                image.decoding = 'async';
                preview.append(image);
            } else {
                preview.setAttribute('role', 'img');
                preview.setAttribute('aria-label', candidate.duplicate
                    ? `第 ${index + 1} 个地址重复，未加载预览`
                    : (candidate.error ? `第 ${index + 1} 张预览加载失败` : `第 ${index + 1} 张预览尚未完成`));
            }

            const info = document.createElement('span');
            info.className = 'web-import-info';
            const addressRow = document.createElement('span');
            addressRow.className = 'web-import-address-row';
            const address = document.createElement('span');
            address.className = 'web-import-url';
            address.textContent = candidate.url;
            address.title = candidate.url;
            const host = document.createElement('span');
            host.className = 'web-import-host';
            host.textContent = candidate.duplicate
                ? `重复地址，已忽略 · ${new URL(candidate.url).host}`
                : (candidate.prepared ? `已下载 · ${formatBytes(candidate.prepared.file.size)}` : new URL(candidate.url).host);
            addressRow.append(number, address);
            info.append(addressRow, host);
            if (candidate.error) {
                const error = document.createElement('span');
                error.className = 'web-import-error';
                error.textContent = candidate.error;
                info.append(error);
            }

            const actions = document.createElement('span');
            actions.className = 'web-import-row-actions';
            for (const [action, label] of [['up', '↑'], ['down', '↓'], ['remove', '删除']]) {
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = label;
                button.dataset.webAction = action;
                button.dataset.candidateId = candidate.id;
                button.disabled = activeJobType === 'webAnalyze' || activeJobType === 'webDownload'
                    || (action === 'up' && index === 0)
                    || (action === 'down' && index === webImportCandidates.length - 1);
                actions.append(button);
            }
            item.append(checkbox, preview, info, actions);
            item.addEventListener('dragstart', event => {
                webImportDragId = candidate.id;
                event.dataTransfer.effectAllowed = 'move';
            });
            item.addEventListener('dragover', event => {
                if (webImportDragId && webImportDragId !== candidate.id) {
                    event.preventDefault();
                }
            });
            item.addEventListener('drop', event => {
                event.preventDefault();
                moveWebImportCandidate(webImportDragId, index);
            });
            item.addEventListener('dragend', () => {
                webImportDragId = '';
            });
            list.append(item);
        });
        document.getElementById('webImportResults').hidden = webImportCandidates.length === 0;
        updateWebImportSummary();
    }

    function moveWebImportCandidate(id, targetIndex) {
        if (!id || activeJobType === 'webAnalyze' || activeJobType === 'webDownload') {
            return;
        }
        const sourceIndex = webImportCandidates.findIndex(candidate => candidate.id === id);
        if (sourceIndex < 0 || sourceIndex === targetIndex) {
            return;
        }
        const [candidate] = webImportCandidates.splice(sourceIndex, 1);
        webImportCandidates.splice(Math.max(0, Math.min(targetIndex, webImportCandidates.length)), 0, candidate);
        renderWebImportCandidates();
    }

    async function prepareWebCandidates(candidates, signal) {
        const selected = candidates.filter(candidate => candidate.selected && !candidate.duplicate);
        if (!selected.length) {
            return [];
        }
        const existingBytes = items.reduce((sum, item) => sum + item.file.size, 0);
        const preparedBytes = selectedWebCandidates().reduce(
            (sum, candidate) => sum + (candidate.prepared?.file.size || 0),
            0
        );
        const budget = { bytes: preparedBytes, limit: format.MAX_TOTAL_BYTES - existingBytes };
        if (budget.bytes > budget.limit) {
            throw new Error('漫画原图总体积不能超过 500 MiB');
        }
        const usedNames = new Set([
            ...items.map(item => item.file.name.toLowerCase()),
            ...webImportCandidates
                .filter(candidate => candidate.prepared)
                .map(candidate => candidate.prepared.file.name.toLowerCase())
        ]);
        let nextIndex = 0;
        let completed = selected.filter(candidate => candidate.prepared).length;
        setProgress(completed, selected.length);

        async function lane() {
            while (true) {
                const index = nextIndex++;
                if (index >= selected.length || signal.aborted) {
                    return;
                }
                const candidate = selected[index];
                if (candidate.prepared) {
                    continue;
                }
                candidate.error = '';
                candidate.loading = true;
                candidate.abortController = new AbortController();
                const abortCandidate = () => candidate.abortController?.abort();
                signal.addEventListener('abort', abortCandidate, { once: true });
                renderWebImportCandidates();
                try {
                    candidate.prepared = await downloadWebCandidate(
                        candidate,
                        webImportCandidates.indexOf(candidate),
                        candidate.abortController.signal,
                        budget,
                        usedNames
                    );
                    if (!candidate.selected) {
                        releasePreparedCandidate(candidate);
                    } else {
                        completed += 1;
                        setProgress(completed, selected.length);
                    }
                } catch (error) {
                    if (candidate.selected) {
                        candidate.error = error.name === 'AbortError' ? '已取消' : (error.message || '下载失败');
                    }
                } finally {
                    signal.removeEventListener('abort', abortCandidate);
                    candidate.abortController = null;
                    candidate.loading = false;
                    renderWebImportCandidates();
                }
            }
        }

        const laneCount = Math.min(selected.length, getComicParallelism());
        await Promise.all(Array.from({ length: laneCount }, lane));
        if (signal.aborted) {
            throw new DOMException('操作已取消', 'AbortError');
        }
        return selected.filter(candidate => candidate.selected && !candidate.prepared);
    }

    async function previewWebCandidates(candidates) {
        if (activeJobType && activeJobType !== 'webPreview') {
            return;
        }
        const selected = candidates.filter(candidate => candidate.selected && !candidate.duplicate && !candidate.prepared);
        if (!selected.length) {
            return;
        }
        if (activeJobType === 'webPreview') {
            return;
        }
        webImportAbortController = new AbortController();
        activeJobType = 'webPreview';
        setBusy(activeJobType);
        setStatus(`正在加载 ${selected.length} 张图片预览…`);
        try {
            let failures = await prepareWebCandidates(selected, webImportAbortController.signal);
            while (!webImportAbortController.signal.aborted) {
                const queued = selectedWebCandidates().filter(candidate => !candidate.prepared && !candidate.loading && !candidate.error);
                if (!queued.length) {
                    break;
                }
                failures = await prepareWebCandidates(queued, webImportAbortController.signal);
            }
            if (failures.length) {
                progressGroup.dataset.kind = 'error';
                setStatus(`${failures.length} 张图片预览失败；可以重试或取消勾选。`, 'error');
            } else {
                const ready = selectedWebCandidates().filter(candidate => candidate.prepared).length;
                setProgress(ready, Math.max(1, selectedWebCandidates().length), 'success');
                setStatus(`已加载 ${ready} 张图片预览。`, 'success');
            }
        } catch (error) {
            setStatus(error.name === 'AbortError' ? '网页图片预览已取消。' : (error.message || '网页图片预览失败'), error.name === 'AbortError' ? 'info' : 'error');
        } finally {
            activeJobType = '';
            webImportAbortController = null;
            setBusy('');
            renderWebImportCandidates();
            const queued = selectedWebCandidates().filter(candidate => !candidate.prepared && !candidate.loading && !candidate.error);
            if (queued.length) {
                root.queueMicrotask(() => previewWebCandidates(queued));
            }
        }
    }

    async function analyzeWebImport() {
        if (activeJobType) {
            return;
        }
        const rawUrl = document.getElementById('webImportUrl').value.trim();
        const url = webImportCore.normalizeHttpsUrl(rawUrl, rawUrl);
        if (!url) {
            setStatus('请输入有效的 HTTPS 网页链接', 'error');
            return;
        }
        resetArchiveAction();
        clearWebImportCandidates();
        webImportSessionId = nextJobId('web-session');
        webImportAbortController = new AbortController();
        activeJobType = 'webAnalyze';
        setBusy(activeJobType);
        setProgress(0, 1);
        setStatus('正在读取网页 HTML…');
        try {
            const result = await fetchHtmlForImport(url, webImportAbortController.signal);
            const elementCandidates = webImportCore.extractImageCandidates(result.html, result.finalUrl);
            const embeddedCandidates = webImportCore.extractEmbeddedImageCandidates(result.html, result.finalUrl);
            let extracted = webImportCore.selectBestCandidateSet(elementCandidates, embeddedCandidates);
            webImportFinalUrl = result.finalUrl;
            const maximumSelected = Math.max(0, format.MAX_PAGES - items.length);
            if (webImportCore.shouldCaptureRenderedPage(extracted, result.html)) {
                if (!maximumSelected) {
                    throw new Error('当前漫画已经没有可用页数');
                }
                setStatus(extracted.length
                    ? '检测到阅读器或少量预览图，正在隔离运行页面并收集完整页序…'
                    : '静态 HTML 没有图片，正在隔离运行页面并等待漫画内容加载…');
                try {
                    const captured = await captureRenderedPage(result.finalUrl, maximumSelected, webImportAbortController.signal);
                    const renderedCandidates = (captured.images || []).map(image => ({
                        url: `${captured.finalUrl || result.finalUrl}#dynamic-page-${image.index + 1}`,
                        duplicateOf: -1,
                        capturedIndex: Number(image.index),
                        capturedName: String(image.name || `page-${image.index + 1}.jpg`),
                        capturedMime: String(image.mime || ''),
                        capturedSize: Number(image.size) || 0
                    }));
                    if (renderedCandidates.length > extracted.filter(candidate => candidate.duplicateOf < 0).length) {
                        extracted = renderedCandidates;
                        webImportFinalUrl = captured.finalUrl || result.finalUrl;
                    } else {
                        releaseRenderedPageCapture();
                    }
                } catch (captureError) {
                    if (!extracted.length || captureError.name === 'AbortError') {
                        throw captureError;
                    }
                }
                if (!extracted.length) {
                    throw new Error('页面运行完成后仍未找到漫画图片');
                }
            }
            let selectedCount = 0;
            webImportCandidates = extracted.map((candidate, index) => {
                const duplicate = candidate.duplicateOf >= 0;
                const shouldSelect = !duplicate && selectedCount < maximumSelected;
                if (shouldSelect) {
                    selectedCount += 1;
                }
                return {
                    id: nextJobId('web-image'),
                    url: candidate.url,
                    transform: webImportCore.resolve18ComicTransform(result.finalUrl, candidate.url, result.html),
                    capturedIndex: Number.isInteger(candidate.capturedIndex) ? candidate.capturedIndex : -1,
                    capturedName: candidate.capturedName || '',
                    capturedMime: candidate.capturedMime || '',
                    capturedSize: candidate.capturedSize || 0,
                    duplicate,
                    selected: shouldSelect,
                    prepared: null,
                    loading: false,
                    error: '',
                    originalIndex: index
                };
            });
            renderWebImportCandidates();
            const selectedCandidates = selectedWebCandidates();
            if (!selectedCandidates.length) {
                setProgress(1, 1, 'success');
                setStatus('分析完成，但当前漫画已经没有可用页数。', 'info');
            } else {
                activeJobType = 'webPreview';
                setBusy(activeJobType);
                setStatus(`分析完成，正在自动加载 ${selectedCandidates.length} 张图片预览…`);
                const failures = await prepareWebCandidates(selectedCandidates, webImportAbortController.signal);
                if (failures.length) {
                    progressGroup.dataset.kind = 'error';
                    setStatus(`分析完成：已预览 ${selectedCandidates.length - failures.length} 张，${failures.length} 张失败。`, 'error');
                } else {
                    releaseRenderedPageCapture();
                    setProgress(selectedCandidates.length, selectedCandidates.length, 'success');
                    setStatus(`分析完成：已按网页顺序加载 ${selectedCandidates.length} 张图片预览。`, 'success');
                }
            }
        } catch (error) {
            resetProgress();
            setStatus(error.name === 'AbortError' ? '网页分析已取消。' : (error.message || '网页分析失败'), error.name === 'AbortError' ? 'info' : 'error');
        } finally {
            activeJobType = '';
            webImportAbortController = null;
            setBusy('');
            renderWebImportCandidates();
            const queued = selectedWebCandidates().filter(candidate => !candidate.prepared && !candidate.loading && !candidate.error);
            if (queued.length) {
                root.queueMicrotask(() => previewWebCandidates(queued));
            }
        }
    }

    async function downloadWebImport() {
        if (activeJobType) {
            return;
        }
        const selected = selectedWebCandidates();
        if (!selected.length) {
            setStatus('请先选择要加入漫画的网页图片', 'error');
            return;
        }
        if (items.length + selected.length > format.MAX_PAGES) {
            setStatus(`漫画最多包含 ${format.MAX_PAGES} 张图片`, 'error');
            return;
        }
        webImportAbortController = new AbortController();
        activeJobType = 'webDownload';
        setBusy(activeJobType);
        setStatus(selected.every(candidate => candidate.prepared)
            ? '正在把已预览图片加入漫画…'
            : '正在重试未完成的图片并加入漫画…');
        try {
            const failures = await prepareWebCandidates(selected, webImportAbortController.signal);
            if (failures.length) {
                setStatus(`${failures.length} 张图片预览失败；可重试，或取消勾选后继续。漫画列表尚未改变。`, 'error');
                progressGroup.dataset.kind = 'error';
                return;
            }
            const preparedItems = selected.map(candidate => {
                candidate.prepared.webImportSessionId = webImportSessionId;
                return candidate.prepared;
            });
            for (const candidate of selected) {
                candidate.prepared = null;
            }
            items.push(...preparedItems);
            webImportCandidates.forEach(releasePreparedCandidate);
            releaseRenderedPageCapture();
            webImportCandidates = [];
            webImportFinalUrl = '';
            renderFileList();
            updateSelectionSummary();
            document.getElementById('webImportResults').hidden = true;
            setProgress(selected.length, selected.length, 'success');
            setStatus(`已按网页顺序加入 ${selected.length} 张已勾选图片；未勾选项已清除。确认顺序后可加密并写入资产。`, 'success');
        } catch (error) {
            setStatus(error.name === 'AbortError' ? '网页图片下载已取消。' : (error.message || '网页图片下载失败'), error.name === 'AbortError' ? 'info' : 'error');
        } finally {
            activeJobType = '';
            webImportAbortController = null;
            setBusy('');
            renderWebImportCandidates();
        }
    }

    function updateSelectionSummary() {
        resetArchiveAction();
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
        if (item?.tempEntryName) {
            removeWebTemp(item.tempEntryName);
            item.tempEntryName = '';
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
        resetArchiveAction();
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
        resetArchiveAction();
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
        const prepared = new Array(selected.length);
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

            let nextIndex = 0;
            let firstError = null;
            async function prepareLane() {
                while (!firstError) {
                    const index = nextIndex++;
                    if (index >= selected.length) {
                        return;
                    }
                    try {
                        const detected = await validateSelectedFile(selected[index]);
                        prepared[index] = await prepareComicItem(selected[index], detected);
                    } catch (error) {
                        firstError = error;
                    }
                }
            }
            const laneCount = Math.min(selected.length, getComicParallelism());
            await Promise.all(Array.from({ length: laneCount }, prepareLane));
            if (firstError) {
                throw firstError;
            }
            items.push(...prepared);
            renderFileList();
            updateSelectionSummary();
            resetProgress();
            setStatus(`已加入 ${selected.length} 张图片，请拖动或使用箭头确认页面顺序。`, 'success');
        } catch (error) {
            prepared.filter(Boolean).forEach(revokeItem);
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
        worker.postMessage({
            type,
            jobId: activeJobId,
            payload: { ...payload, parallelism: getComicParallelism() }
        });
    }

    function getComicParallelism() {
        const cores = Math.max(1, Math.trunc(Number(root.navigator.hardwareConcurrency) || 2));
        return Math.max(1, Math.min(isMobileRuntime() ? 2 : 4, cores));
    }

    function isMobileRuntime() {
        const narrow = root.matchMedia?.('(max-width: 720px)').matches === true;
        const compactTouch = root.matchMedia?.('(pointer: coarse)').matches === true
            && root.matchMedia?.('(max-width: 1024px)').matches === true;
        return narrow || compactTouch;
    }

    function encryptComic() {
        if (items.length === 0) {
            setStatus('请先选择漫画图片', 'error');
            return;
        }
        resetArchiveAction();
        const rawName = document.getElementById('comicArchiveName').value.trim() || 'comic';
        const outputName = sanitizeDownloadName(rawName, format.EXTENSION).replace(/\.ecomic$/i, '');
        startJob('encrypt', '正在创建无损漫画归档…', {
            files: items.map(item => item.file),
            outputName
        });
    }

    function releaseSelectedArchiveTemp() {
        if (!selectedArchiveTempName || !worker) {
            selectedArchiveTempName = '';
            return;
        }
        worker.postMessage({
            type: 'releaseOutput',
            jobId: nextJobId('release-incoming'),
            payload: { opfsName: selectedArchiveTempName }
        });
        selectedArchiveTempName = '';
    }

    function selectArchiveFile(file, temporaryEntryName = '') {
        if (sessionId) {
            closeReaderSession();
        }
        releaseSelectedArchiveTemp();
        selectedArchive = null;
        if (!file) {
            setBusy(activeJobType);
            return false;
        }
        if (!/\.ecomic$/i.test(file.name)) {
            archiveInput.value = '';
            document.getElementById('comicArchiveMeta').textContent = '文件格式无效';
            setStatus('请选择 .ecomic 漫画归档', 'error');
            setBusy(activeJobType);
            if (temporaryEntryName) {
                worker.postMessage({
                    type: 'releaseOutput',
                    jobId: nextJobId('release-invalid-incoming'),
                    payload: { opfsName: temporaryEntryName }
                });
            }
            return false;
        }
        selectedArchive = file;
        selectedArchiveTempName = temporaryEntryName;
        document.getElementById('comicArchiveMeta').textContent = `${file.name} · ${formatBytes(file.size)}`;
        resetProgress();
        setStatus('漫画归档已选择，可以开始解密。');
        setBusy(activeJobType);
        return true;
    }

    function handleArchiveSelected() {
        selectArchiveFile(archiveInput.files && archiveInput.files[0]);
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
            startJob('open', '正在从独立漫画目录打开漫画…', { file: book.archiveFile });
            return;
        }
        startJob('historyOpen', '正在从本地资产打开漫画…', { bookId });
    }

    function downloadLongImageFile(file, name, opfsName = '', storageKind = '') {
        const output = captureOutput('longExport', {
            file,
            name,
            opfsName,
            storageKind
        }, 'image/png');
        const link = document.createElement('a');
        link.href = output.url;
        link.download = sanitizeDownloadName(name, 'comic-long.png');
        link.hidden = true;
        document.body.append(link);
        link.click();
        link.remove();
        if (!isAndroidRuntime) {
            scheduleOutputRelease('longExport');
        }
    }

    function exportHistoryArchive(bookId) {
        if (!bookId || activeJobType) {
            return;
        }
        const book = historyBooks.find(item => item.bookId === bookId);
        if (!book) {
            return;
        }
        if (book.archiveFile) {
            downloadOutput('historyArchive', {
                file: book.archiveFile,
                name: `${book.title.replace(/\.ecomic$/i, '')}.${format.EXTENSION}`
            }, `comic.${format.EXTENSION}`);
            setHistoryStatus(`正在导出《${book.title}》归档…`, 'success');
            return;
        }
        startJob('historyExportArchive', `正在加密《${book.title}》…`, { bookId });
    }

    function exportHistoryLongImage(bookId) {
        if (!bookId || activeJobType) {
            return;
        }
        const book = historyBooks.find(item => item.bookId === bookId);
        if (!book) {
            return;
        }
        if (book.longFile) {
            downloadLongImageFile(book.longFile, book.png?.name || `${book.title}-long.png`);
            setHistoryStatus(`正在导出《${book.title}》长图…`, 'success');
            return;
        }
        startJob('historyExportLongImage', `正在合并《${book.title}》长图…`, {
            bookId,
            file: book.archiveFile || null,
            outputName: book.title
        });
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
            if (!root.confirm(`确定删除独立漫画目录中的《${book.title}》吗？这会删除其中的 .ecomic、PNG 和封面文件，无法撤销。`)) {
                return;
            }
            try {
                if (currentHistoryBookId === bookId) {
                    closeReaderSession(false);
                }
                await deleteDirectoryBook(bookId);
                await removeHistoryMemberships(bookId);
                setHistoryStatus(`已从独立漫画目录删除《${book.title}》。`, 'success');
            } catch (error) {
                setHistoryStatus(`删除失败：${error.message}`, 'error');
            }
            return;
        }
        const deletePrompt = isAndroidRuntime
            ? `确定从应用资产删除《${book.title}》吗？原始页面、封面、元数据和阅读进度都会被删除，无法撤销。`
            : `确定从浏览器资产移除《${book.title}》吗？`;
        if (!root.confirm(deletePrompt)) {
            return;
        }
        const deleteExternal = external && root.confirm('这本漫画也保存在独立目录中。是否同时删除目录里的原件？\n\n选择“取消”只清理浏览器缓存，独立目录中的漫画仍会显示在资产中。');
        pendingDirectoryDeletion = { bookId, deleteExternal };
        startJob('historyDelete', '正在删除漫画…', { bookId });
    }

    async function requestClearHistory() {
        if (!historyBooks.length || activeJobType) {
            return;
        }
        if (!browserHistoryBooks.length) {
            if (!root.confirm('确定删除独立漫画目录中的全部漫画吗？其中的 .ecomic、PNG 和封面文件都会被删除，无法撤销。')) {
                return;
            }
            try {
                closeReaderSession(false);
                await deleteAllDirectoryBooks();
                await removeHistoryMemberships('*');
                setHistoryStatus('独立漫画目录已清空。', 'success');
            } catch (error) {
                setHistoryStatus(`清空失败：${error.message}`, 'error');
            }
            return;
        }
        const clearPrompt = isAndroidRuntime
            ? '确定清空应用漫画资产吗？全部漫画的原始页面、封面、元数据和阅读进度都会被删除，无法撤销。'
            : '确定清空当前浏览器中的全部漫画缓存吗？此操作无法撤销。';
        if (!root.confirm(clearPrompt)) {
            return;
        }
        const deleteExternal = directoryBooks.length > 0 && root.confirm('是否同时删除独立漫画目录中的全部漫画原件？\n\n选择“取消”只清理浏览器缓存，目录中的漫画仍会显示在资产中。');
        pendingDirectoryDeletion = { bookId: '*', deleteExternal };
        startJob('historyDelete', '正在清空漫画资产…', { bookId: '*' });
    }

    function showReaderNotice(message) {
        clearTimeout(readerNoticeTimer);
        readerNotice.textContent = message;
        readerNotice.hidden = false;
        readerNoticeTimer = root.setTimeout(() => {
            readerNotice.hidden = true;
        }, 2600);
    }

    function defaultReaderHeaderCollapsed() {
        return isMobileRuntime();
    }

    function readReaderHeaderPreference() {
        try {
            const stored = root.localStorage.getItem(READER_HEADER_STORAGE_KEY);
            if (stored === 'true' || stored === 'false') {
                return stored === 'true';
            }
        } catch (error) {
            // Opaque file origins may reject localStorage; keep the responsive default.
        }
        return defaultReaderHeaderCollapsed();
    }

    function restoreReaderViewport(position) {
        if (!position || !readerPages.length) {
            return;
        }
        const index = Math.max(0, Math.min(readerPages.length - 1, position.pageIndex));
        const target = reader.querySelector(`[data-reader-index="${index}"]`);
        if (target) {
            const targetTop = target.offsetTop - reader.offsetTop;
            reader.scrollTop = targetTop + target.offsetHeight * position.pageRatio;
            updateReaderWindow(index);
        }
    }

    function setReaderHeaderCollapsed(collapsed, persist = false, preservePosition = true) {
        const position = preservePosition && readerPages.length ? getReaderProgress() : null;
        clearTimeout(readerHeaderRestoreTimer);
        readerHeaderCollapsed = !!collapsed;
        readerDialog.dataset.headerCollapsed = String(readerHeaderCollapsed);
        const header = readerDialog.querySelector('.comic-reader-header');
        const collapsedActions = document.getElementById('comicReaderCollapsedActions');
        const collapseButton = document.getElementById('collapseComicReaderHeaderButton');
        const expandedCloseButton = document.getElementById('closeComicReaderButton');
        const expandButton = document.getElementById('expandComicReaderHeaderButton');
        const collapsedCloseButton = document.getElementById('closeCollapsedComicReaderButton');
        collapseButton.setAttribute('aria-expanded', String(!readerHeaderCollapsed));
        expandButton.setAttribute('aria-expanded', String(!readerHeaderCollapsed));
        header.setAttribute('aria-hidden', String(readerHeaderCollapsed));
        collapsedActions.setAttribute('aria-hidden', String(!readerHeaderCollapsed));
        header.inert = readerHeaderCollapsed;
        collapseButton.tabIndex = readerHeaderCollapsed ? -1 : 0;
        expandedCloseButton.tabIndex = readerHeaderCollapsed ? -1 : 0;
        expandButton.tabIndex = readerHeaderCollapsed ? 0 : -1;
        collapsedCloseButton.tabIndex = readerHeaderCollapsed ? 0 : -1;
        if (persist) {
            try {
                root.localStorage.setItem(READER_HEADER_STORAGE_KEY, String(readerHeaderCollapsed));
            } catch (error) {
                // The UI state still applies for this session when storage is unavailable.
            }
        }
        if (position) {
            readerHeaderRestoreTimer = root.setTimeout(() => {
                readerHeaderRestoreTimer = 0;
                requestAnimationFrame(() => restoreReaderViewport(position));
            }, 210);
        }
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
        const focusTarget = readerHeaderCollapsed
            ? document.getElementById('closeCollapsedComicReaderButton')
            : document.getElementById('closeComicReaderButton');
        focusTarget.focus({ preventScroll: true });
    }

    function closeReaderDialog(restoreFocus = true) {
        clearTimeout(readerHeaderRestoreTimer);
        readerHeaderRestoreTimer = 0;
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
        worker.postMessage({
            type: 'page',
            jobId,
            payload: { sessionId, index, parallelism: getComicParallelism() }
        });
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

    function saveCurrentSessionToHistory() {
        if (!sessionId) {
            return;
        }
        if (activeJobType) {
            return;
        }
        const historyBook = historyBooks.find(book => book.bookId === currentHistoryBookId);
        const outputName = (historyBook?.title || selectedArchive?.name || 'comic').replace(/\.ecomic$/i, '');
        startJob('historySave', '正在把原始页面和封面加入资产…', {
            sessionId,
            outputName,
            sourceName: selectedArchive?.name || ''
        });
        showReaderNotice('正在保存原始页面和封面；长图只在点击导出时生成。');
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
            const sectionTop = section.offsetTop - reader.offsetTop;
            if (sectionTop <= top + 2) {
                selected = section;
            } else {
                break;
            }
        }
        const pageIndex = Number(selected?.dataset.readerIndex) || 0;
        const selectedTop = selected ? selected.offsetTop - reader.offsetTop : 0;
        const pageRatio = selected?.offsetHeight
            ? Math.max(0, Math.min(1, (top - selectedTop) / selected.offsetHeight))
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
            const usage = Number(message.usage);
            const quota = Number(message.quota);
            const used = Number.isFinite(usage) && usage >= 0 ? formatBytes(usage) : '未知';
            const remaining = Number.isFinite(quota) && quota > 0 && Number.isFinite(usage)
                ? formatBytes(Math.max(0, quota - usage))
                : '未知';
            document.getElementById('historyStorageSummary').textContent = `已使用 ${used} · 剩余 ${remaining}`;
            return;
        }
        if (message.type === 'historyArchiveReady' && message.jobId === activeJobId) {
            activeJobId = '';
            setBusy('');
            downloadOutput('historyArchive', message, `comic.${format.EXTENSION}`);
            setHistoryStatus(`《${message.name.replace(/\.ecomic$/i, '')}》已加密，正在打开保存位置…`, 'success');
            requestHistoryList();
            return;
        }
        if (message.type === 'historyLongImageReady' && message.jobId === activeJobId) {
            activeJobId = '';
            setBusy('');
            downloadLongImageFile(message.file, message.name, message.opfsName, message.storageKind);
            setHistoryStatus(`正在导出《${message.title}》长图…`, 'success');
            requestHistoryList();
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
                await removeHistoryMemberships(message.bookId);
                setHistoryStatus(deletion?.deleteExternal
                    ? '浏览器缓存和独立目录原件均已删除。'
                    : (isAndroidRuntime
                        ? (message.count ? '应用漫画资产已删除。' : '这本漫画已不在应用资产中。')
                        : (message.count ? '浏览器缓存已删除，独立目录原件已保留。' : '这本漫画已不在浏览器缓存中。')), 'success');
            } catch (error) {
                setHistoryStatus(`浏览器缓存已删除，但目录原件删除失败：${error.message}`, 'error');
            }
            requestHistoryList();
            return;
        }
        if (message.type === 'progress' && message.jobId === activeJobId) {
            setProgress(message.processed, message.total);
            setStatus(`${message.message}… ${progressText.textContent}`);
            if (activeJobType === 'historyExportLongImage') {
                showReaderNotice(`${message.message}… ${progressText.textContent}`);
            }
            return;
        }
        if (message.type === 'page') {
            showReaderPage(message);
            return;
        }
        if (message.type === 'archiveReady' && message.jobId === activeJobId) {
            prepareArchiveDownload(message);
            pendingArchiveForDirectory = { file: message.file, name: message.name };
            setStatus(`漫画归档已生成：${message.pages} 页 · ${formatBytes(message.size)}。正在保存原始页面和封面…`, 'success');
            setHistoryStatus('正在把本次上传的原始页面加入资产…');
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
                setHistoryStatus('已从独立漫画目录打开漫画。', 'success');
            } else if (message.bookId) {
                setHistoryStatus('已从本地资产恢复高清阅读。', 'success');
                requestHistoryList();
            } else {
                setStatus('漫画归档验证成功，正在保存原始页面和封面。', 'success');
            }
            activeJobId = '';
            setBusy('');
            if (shouldConvertArchive) {
                saveCurrentSessionToHistory();
            }
            return;
        }
        if (message.type === 'historySaved' && message.jobId === activeJobId) {
            const completedJobType = activeJobType;
            setProgress(1, 1, 'success');
            setStatus(`漫画已加入资产：${message.pages} 页 · ${formatBytes(message.size)}。`, 'success');
            showReaderNotice('原始页面和封面已保存；长图将在导出时生成。');
            const existingDirectoryBook = directoryBooks.find(book => book.bookId === message.bookId);
            const directoryBook = message.book
                || historyBooks.find(book => book.bookId === message.bookId)
                || existingDirectoryBook;
            if (message.book && !directoryPermissionGranted) {
                browserHistoryBooks = [message.book, ...browserHistoryBooks.filter(book => book.bookId !== message.bookId)];
                mergeHistorySources();
            }
            if (directoryPermissionGranted && message.bookId && directoryBook) {
                try {
                    await syncBookToDirectory(directoryBook, {
                        archiveFile: pendingArchiveForDirectory?.file
                            || existingDirectoryBook?.archiveFile
                            || selectedArchive,
                        coverFile: message.coverFile || existingDirectoryBook?.coverFile || directoryBook.coverFile
                    });
                    setHistoryStatus(`已加入独立漫画目录“${libraryDirectoryHandle.name}”。`, 'success');
                } catch (error) {
                    setDirectorySummary(`漫画已保存到浏览器，但目录写入失败：${error.message}`, 'error');
                }
            }
            pendingArchiveForDirectory = null;
            if (message.bookId) {
                currentHistoryBookId = message.bookId;
                if (!directoryPermissionGranted) {
                    setHistoryStatus(isAndroidRuntime
                        ? '已加入应用资产。'
                        : '已加入浏览器资产。连接独立目录后可获得可迁移备份。', 'success');
                }
                requestHistoryList();
            }
            if (completedJobType === 'encrypt') {
                releaseOutput('archive');
                revealSavedComic(message.bookId);
            }
            if (completedJobType === 'historySave') {
                releaseSelectedArchiveTemp();
            }
            activeJobId = '';
            setBusy('');
            if (completedJobType === 'encrypt') {
                revealSavedComic(message.bookId);
            }
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
                openingDirectoryBookId = '';
                pendingArchiveForDirectory = null;
                pendingDirectoryDeletion = null;
                if (cancelledType === 'historyArchive') {
                    migrationQueue = [];
                    migrationCurrentBook = null;
                    setHistoryStatus('漫画资产迁移已取消。');
                } else if (cancelledType === 'historyExportArchive') {
                    setHistoryStatus('已取消导出 .ecomic。');
                } else if (cancelledType === 'historyExportLongImage') {
                    setHistoryStatus('已取消导出长图。');
                } else if (cancelledType === 'historySave') {
                    setHistoryStatus('已取消加入资产。');
                }
                if (cancelledType === 'open' || cancelledType === 'historySave') {
                    releaseSelectedArchiveTemp();
                }
                setBusy('');
                resetProgress();
                setStatus(archiveWasCreated
                    ? '漫画归档已生成，加入资产的后续处理已取消；仍可下载 .ecomic。'
                    : '操作已取消。');
                if (archiveWasCreated) {
                    revealArchiveDownload();
                }
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
                activeJobId = '';
                openingDirectoryBookId = '';
                pendingArchiveForDirectory = null;
                pendingDirectoryDeletion = null;
                if (failedType === 'historyArchive') {
                    migrationQueue = [];
                    migrationCurrentBook = null;
                    setHistoryStatus(`迁移失败：${message.message || '未知错误'}`, 'error');
                } else if (failedType === 'historyExportArchive') {
                    setHistoryStatus(`导出 .ecomic 失败：${message.message || '未知错误'}`, 'error');
                } else if (failedType === 'historyExportLongImage') {
                    setHistoryStatus(`导出长图失败：${message.message || '未知错误'}`, 'error');
                } else if (failedType === 'historySave') {
                    setHistoryStatus(`加入资产失败：${message.message || '未知错误'}`, 'error');
                }
                if (failedType === 'open' || failedType === 'historySave') {
                    releaseSelectedArchiveTemp();
                }
                setBusy('');
                progressGroup.dataset.kind = 'error';
                setStatus(archiveWasCreated
                    ? `漫画归档已生成，但加入资产失败：${message.message || '未知错误'}。仍可下载 .ecomic。`
                    : (message.message || '漫画处理失败'), 'error');
                if (archiveWasCreated) {
                    revealArchiveDownload();
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

    function startWorker(reopenBookId = '', aggressiveCleanup = false) {
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
            setStatus('漫画后台已重新启动，正在恢复资产阅读…');
            root.setTimeout(() => {
                startWorker(recoverBookId, false);
                recoveringWorker = false;
            }, 100);
        });
        worker.postMessage({
            type: 'cleanup',
            jobId: nextJobId('cleanup'),
            payload: { aggressive: aggressiveCleanup }
        });
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

        if (isAndroidRuntime) {
            document.getElementById('historyDirectoryPanel').hidden = true;
            document.getElementById('historyDescription').textContent = '资产保存在应用私有数据中；覆盖更新会保留，清除应用数据或卸载会删除。';
            document.getElementById('historyEmptyDescription').textContent = '加密图片或打开 `.ecomic` 后，漫画会自动加入应用资产。';
        }
        loadHistoryGroupState().catch(error => {
            setHistoryStatus(error.message || '漫画文件夹读取失败。', 'error');
        });
        startWorker('', true);
        if (!isAndroidRuntime) {
            restoreLibraryDirectory();
        }
        setReaderHeaderCollapsed(readReaderHeaderPreference(), false, false);
        setStatus(location.protocol === 'file:'
            ? '本地漫画模式已就绪。图片将按列表顺序无损封装。'
            : '漫画模式已就绪。图片将按列表顺序无损封装。');
        setBusy('');
    }

    comicFilesInput.addEventListener('change', handleFilesSelected);
    archiveInput.addEventListener('change', handleArchiveSelected);
    document.getElementById('localComicSourceButton').addEventListener('click', () => {
        document.getElementById('localComicSourcePanel').hidden = false;
        document.getElementById('webComicSourcePanel').hidden = true;
        document.getElementById('localComicSourceButton').classList.add('is-active');
        document.getElementById('localComicSourceButton').setAttribute('aria-pressed', 'true');
        document.getElementById('webComicSourceButton').classList.remove('is-active');
        document.getElementById('webComicSourceButton').setAttribute('aria-pressed', 'false');
        document.getElementById('appModeBadge').textContent = '本地处理';
    });
    document.getElementById('webComicSourceButton').addEventListener('click', () => {
        document.getElementById('localComicSourcePanel').hidden = true;
        document.getElementById('webComicSourcePanel').hidden = false;
        document.getElementById('webComicSourceButton').classList.add('is-active');
        document.getElementById('webComicSourceButton').setAttribute('aria-pressed', 'true');
        document.getElementById('localComicSourceButton').classList.remove('is-active');
        document.getElementById('localComicSourceButton').setAttribute('aria-pressed', 'false');
        document.getElementById('appModeBadge').textContent = '网页导入需联网';
        document.getElementById('webImportUrl').focus();
    });
    document.getElementById('analyzeWebImportButton').addEventListener('click', analyzeWebImport);
    document.getElementById('clearWebImportUrlButton').addEventListener('click', clearWebImportSession);
    document.getElementById('webImportUrl').addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            analyzeWebImport();
        }
    });
    document.getElementById('downloadWebImportButton').addEventListener('click', downloadWebImport);
    document.getElementById('clearWebImportButton').addEventListener('click', () => clearWebImportCandidates('网页分析结果已清除。'));
    document.getElementById('webImportSelectionMenuButton').addEventListener('click', event => {
        event.stopPropagation();
        const menu = document.getElementById('webImportSelectionMenu');
        const willOpen = menu.hidden;
        menu.hidden = !willOpen;
        event.currentTarget.setAttribute('aria-expanded', String(willOpen));
    });
    document.getElementById('webImportSelectionMenu').addEventListener('click', event => {
        const button = event.target.closest('button[data-web-selection]');
        if (!button) {
            return;
        }
        applyWebImportSelection(button.dataset.webSelection);
        closeWebImportSelectionMenu();
        document.getElementById('webImportSelectionMenuButton').focus();
    });
    document.getElementById('webImportList').addEventListener('click', event => {
        const button = event.target.closest('button[data-web-action]');
        if (!button || activeJobType === 'webAnalyze' || activeJobType === 'webDownload') {
            return;
        }
        const index = webImportCandidates.findIndex(candidate => candidate.id === button.dataset.candidateId);
        if (index < 0) {
            return;
        }
        if (button.dataset.webAction === 'up') {
            moveWebImportCandidate(button.dataset.candidateId, index - 1);
        } else if (button.dataset.webAction === 'down') {
            moveWebImportCandidate(button.dataset.candidateId, index + 1);
        } else if (button.dataset.webAction === 'remove') {
            webImportCandidates[index].selected = false;
            releasePreparedCandidate(webImportCandidates[index]);
            webImportCandidates.splice(index, 1);
            renderWebImportCandidates();
        }
    });
    document.addEventListener('click', event => {
        if (!event.target.closest('.web-import-selection-menu')) {
            closeWebImportSelectionMenu();
        }
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !document.getElementById('webImportSelectionMenu').hidden) {
            closeWebImportSelectionMenu();
            document.getElementById('webImportSelectionMenuButton').focus();
        }
    });
    document.getElementById('comicFilesPicker').addEventListener('keydown', event => activateFilePicker(event, comicFilesInput));
    document.getElementById('comicArchiveFilePicker').addEventListener('keydown', event => activateFilePicker(event, archiveInput));
    document.getElementById('encryptComicButton').addEventListener('click', encryptComic);
    document.getElementById('viewSavedComicButton').addEventListener('click', () => {
        if (!savedComicBookId) return;
        root.EcrypteesImageAssetsUI && document.getElementById('assetTypeComicButton').click();
        document.getElementById('historyTab').click();
        root.setTimeout(() => openHistoryBook(savedComicBookId, false), 0);
    });
    document.getElementById('comicArchiveName').addEventListener('input', () => resetArchiveAction());
    document.getElementById('downloadComicArchive').addEventListener('click', event => {
        if (event.currentTarget.getAttribute('aria-disabled') === 'true') {
            event.preventDefault();
            return;
        }
        if (!isAndroidRuntime) {
            scheduleOutputRelease('archive', true);
        }
    });
    document.getElementById('clearComicFilesButton').addEventListener('click', clearItems);
    document.getElementById('openComicButton').addEventListener('click', openComic);
    document.getElementById('closeComicReaderButton').addEventListener('click', () => closeReaderDialog());
    document.getElementById('closeCollapsedComicReaderButton').addEventListener('click', () => closeReaderDialog());
    document.getElementById('collapseComicReaderHeaderButton').addEventListener('click', () => {
        setReaderHeaderCollapsed(true, true);
        document.getElementById('expandComicReaderHeaderButton').focus({ preventScroll: true });
    });
    document.getElementById('expandComicReaderHeaderButton').addEventListener('click', () => {
        setReaderHeaderCollapsed(false, true);
        document.getElementById('collapseComicReaderHeaderButton').focus({ preventScroll: true });
    });
    readerDialog.addEventListener('cancel', event => {
        event.preventDefault();
        closeReaderDialog();
    });
    document.getElementById('cancelComicButton').addEventListener('click', () => {
        if ((activeJobType === 'webAnalyze' || activeJobType === 'webPreview' || activeJobType === 'webDownload') && webImportAbortController) {
            webImportAbortController.abort();
            setStatus('正在取消网页导入…');
            return;
        }
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
        } else if (historyAction === 'exportArchive') {
            exportHistoryArchive(bookId);
        } else if (historyAction === 'exportLong') {
            exportHistoryLongImage(bookId);
        } else if (historyAction === 'menu') {
            openHistoryBookMenu(bookId);
        } else if (historyAction === 'delete') {
            requestDeleteHistoryBook(bookId);
        }
    });
    document.getElementById('historyGroupFilterSelect').addEventListener('change', event => {
        selectedHistoryGroup = event.currentTarget.value;
        document.getElementById('historyViewMenu').open = false;
        renderHistory();
    });
    document.getElementById('addHistoryFolderButton').addEventListener('click', () => openHistoryFolderDialog());
    document.getElementById('historyMenuCancelButton').addEventListener('click', () => {
        closeHistoryDialog(document.getElementById('historyBookMenuDialog'));
        activeHistoryMenuBookId = '';
    });
    document.getElementById('historyMenuRenameButton').addEventListener('click', () => {
        const bookId = activeHistoryMenuBookId;
        closeHistoryDialog(document.getElementById('historyBookMenuDialog'));
        activeHistoryMenuBookId = '';
        renameHistoryBook(bookId);
    });
    document.getElementById('historyMenuGroupButton').addEventListener('click', () => {
        const bookId = activeHistoryMenuBookId;
        closeHistoryDialog(document.getElementById('historyBookMenuDialog'));
        openHistoryGroupDialog(bookId);
    });
    document.getElementById('historyFolderCancelButton').addEventListener('click', () => {
        closeHistoryDialog(document.getElementById('historyFolderDialog'));
        folderAssignmentBookId = '';
    });
    document.getElementById('historyFolderForm').addEventListener('submit', async event => {
        event.preventDefault();
        const input = document.getElementById('historyFolderName');
        const error = document.getElementById('historyFolderError');
        try {
            const bookId = folderAssignmentBookId;
            const group = await createHistoryGroup(input.value, bookId);
            folderAssignmentBookId = '';
            closeHistoryDialog(document.getElementById('historyFolderDialog'));
            selectedHistoryGroup = group.groupId;
            renderHistory();
            setHistoryStatus(bookId ? `已创建“${group.name}”并加入漫画。` : `已创建文件夹“${group.name}”。`, 'success');
        } catch (createError) {
            error.textContent = createError.message || '文件夹创建失败。';
            error.hidden = false;
            input.focus();
        }
    });
    document.getElementById('historyGroupCancelButton').addEventListener('click', () => {
        closeHistoryDialog(document.getElementById('historyGroupDialog'));
        activeHistoryMenuBookId = '';
    });
    document.getElementById('historyGroupCreateFolderButton').addEventListener('click', () => {
        const bookId = activeHistoryMenuBookId;
        closeHistoryDialog(document.getElementById('historyGroupDialog'));
        activeHistoryMenuBookId = '';
        openHistoryFolderDialog(bookId);
    });
    document.getElementById('historyGroupForm').addEventListener('submit', async event => {
        event.preventDefault();
        const bookId = activeHistoryMenuBookId;
        const groupId = document.getElementById('historyGroupSelect').value;
        try {
            await setHistoryBookGroup(bookId, groupId);
            closeHistoryDialog(document.getElementById('historyGroupDialog'));
            activeHistoryMenuBookId = '';
            const groupName = historyGroups.find(group => group.groupId === groupId)?.name || '未分组';
            setHistoryStatus(`《${historyBooks.find(book => book.bookId === bookId)?.title || '漫画'}》已移至“${groupName}”。`, 'success');
        } catch (groupError) {
            setHistoryStatus(groupError.message || '漫画分组保存失败。', 'error');
        }
    });
    document.getElementById('clearHistoryButton').addEventListener('click', requestClearHistory);
    document.getElementById('selectHistoryDirectoryButton').addEventListener('click', connectLibraryDirectory);
    document.getElementById('migrateHistoryButton').addEventListener('click', migrateCurrentShelf);
    document.getElementById('historySearch').addEventListener('input', renderHistory);
    document.getElementById('historySort').addEventListener('change', () => {
        document.getElementById('assetSortMenu').open = false;
        renderHistory();
    });
    document.getElementById('historyGoToComicButton').addEventListener('click', () => document.getElementById('comicTab').click());
    document.getElementById('historyTab').addEventListener('click', requestHistoryList);
    root.addEventListener('pageshow', () => requestHistoryList());
    root.addEventListener('pagehide', () => {
        webImportAbortController?.abort();
        releaseRenderedPageCapture();
        for (const token of activeRemoteFetchTokens) {
            try {
                androidNetwork?.cancelRemoteFetch(token);
            } catch (error) {
                // Native cleanup also runs when the Activity is destroyed.
            }
        }
    });
    document.addEventListener('ecryptees-open-archive', event => {
        const detail = event.detail || {};
        const file = detail.file;
        const temporaryEntryName = String(detail.opfsName || '');
        if (!(file instanceof Blob) || !temporaryEntryName) {
            return;
        }
        if (activeJobType) {
            worker.postMessage({
                type: 'releaseOutput',
                jobId: nextJobId('release-busy-incoming'),
                payload: { opfsName: temporaryEntryName }
            });
            setStatus('当前任务正在处理，请稍后重新打开 .ecomic。', 'error');
            return;
        }
        archiveInput.value = '';
        document.getElementById('comicTab').click();
        if (selectArchiveFile(file, temporaryEntryName)) {
            setStatus(`正在打开 ${file.name}…`);
            openComic();
        }
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            saveReaderProgressNow();
        }
    });
    document.addEventListener('ecryptees-download-result', event => {
        const detail = event.detail || {};
        const kind = Object.keys(outputState).find(key => outputState[key].url === detail.url);
        if (!kind) {
            return;
        }
        const succeeded = detail.status === 'success';
        const cancelled = detail.status === 'cancelled';
        if (kind === 'archive') {
            resetArchiveAction();
            setStatus(succeeded
                ? `${detail.name || '漫画归档'} 已保存。`
                : (cancelled ? '已取消保存漫画归档。' : '漫画归档保存失败，请重新加密后再试。'),
            succeeded ? 'success' : (cancelled ? 'info' : 'error'));
        } else {
            releaseOutput(kind);
            setHistoryStatus(succeeded
                ? `${detail.name || '文件'} 已保存。`
                : (cancelled ? '已取消保存。' : '文件保存失败，请检查剩余空间后重试。'),
            succeeded ? 'success' : (cancelled ? 'info' : 'error'));
        }
        requestHistoryList();
    });
    root.addEventListener('beforeunload', () => {
        items.forEach(revokeItem);
        releaseSelectedArchiveTemp();
        Object.keys(outputState).forEach(releaseOutput);
        readerPages.forEach(page => {
            if (page.url) {
                URL.revokeObjectURL(page.url);
            }
        });
        releaseHistoryCovers();
        worker?.terminate();
    });

    const securityGate = root.EcrypteesAppSecurity?.whenUnlocked || Promise.resolve();
    securityGate.then(initialize).catch(error => {
        console.error('应用解锁后初始化漫画功能失败', error);
    });
})(globalThis);
