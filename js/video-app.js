(function (root) {
    'use strict';

    const video = root.Ecryptees?.video;
    const store = root.EcrypteesVideoAssets;
    const core = root.Ecryptees?.core;
    const assetCenter = root.EcrypteesAssetCenter;
    const assetStorage = root.EcrypteesAssetStorage;
    const desktopStorage = root.EcrypteesDesktopStorage?.available ? root.EcrypteesDesktopStorage : null;
    if (!video || !store || !core || !assetCenter || !assetStorage) return;

    const { format, crypto: videoCrypto, VideoError } = video;
    const { formatBytes, sanitizeDownloadName } = core.utils;
    const builtinVideoKeySource = new TextEncoder().encode(core.config.imageCodebook.join(''));
    const FILE_COMPATIBILITY_MAX_BYTES = 512 * 1024 * 1024;
    const CONTENT_ID_PREFIX = new TextEncoder().encode('Ecryptees video content v1\0');
    let worker = null;
    const panel = document.getElementById('historyPanel');
    const grid = document.getElementById('historyGrid');
    const status = document.getElementById('historyStatus');
    const playerDialog = document.getElementById('videoPlayerDialog');
    const player = document.getElementById('videoAssetPlayer');
    const playerShell = document.getElementById('videoPlayerShell');
    const playerStage = document.getElementById('videoPlayerStage');
    const episodeDrawer = document.getElementById('videoEpisodeDrawer');
    let active = false;
    let busy = false;
    let taskSequence = 0;
    let activeTask = null;
    let selectedSource = null;
    let selectedArchive = null;
    let selectedIncomingOpfsName = '';
    let assets = [];
    let folders = [];
    let memberships = new Map();
    let selectedFolder = 'all';
    let selectedAssetId = '';
    let currentContext = null;
    let playbackKind = '';
    let playbackBlobUrl = '';
    let outputUrl = '';
    const legacyMigrationAttempts = new Set();
    const recentlySavedAssets = new Map();
    let refreshSequence = 0;
    let missingAssetIds = new Set();
    let exportProgressValue = 0;
    let progressSaveTimer = 0;
    let wakeLock = null;
    let androidPlaybackActive = false;
    let pageTaskCancelled = false;
    let exporting = false;
    let selectedEpisodeFolder = 'all';
    let episodeDrawerOpen = false;
    let playerSwitching = false;
    let controlsHideTimer = 0;
    let timelineDragging = false;
    let playerGesture = null;
    let sheetGesture = null;

    function setStatus(message, kind = 'info') {
        status.textContent = message || '';
        status.dataset.kind = kind;
    }

    function setVideoStatus(message, kind = 'info') {
        const element = document.getElementById('videoStatus');
        element.textContent = message || '';
        element.dataset.kind = kind;
    }

    function setPlayerStatus(message) {
        document.getElementById('videoPlayerStatus').textContent = message || '';
    }

    function formatDuration(seconds) {
        const value = Math.max(0, Number(seconds) || 0);
        const hours = Math.floor(value / 3600);
        const minutes = Math.floor(value % 3600 / 60);
        const remainder = Math.floor(value % 60);
        return hours > 0
            ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
            : `${minutes}:${String(remainder).padStart(2, '0')}`;
    }

    function isLandscapePlayer() {
        return Boolean(document.fullscreenElement)
            || root.matchMedia?.('(orientation: landscape)').matches;
    }

    function updatePlayerTitle(title) {
        const element = document.getElementById('videoPlayerTitle');
        const text = document.getElementById('videoPlayerTitleText');
        text.textContent = title || '视频';
        element.classList.remove('is-overflowing');
        root.requestAnimationFrame(() => {
            element.classList.toggle('is-overflowing', text.scrollWidth > element.clientWidth + 8);
        });
    }

    function updatePlayerControls() {
        const duration = Number.isFinite(player.duration) && player.duration > 0 ? player.duration : 0;
        const currentTime = Math.max(0, Number(player.currentTime) || 0);
        document.getElementById('videoElapsedTime').textContent = formatDuration(currentTime);
        document.getElementById('videoDurationTime').textContent = formatDuration(duration);
        if (!timelineDragging) {
            document.getElementById('videoTimeline').value = duration > 0
                ? String(Math.round(currentTime / duration * 1000))
                : '0';
        }
        const paused = player.paused || player.ended;
        const label = paused ? '播放视频' : '暂停视频';
        const glyph = paused ? '▶' : 'Ⅱ';
        for (const id of ['videoPlayPauseButton', 'videoCenterPlayButton']) {
            const button = document.getElementById(id);
            button.textContent = glyph;
            button.setAttribute('aria-label', label);
        }
        document.getElementById('videoCenterPlayButton').hidden = !paused;
        const muteButton = document.getElementById('videoMuteButton');
        muteButton.textContent = player.muted || player.volume === 0 ? '静音' : '音量';
        muteButton.setAttribute('aria-label', player.muted || player.volume === 0 ? '恢复声音' : '静音');
    }

    function setPlayerControlsVisible(visible, scheduleHide = true) {
        clearTimeout(controlsHideTimer);
        controlsHideTimer = 0;
        playerShell.dataset.controlsVisible = String(Boolean(visible));
        if (visible && scheduleHide && isLandscapePlayer() && !player.paused && !episodeDrawerOpen) {
            controlsHideTimer = root.setTimeout(() => {
                playerShell.dataset.controlsVisible = 'false';
            }, 3200);
        }
    }

    function togglePlayerMoreMenu(force) {
        const menu = document.getElementById('videoPlayerMoreMenu');
        const open = force === undefined ? menu.hidden : Boolean(force);
        menu.hidden = !open;
        document.getElementById('videoMoreButton').setAttribute('aria-expanded', String(open));
        setPlayerControlsVisible(true, !open);
    }

    function togglePlayback() {
        if (!player.src) return;
        if (player.paused || player.ended) {
            player.play().catch(error => setPlayerStatus(error.message || '无法开始播放'));
        } else {
            player.pause();
        }
    }

    function setProgress(processed, total, message = '') {
        const percentage = total > 0 ? Math.min(100, Math.round(processed / total * 100)) : 0;
        document.getElementById('videoProgressGroup').hidden = false;
        document.getElementById('videoProgress').value = percentage;
        document.getElementById('videoProgressText').textContent = `${percentage}%`;
        if (message) setVideoStatus(message);
    }

    function resetProgress() {
        document.getElementById('videoProgressGroup').hidden = true;
        document.getElementById('videoProgress').value = 0;
        document.getElementById('videoProgressText').textContent = '0%';
    }

    function openExportProgress(title, total) {
        exportProgressValue = 0;
        document.getElementById('videoExportProgressTitle').textContent = `正在导出《${title}》`;
        document.getElementById('videoExportProgressPhase').textContent = '正在准备临时 .emp4…';
        document.getElementById('videoExportProgress').value = 0;
        document.getElementById('videoExportProgressPercent').textContent = '0%';
        document.getElementById('videoExportProgressBytes').textContent = `0 B / ${formatBytes(total)}`;
        document.getElementById('cancelVideoExportButton').disabled = false;
        const dialog = document.getElementById('videoExportProgressDialog');
        if (!dialog.open) dialog.showModal();
    }

    function updateExportProgress(processed, total, message = '') {
        const percentage = total > 0 ? Math.min(100, Math.round(processed / total * 100)) : 0;
        exportProgressValue = Math.max(exportProgressValue, percentage);
        document.getElementById('videoExportProgress').value = exportProgressValue;
        document.getElementById('videoExportProgressPercent').textContent = `${exportProgressValue}%`;
        document.getElementById('videoExportProgressBytes').textContent = `${formatBytes(processed)} / ${formatBytes(total)}`;
        if (message) document.getElementById('videoExportProgressPhase').textContent = message;
    }

    function closeExportProgress() {
        const dialog = document.getElementById('videoExportProgressDialog');
        if (dialog.open) dialog.close();
    }

    function setBusy(value) {
        busy = Boolean(value);
        for (const id of [
            'videoSourceFile', 'videoArchiveFile', 'videoArchiveName', 'videoCreateModeButton',
            'videoOpenModeButton'
        ]) document.getElementById(id).disabled = busy;
        document.getElementById('encryptVideoButton').disabled = busy || !selectedSource;
        document.getElementById('openVideoButton').disabled = busy || !selectedArchive;
        document.getElementById('cancelVideoButton').hidden = !busy;
        document.getElementById('clearHistoryButton').disabled = busy || assets.length === 0;
    }

    function runTask(type, payload, resultType, onProgress = null) {
        if (activeTask) return Promise.reject(new Error('已有视频任务正在运行'));
        if (location.protocol === 'file:') {
            return Promise.reject(new Error('本地 HTML 使用页面内兼容处理'));
        }
        try {
            if (!worker) {
                worker = new Worker('js/video-worker.js');
                worker.addEventListener('message', handleWorkerMessage);
                worker.addEventListener('error', handleWorkerError);
            }
        } catch (error) {
            return Promise.reject(new Error(
                location.protocol === 'file:'
                    ? '当前浏览器禁止本地 HTML 启动视频解码器；请使用 HTTP/HTTPS 打开本页面。'
                    : `视频解码器启动失败：${error.message || '未知错误'}`
            ));
        }
        const id = `video-${Date.now().toString(36)}-${++taskSequence}`;
        return new Promise((resolve, reject) => {
            activeTask = { id, resultType, resolve, reject, onProgress };
            worker.postMessage({ id, type, payload });
        });
    }

    function handleWorkerMessage(event) {
        const message = event.data || {};
        if (!activeTask || message.id !== activeTask.id) return;
        if (message.type === 'progress') {
            activeTask.onProgress?.(message);
            return;
        }
        if (message.type !== activeTask.resultType && message.type !== 'error') return;
        const task = activeTask;
        activeTask = null;
        if (message.type === 'error') {
            const error = new Error(message.message || '视频任务失败');
            error.code = message.code;
            task.reject(error);
        } else {
            task.resolve(message);
        }
    }

    function handleWorkerError(event) {
        event.preventDefault?.();
        const task = activeTask;
        activeTask = null;
        worker?.terminate();
        worker = null;
        task?.reject(new Error(location.protocol === 'file:'
            ? '本地 HTML 视频 Worker 不可用，正在切换兼容处理。'
            : (event.message || '视频 Worker 运行失败')));
    }

    function cancelTask() {
        pageTaskCancelled = true;
        if (activeTask) worker?.postMessage({ type: 'cancel', id: activeTask.id });
    }

    function checkPageTaskCancelled() {
        if (pageTaskCancelled) throw new DOMException('操作已取消', 'AbortError');
    }

    function setSourceMode(mode) {
        const opening = mode === 'open';
        document.getElementById('videoCreatePanel').hidden = opening;
        document.getElementById('videoOpenPanel').hidden = !opening;
        document.getElementById('videoCreateModeButton').classList.toggle('is-active', !opening);
        document.getElementById('videoOpenModeButton').classList.toggle('is-active', opening);
        document.getElementById('videoCreateModeButton').setAttribute('aria-pressed', String(!opening));
        document.getElementById('videoOpenModeButton').setAttribute('aria-pressed', String(opening));
        document.getElementById('videoWorkflowHeading').textContent = opening ? '导入 .emp4' : '添加原始视频';
        document.getElementById('videoSelectionMeta').textContent = opening
            ? (selectedArchive ? `${selectedArchive.name} · ${formatBytes(selectedArchive.size)}` : '尚未选择 .emp4')
            : (selectedSource ? `${selectedSource.name} · ${formatBytes(selectedSource.size)}` : '尚未选择 MP4');
        resetProgress();
    }

    function releaseOutputUrl() {
        if (outputUrl) URL.revokeObjectURL(outputUrl);
        outputUrl = '';
        const link = document.getElementById('downloadEmp4');
        link.href = '#';
        link.hidden = true;
        link.setAttribute('aria-disabled', 'true');
    }

    function setOutputFile(file, name) {
        releaseOutputUrl();
        outputUrl = URL.createObjectURL(file);
        const link = document.getElementById('downloadEmp4');
        link.href = outputUrl;
        link.download = name;
        link.hidden = false;
        link.setAttribute('aria-disabled', 'false');
    }

    function scheduleUrlRelease(url, cleanup) {
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            URL.revokeObjectURL(url);
            document.removeEventListener('ecryptees-download-result', onResult);
            cleanup?.();
        };
        const onResult = event => {
            if (event.detail?.url === url) release();
        };
        document.addEventListener('ecryptees-download-result', onResult);
        root.setTimeout(release, root.AndroidFileBridge ? 180000 : 45000);
    }

    function downloadFile(file, name, cleanup) {
        const url = URL.createObjectURL(file);
        const link = document.createElement('a');
        link.hidden = true;
        link.href = url;
        link.download = name;
        document.body.append(link);
        link.click();
        link.remove();
        scheduleUrlRelease(url, cleanup);
    }

    function titleFromName(name, extension) {
        return String(name || 'video').replace(new RegExp(`\\.${extension}$`, 'i'), '').slice(0, 120) || 'video';
    }

    async function validateMp4File(file) {
        const prefix = new Uint8Array(await file.slice(0, Math.min(4096, file.size)).arrayBuffer());
        if (!format.isMp4Prefix(prefix)) throw new Error('文件不是有效的 MP4 容器');
    }

    async function fingerprintChunks(chunks, totalSize, onProgress = null) {
        const digests = [];
        let processed = 0;
        for await (const chunk of chunks) {
            const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
            digests.push(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
            processed += bytes.byteLength;
            onProgress?.(processed, totalSize);
        }
        const descriptor = new Uint8Array(CONTENT_ID_PREFIX.length + 12 + digests.length * 32);
        descriptor.set(CONTENT_ID_PREFIX, 0);
        const view = new DataView(descriptor.buffer);
        const offset = CONTENT_ID_PREFIX.length;
        view.setUint32(offset, Math.floor(totalSize / 0x100000000), false);
        view.setUint32(offset + 4, totalSize >>> 0, false);
        view.setUint32(offset + 8, digests.length, false);
        digests.forEach((digest, index) => descriptor.set(digest, offset + 12 + index * 32));
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', descriptor));
        return `sha256-tree-v1:${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
    }

    async function fingerprintBlobInPage(file, onProgress = null) {
        async function* chunks() {
            for (let offset = 0; offset < file.size; offset += format.CHUNK_SIZE) {
                checkPageTaskCancelled();
                yield new Uint8Array(await file.slice(offset, Math.min(file.size, offset + format.CHUNK_SIZE)).arrayBuffer());
            }
        }
        return fingerprintChunks(chunks(), file.size, onProgress);
    }

    async function ensurePersistence() {
        const result = await assetStorage.requestPersistence();
        if (result.supported && !result.persisted) {
            setVideoStatus('系统未授予持久存储；请保留足够设备空间并及时导出重要资产。', 'warning');
        }
        return result;
    }

    async function ensureLegacyFingerprints(contentId, fileSize) {
        const indexed = await store.findVideoAssetByContentId(contentId).catch(() => null);
        if (indexed) return indexed;
        const candidates = await store.listUnindexedVideoAssetsBySize(fileSize);
        for (const candidate of candidates) {
            let result;
            try {
                result = await runTask('fingerprint', { opfsName: candidate.opfsName }, 'fingerprinted');
            } catch (error) {
                const file = await store.getVideoAssetFile(candidate);
                result = { contentId: await fingerprintBlobInPage(file) };
            }
            await store.updateVideoAsset(candidate.assetId, { contentId: result.contentId });
            if (result.contentId === contentId) return { ...candidate, contentId };
        }
        return null;
    }

    async function confirmAssetVisible(assetId) {
        for (let attempt = 0; attempt < 20; attempt++) {
            if (await store.getVideoAsset(assetId)) return;
            await new Promise(resolve => root.setTimeout(resolve, 25));
        }
        throw new Error('视频已写入，但资产索引尚未就绪');
    }

    async function persistBlobInPage(file, opfsName, onProgress = null) {
        if (!navigator.storage?.getDirectory) throw new Error('当前 HTML 环境不支持应用视频存储');
        const rootHandle = await navigator.storage.getDirectory();
        const handle = await rootHandle.getFileHandle(opfsName, { create: true });
        const writable = await handle.createWritable();
        let written = 0;
        try {
            for (let offset = 0; offset < file.size; offset += format.CHUNK_SIZE) {
                const bytes = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + format.CHUNK_SIZE)).arrayBuffer());
                await writable.write(bytes);
                written += bytes.byteLength;
                onProgress?.(written, file.size);
            }
            await writable.close();
            return { file: await handle.getFile(), contentId: await fingerprintBlobInPage(file) };
        } catch (error) {
            await writable.abort(error).catch(() => {});
            await rootHandle.removeEntry(opfsName).catch(() => {});
            throw error;
        }
    }

    async function openArchiveInPage(file) {
        const header = format.decodeHeader(new Uint8Array(await file.slice(0, format.HEADER_SIZE).arrayBuffer()));
        const expectedKeyId = await videoCrypto.getBuiltinKeyId(builtinVideoKeySource);
        if (!expectedKeyId.every((byte, index) => byte === header.keyId[index])) {
            throw new VideoError('KEY_MISMATCH', '该 .emp4 使用了不同版本的内置密钥');
        }
        const kek = await videoCrypto.deriveKek({
            keyMode: format.KEY_MODE_BUILTIN,
            builtinSource: builtinVideoKeySource,
            salt: header.salt
        });
        const rawKey = await videoCrypto.unwrapContentKey(kek, header);
        const key = await videoCrypto.importContentKey(rawKey);
        const manifestCipher = new Uint8Array(await file.slice(format.HEADER_SIZE, header.dataOffset).arrayBuffer());
        const manifestBytes = await videoCrypto.decryptChunk(
            key, header, 0, manifestCipher, header.manifestCipherLength - format.AUTH_TAG_SIZE
        );
        const manifest = format.validateManifest(format.decodeManifest(manifestBytes), header, file.size);
        return { header, key, manifest };
    }

    async function importArchiveInPage(file, opfsName) {
        const context = await openArchiveInPage(file);
        if (!navigator.storage?.getDirectory) throw new Error('当前 HTML 环境不支持应用视频存储');
        const rootHandle = await navigator.storage.getDirectory();
        const handle = await rootHandle.getFileHandle(opfsName, { create: true });
        const writable = await handle.createWritable();
        let processed = 0;
        try {
            for (let chunkIndex = 0; chunkIndex < context.header.chunkCount; chunkIndex++) {
                checkPageTaskCancelled();
                const plainLength = format.getChunkPlainLength(context.header.totalPlainSize, chunkIndex);
                const offset = format.getChunkCipherOffset(context.header, chunkIndex);
                const encrypted = new Uint8Array(await file.slice(
                    offset, offset + plainLength + format.AUTH_TAG_SIZE
                ).arrayBuffer());
                const plain = await videoCrypto.decryptChunk(
                    context.key, context.header, chunkIndex + 1, encrypted, plainLength
                );
                if (chunkIndex === 0 && !format.isMp4Prefix(plain.subarray(0, Math.min(4096, plain.length)))) {
                    throw new Error('解密结果不是有效的 MP4 容器');
                }
                await writable.write(plain);
                processed += plainLength;
                setProgress(processed, context.header.totalPlainSize, '正在兼容解密 .emp4…');
                await new Promise(resolve => root.setTimeout(resolve, 0));
            }
            await writable.close();
        } catch (error) {
            await writable.abort(error).catch(() => {});
            await rootHandle.removeEntry(opfsName).catch(() => {});
            throw error;
        }
        const stored = await handle.getFile();
        return {
            file: stored,
            opfsName,
            size: stored.size,
            contentId: await fingerprintBlobInPage(stored),
            manifest: context.manifest
        };
    }

    async function decryptArchiveBlobInPage(file) {
        const context = await openArchiveInPage(file);
        if (context.header.totalPlainSize > FILE_COMPATIBILITY_MAX_BYTES) {
            throw new Error('本地 HTML 的会话解码最多支持 512 MiB；请通过 HTTP/HTTPS 或 Android 应用打开此文件');
        }
        const parts = [];
        let processed = 0;
        for (let chunkIndex = 0; chunkIndex < context.header.chunkCount; chunkIndex++) {
            checkPageTaskCancelled();
            const plainLength = format.getChunkPlainLength(context.header.totalPlainSize, chunkIndex);
            const offset = format.getChunkCipherOffset(context.header, chunkIndex);
            const encrypted = new Uint8Array(await file.slice(
                offset, offset + plainLength + format.AUTH_TAG_SIZE
            ).arrayBuffer());
            const plain = await videoCrypto.decryptChunk(
                context.key, context.header, chunkIndex + 1, encrypted, plainLength
            );
            if (chunkIndex === 0 && !format.isMp4Prefix(plain.subarray(0, Math.min(4096, plain.length)))) {
                throw new Error('解密结果不是有效的 MP4 容器');
            }
            parts.push(plain);
            processed += plainLength;
            setProgress(processed, context.header.totalPlainSize, '正在兼容解密 .emp4…');
            await new Promise(resolve => root.setTimeout(resolve, 0));
        }
        return {
            file: new File(parts, context.manifest.originalName, { type: format.VIDEO_MIME_TYPE }),
            manifest: context.manifest,
            asset: null
        };
    }

    function isFileStorageRestriction(error) {
        const message = String(error?.message || '');
        return location.protocol === 'file:' && (
            error?.name === 'SecurityError'
            || /unsafe for access|file resources|应用视频存储|不支持应用视频存储/i.test(message)
        );
    }

    async function encryptArchiveInPage(file, title, opfsName, onProgress = null) {
        const manifest = format.createManifest(file, title);
        const manifestBytes = format.encodeManifest(manifest);
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const wrapNonce = crypto.getRandomValues(new Uint8Array(12));
        const noncePrefix = crypto.getRandomValues(new Uint8Array(8));
        const rawKey = crypto.getRandomValues(new Uint8Array(32));
        const headerOptions = {
            keyMode: format.KEY_MODE_BUILTIN,
            iterations: 0,
            totalPlainSize: file.size,
            manifestCipherLength: manifestBytes.length + format.AUTH_TAG_SIZE,
            salt,
            wrapNonce,
            noncePrefix,
            keyId: await videoCrypto.getBuiltinKeyId(builtinVideoKeySource)
        };
        const draft = format.encodeHeader(headerOptions);
        const kek = await videoCrypto.deriveKek({
            keyMode: format.KEY_MODE_BUILTIN,
            builtinSource: builtinVideoKeySource,
            salt
        });
        headerOptions.wrappedKey = await videoCrypto.wrapContentKey(kek, rawKey, draft, wrapNonce);
        const headerBytes = format.encodeHeader(headerOptions);
        const header = format.decodeHeader(headerBytes);
        const key = await videoCrypto.importContentKey(rawKey);
        if (!navigator.storage?.getDirectory) throw new Error('当前 HTML 环境不支持临时视频导出');
        const rootHandle = await navigator.storage.getDirectory();
        const handle = await rootHandle.getFileHandle(opfsName, { create: true });
        const writable = await handle.createWritable();
        let processed = 0;
        try {
            await writable.write(headerBytes);
            await writable.write(await videoCrypto.encryptChunk(key, header, 0, manifestBytes));
            for (let chunkIndex = 0; chunkIndex < header.chunkCount; chunkIndex++) {
                checkPageTaskCancelled();
                const plainLength = format.getChunkPlainLength(file.size, chunkIndex);
                const plain = new Uint8Array(await file.slice(
                    chunkIndex * format.CHUNK_SIZE,
                    chunkIndex * format.CHUNK_SIZE + plainLength
                ).arrayBuffer());
                await writable.write(await videoCrypto.encryptChunk(key, header, chunkIndex + 1, plain));
                processed += plainLength;
                onProgress?.(processed, file.size, '正在兼容生成 .emp4…');
                await new Promise(resolve => root.setTimeout(resolve, 0));
            }
            await writable.close();
        } catch (error) {
            await writable.abort(error).catch(() => {});
            await rootHandle.removeEntry(opfsName).catch(() => {});
            throw error;
        }
        return handle.getFile();
    }

    function estimateEmp4Size(file, title) {
        const manifestLength = format.encodeManifest(format.createManifest(file, title)).length;
        const chunkCount = Math.ceil(file.size / format.CHUNK_SIZE);
        return format.HEADER_SIZE + manifestLength + format.AUTH_TAG_SIZE
            + file.size + chunkCount * format.AUTH_TAG_SIZE;
    }

    async function addSelectedVideo() {
        if (!selectedSource || busy) return;
        pageTaskCancelled = false;
        await validateMp4File(selectedSource);
        await ensurePersistence();
        await assetStorage.ensureCapacity(selectedSource.size, '保存该 MP4');
        const assetId = store.createId();
        const opfsName = store.assetFileName(assetId);
        const title = String(document.getElementById('videoArchiveName').value || '').trim()
            || titleFromName(selectedSource.name, 'mp4');
        const manifest = format.createManifest(selectedSource, title);
        setBusy(true);
        resetProgress();
        setVideoStatus('正在把原始 MP4 写入应用数据…');
        try {
            let result;
            try {
                result = await runTask('persist', {
                    file: selectedSource,
                    opfsName
                }, 'persisted', message => setProgress(message.processed, message.total, '正在保存原始 MP4…'));
            } catch (error) {
                if (location.protocol !== 'file:') throw error;
                const fallback = await persistBlobInPage(selectedSource, opfsName,
                    (processed, total) => setProgress(processed, total, '正在兼容保存原始 MP4…'));
                result = {
                    file: fallback.file,
                    contentId: fallback.contentId,
                    opfsName
                };
            }
            const legacyDuplicate = await ensureLegacyFingerprints(result.contentId, manifest.size);
            if (legacyDuplicate) {
                await store.removeStoredFile(opfsName);
                currentContext = await unlockAsset(legacyDuplicate);
                document.getElementById('viewSavedVideoButton').hidden = false;
                setVideoStatus(`视频已存在：《${legacyDuplicate.title}》，未重复导入。`, 'success');
                await assetCenter.activate('video');
                return;
            }
            const commit = await store.commitVideoAsset({
                assetId,
                opfsName,
                contentId: result.contentId,
                title: manifest.title,
                fileName: manifest.originalName,
                originalName: manifest.originalName,
                fileSize: manifest.size,
                createdAt: manifest.createdAt
            });
            if (commit.duplicate) {
                await store.removeStoredFile(opfsName);
                currentContext = await unlockAsset(commit.asset);
                document.getElementById('viewSavedVideoButton').hidden = false;
                setVideoStatus(`视频已存在：《${commit.asset.title}》，未重复导入。`, 'success');
                await assetCenter.activate('video');
                return;
            }
            const asset = commit.asset;
            await confirmAssetVisible(asset.assetId);
            recentlySavedAssets.set(asset.assetId, asset);
            currentContext = {
                file: result.file,
                manifest,
                asset
            };
            document.getElementById('viewSavedVideoButton').hidden = false;
            setVideoStatus('原始 MP4 已写入应用数据并加入视频资产。', 'success');
            document.dispatchEvent(new CustomEvent('ecryptees-video-asset-saved', { detail: { asset } }));
        } catch (error) {
            await store.removeStoredFile(opfsName).catch(() => {});
            throw error;
        } finally {
            setBusy(false);
        }
    }

    async function importExternalArchive(file, existingAsset = null) {
        const assetId = existingAsset?.assetId || store.createId();
        const opfsName = store.assetFileName(assetId);
        let imported;
        const cleanupIncoming = async () => {
            if (!existingAsset && selectedIncomingOpfsName && selectedIncomingOpfsName !== opfsName) {
                await store.removeIncomingFile(selectedIncomingOpfsName).catch(() => {});
                selectedIncomingOpfsName = '';
            }
        };
        try {
            imported = await runTask('import', {
                file,
                opfsName
            }, 'imported', message => setProgress(message.processed, message.total, message.message));
        } catch (error) {
            if (location.protocol !== 'file:') throw error;
            imported = await importArchiveInPage(file, opfsName);
        }
        let asset;
        try {
            const legacyDuplicate = existingAsset ? null : await ensureLegacyFingerprints(imported.contentId, imported.size);
            if (legacyDuplicate) {
                await store.removeStoredFile(opfsName);
                await cleanupIncoming();
                return { file: await store.getVideoAssetFile(legacyDuplicate), manifest: imported.manifest, asset: legacyDuplicate, duplicate: true };
            }
            const commit = await store.commitVideoAsset({
                assetId,
                opfsName,
                contentId: imported.contentId,
                title: existingAsset?.title || imported.manifest.title,
                fileName: imported.manifest.originalName,
                originalName: imported.manifest.originalName,
                fileSize: imported.size,
                createdAt: existingAsset?.createdAt || imported.manifest.createdAt,
                lastOpenedAt: existingAsset?.lastOpenedAt || 0,
                playbackPosition: existingAsset?.playbackPosition || 0,
                duration: existingAsset?.duration || 0,
                playbackRate: existingAsset?.playbackRate || 1
            });
            if (commit.duplicate) {
                await store.removeStoredFile(opfsName);
                await cleanupIncoming();
                return { file: await store.getVideoAssetFile(commit.asset), manifest: imported.manifest, asset: commit.asset, duplicate: true };
            }
            asset = commit.asset;
            await confirmAssetVisible(asset.assetId);
            recentlySavedAssets.set(asset.assetId, asset);
        } catch (error) {
            await store.removeStoredFile(opfsName).catch(() => {});
            throw error;
        }
        if (existingAsset?.opfsName && existingAsset.opfsName !== opfsName) {
            await store.removeStoredFile(existingAsset.opfsName).catch(() => {});
        }
        await cleanupIncoming();
        return { file: imported.file, manifest: imported.manifest, asset };
    }

    async function openSelectedArchive() {
        if (!selectedArchive || busy) return;
        pageTaskCancelled = false;
        const header = format.decodeHeader(new Uint8Array(await selectedArchive.slice(0, format.HEADER_SIZE).arrayBuffer()));
        await ensurePersistence();
        await assetStorage.ensureCapacity(header.totalPlainSize, '导入该 .emp4');
        setBusy(true);
        resetProgress();
        setVideoStatus('正在验证 .emp4…');
        try {
            let context;
            let transient = false;
            try {
                context = await importExternalArchive(selectedArchive);
            } catch (error) {
                if (!isFileStorageRestriction(error)) throw error;
                context = await decryptArchiveBlobInPage(selectedArchive);
                transient = true;
            }
            currentContext = context;
            setVideoStatus(transient
                ? '`.emp4` 已解密为原始 MP4；本地 HTML 仅在当前页面保留，可直接播放或导出。'
                : '`.emp4` 已解密为原始 MP4 并加入视频资产。', 'success');
            if (context.asset) {
                document.dispatchEvent(new CustomEvent('ecryptees-video-asset-saved', { detail: { asset: context.asset } }));
            }
            if (context.duplicate) setVideoStatus(`视频已存在：《${context.asset.title}》，已直接打开原有资产。`, 'success');
            await openPlayer(context);
        } finally {
            setBusy(false);
        }
    }

    function videoFolderDefinitions() {
        return [
            { folderId: 'all', name: '全部' },
            { folderId: 'ungrouped', name: '未分组' },
            ...folders.map(folder => ({ folderId: folder.folderId, name: folder.name }))
        ];
    }

    function sortedVideoAssets(source = assets) {
        const sort = document.getElementById('historySort')?.value || 'title';
        return source.slice().sort((left, right) => {
            if (sort === 'recent') return (right.lastOpenedAt || right.createdAt) - (left.lastOpenedAt || left.createdAt);
            if (sort === 'converted') return right.createdAt - left.createdAt;
            return left.title.localeCompare(right.title, 'zh-CN', { numeric: true, sensitivity: 'base' });
        });
    }

    function assetsForEpisodeFolder(folderId = selectedEpisodeFolder) {
        return sortedVideoAssets(assets.filter(asset => {
            const membership = memberships.get(asset.assetId) || '';
            if (folderId === 'ungrouped') return !membership;
            return folderId === 'all' || membership === folderId;
        }));
    }

    function renderEpisodeDrawer() {
        const definitions = videoFolderDefinitions();
        if (!definitions.some(folder => folder.folderId === selectedEpisodeFolder)) selectedEpisodeFolder = 'all';
        let visibleAssets = assetsForEpisodeFolder();
        const currentAssetId = currentContext?.asset?.assetId || '';
        if (currentAssetId && !visibleAssets.some(asset => asset.assetId === currentAssetId)) {
            selectedEpisodeFolder = 'all';
            visibleAssets = assetsForEpisodeFolder();
        }
        const groups = document.getElementById('videoEpisodeGroups');
        groups.replaceChildren();
        for (const definition of definitions) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'video-episode-group-button';
            button.dataset.videoEpisodeFolder = definition.folderId;
            button.setAttribute('aria-current', String(definition.folderId === selectedEpisodeFolder));
            const count = assetsForEpisodeFolder(definition.folderId).length;
            button.textContent = `${definition.name} ${count}`;
            groups.append(button);
        }
        const list = document.getElementById('videoEpisodeList');
        list.replaceChildren();
        for (const asset of visibleAssets) {
            const missing = missingAssetIds.has(asset.assetId);
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'video-episode-item';
            button.dataset.videoEpisodeAsset = asset.assetId;
            button.disabled = missing || playerSwitching;
            button.setAttribute('aria-current', String(asset.assetId === currentAssetId));
            const thumbnail = document.createElement('span');
            thumbnail.className = 'video-episode-thumbnail';
            thumbnail.textContent = missing ? '不可用' : formatDuration(asset.duration);
            const copy = document.createElement('span');
            copy.className = 'video-episode-copy';
            const title = document.createElement('strong');
            title.textContent = asset.title;
            const meta = document.createElement('small');
            meta.textContent = missing
                ? '文件不可用'
                : `${formatDuration(asset.playbackPosition)} / ${formatDuration(asset.duration)}`;
            copy.append(title, meta);
            const current = document.createElement('span');
            current.className = 'video-episode-current';
            current.textContent = asset.assetId === currentAssetId ? '播放中' : '›';
            button.append(thumbnail, copy, current);
            list.append(button);
        }
        if (!visibleAssets.length) {
            const empty = document.createElement('p');
            empty.textContent = '这个分组还没有视频。';
            list.append(empty);
        }
        const definition = definitions.find(folder => folder.folderId === selectedEpisodeFolder);
        document.getElementById('videoCurrentGroupLabel').textContent = definition?.name || '全部';
        const position = visibleAssets.findIndex(asset => asset.assetId === currentAssetId);
        document.getElementById('videoEpisodePosition').textContent = visibleAssets.length
            ? `${Math.max(1, position + 1)} / ${visibleAssets.length}`
            : '0 / 0';
        document.getElementById('openVideoEpisodeDrawerButton').textContent = visibleAssets.length
            ? `选集 ${Math.max(1, position + 1)}/${visibleAssets.length}`
            : '选集';
    }

    function setEpisodeDrawerOpen(open) {
        episodeDrawerOpen = Boolean(open);
        playerShell.dataset.drawerOpen = String(episodeDrawerOpen);
        episodeDrawer.setAttribute('aria-hidden', String(!episodeDrawerOpen));
        episodeDrawer.inert = !episodeDrawerOpen;
        document.getElementById('openVideoEpisodeDrawerButton').setAttribute('aria-expanded', String(episodeDrawerOpen));
        if (episodeDrawerOpen) {
            togglePlayerMoreMenu(false);
            renderEpisodeDrawer();
            setPlayerControlsVisible(true, false);
            root.requestAnimationFrame(() => episodeDrawer.querySelector('button:not(:disabled)')?.focus({ preventScroll: true }));
        } else {
            setPlayerControlsVisible(true);
        }
    }

    async function switchPlayerAsset(assetId) {
        if (playerSwitching || assetId === currentContext?.asset?.assetId) {
            setEpisodeDrawerOpen(false);
            return;
        }
        const asset = assets.find(item => item.assetId === assetId);
        if (!asset || missingAssetIds.has(assetId)) return;
        playerSwitching = true;
        renderEpisodeDrawer();
        setPlayerStatus(`正在切换到《${asset.title}》…`);
        try {
            await savePlaybackProgress();
            const context = await unlockAsset(asset);
            await openPlayer(context, { autoplay: true });
            setEpisodeDrawerOpen(false);
        } catch (error) {
            setPlayerStatus(error.message || '视频切换失败，当前视频未被删除。');
        } finally {
            playerSwitching = false;
            renderEpisodeDrawer();
        }
    }

    async function openPlayer(context, options = {}) {
        releasePlayback();
        currentContext = context;
        updatePlayerTitle(context.asset?.title || context.manifest.title);
        document.getElementById('exportCurrentEmp4Button').disabled = !context.asset && location.protocol === 'file:';
        const playbackRate = context.asset?.playbackRate || 1;
        document.getElementById('videoPlaybackRate').value = String(playbackRate);
        player.playbackRate = playbackRate;
        if (!playerDialog.open) playerDialog.showModal();
        document.body.classList.add('video-player-open');
        setPlayerStatus('正在打开应用数据中的原始 MP4…');
        try {
            playbackBlobUrl = context.mediaUrl ? '' : URL.createObjectURL(context.file);
            playbackKind = 'plain';
            player.src = context.mediaUrl || playbackBlobUrl;
            player.load();
            player.controls = false;
            updatePlayerControls();
            renderEpisodeDrawer();
            setPlayerControlsVisible(true);
            setPlayerStatus('已直接从应用私有数据打开原始 MP4。');
            if (context.asset) {
                await store.updateVideoAsset(context.asset.assetId, { lastOpenedAt: Date.now() });
                if (active) refresh();
            }
            if (options.autoplay) {
                await player.play().catch(error => {
                    setPlayerStatus(error.message || '视频已切换，请点击播放。');
                });
            }
        } catch (error) {
            setPlayerStatus(error.message || '视频播放准备失败');
            throw error;
        }
    }

    function releasePlayback() {
        clearTimeout(progressSaveTimer);
        progressSaveTimer = 0;
        clearTimeout(controlsHideTimer);
        controlsHideTimer = 0;
        releaseWakeLock();
        player.pause();
        player.removeAttribute('src');
        player.load();
        if (playbackBlobUrl) URL.revokeObjectURL(playbackBlobUrl);
        playbackKind = '';
        playbackBlobUrl = '';
        updatePlayerControls();
    }

    function closePlayer() {
        savePlaybackProgress().catch(() => {});
        setEpisodeDrawerOpen(false);
        togglePlayerMoreMenu(false);
        exitVideoFullscreen();
        releasePlayback();
        if (playerDialog.open) playerDialog.close();
        document.body.classList.remove('video-player-open');
        setPlayerStatus('');
    }

    async function savePlaybackProgress() {
        const asset = currentContext?.asset;
        if (!asset || !Number.isFinite(player.duration) || player.duration <= 0) return;
        const duration = player.duration;
        const position = player.ended || duration - player.currentTime <= 10 ? 0 : Math.max(0, player.currentTime);
        const playbackRate = player.playbackRate || 1;
        const updated = await store.updateVideoAsset(asset.assetId, {
            playbackPosition: position,
            duration,
            playbackRate,
            lastOpenedAt: Date.now()
        });
        currentContext.asset = updated;
        const index = assets.findIndex(item => item.assetId === updated.assetId);
        if (index >= 0) assets[index] = updated;
        if (episodeDrawerOpen) renderEpisodeDrawer();
    }

    function queuePlaybackProgressSave() {
        if (progressSaveTimer || !currentContext?.asset) return;
        progressSaveTimer = root.setTimeout(() => {
            progressSaveTimer = 0;
            savePlaybackProgress().catch(() => {});
        }, 5000);
    }

    function setAndroidPlaybackActive(activePlayback) {
        if (androidPlaybackActive === activePlayback) return;
        androidPlaybackActive = activePlayback;
        try {
            root.AndroidFileBridge?.setVideoPlaybackActive?.(activePlayback);
        } catch (error) {
            // The browser Wake Lock API remains the primary path.
        }
    }

    async function requestWakeLock() {
        setAndroidPlaybackActive(true);
        if (!navigator.wakeLock?.request || document.visibilityState !== 'visible' || wakeLock) return;
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => { wakeLock = null; }, { once: true });
        } catch (error) {
            wakeLock = null;
        }
    }

    function releaseWakeLock() {
        setAndroidPlaybackActive(false);
        const lock = wakeLock;
        wakeLock = null;
        lock?.release?.().catch(() => {});
    }

    async function enterVideoFullscreen() {
        const shell = playerDialog.querySelector('.video-player-shell');
        try {
            if (!document.fullscreenElement) await shell.requestFullscreen?.();
            await screen.orientation?.lock?.('landscape').catch(() => {});
        } catch (error) {
            setPlayerStatus('当前设备不支持强制横屏，仍可继续播放。');
        }
    }

    async function exitVideoFullscreen() {
        try {
            screen.orientation?.unlock?.();
            if (document.fullscreenElement) await document.exitFullscreen?.();
        } catch (error) {
            // Fullscreen cleanup is best effort.
        }
    }

    async function unlockAsset(asset) {
        if (desktopStorage) {
            const mediaUrl = await desktopStorage.getAssetUrl('video', asset.assetId);
            const response = await fetch(mediaUrl, { headers: { Range: 'bytes=0-4095' } });
            if (!response.ok) throw new Error('视频资产文件缺失或已被清理');
            const prefix = new Uint8Array(await response.arrayBuffer());
            if (!format.isMp4Prefix(prefix)) throw new Error('文件不是有效的 MP4 容器');
            return {
                file: null,
                mediaUrl,
                manifest: {
                    title: asset.title,
                    originalName: asset.originalName,
                    size: asset.fileSize,
                    createdAt: asset.createdAt
                },
                asset
            };
        }
        const file = await store.getVideoAssetFile(asset);
        await validateMp4File(file);
        return {
            file,
            manifest: {
                title: asset.title,
                originalName: asset.originalName,
                size: file.size,
                createdAt: asset.createdAt
            },
            asset
        };
    }

    async function ensureContextFile(context) {
        if (context.file instanceof Blob) return context.file;
        if (!context.asset) throw new Error('原始 MP4 不可用');
        context.file = await store.getVideoAssetFile(context.asset);
        await validateMp4File(context.file);
        return context.file;
    }

    async function exportOriginalMp4(context) {
        const file = await ensureContextFile(context);
        downloadFile(file, sanitizeDownloadName(context.manifest.originalName, 'mp4'));
        setPlayerStatus('正在导出应用数据中的原始 MP4。');
        setVideoStatus('原始 MP4 已交给保存位置。', 'success');
    }

    async function exportEmp4(context) {
        if (exporting) throw new Error('已有视频导出任务正在运行');
        await ensureContextFile(context);
        pageTaskCancelled = false;
        const opfsName = `ecryptees-video-export-${crypto.randomUUID()}.emp4`;
        const title = context.asset?.title || context.manifest.title;
        await assetStorage.ensureCapacity(estimateEmp4Size(context.file, title), '导出该 .emp4');
        exporting = true;
        setVideoStatus('正在临时生成 `.emp4`…');
        openExportProgress(title, context.file.size);
        let result;
        try {
            result = await runTask('encrypt', {
                file: context.file,
                title,
                parallelism: 2,
                opfsName
            }, 'encrypted', message => updateExportProgress(message.processed, message.total, message.message));
        } catch (error) {
            if (location.protocol !== 'file:') {
                await store.removeStoredFile(opfsName).catch(() => {});
                closeExportProgress();
                exporting = false;
                throw error;
            }
            try {
                result = {
                    file: await encryptArchiveInPage(context.file, title, opfsName, updateExportProgress),
                    opfsName
                };
            } catch (fallbackError) {
                await store.removeStoredFile(opfsName).catch(() => {});
                closeExportProgress();
                exporting = false;
                throw fallbackError;
            }
        }
        updateExportProgress(context.file.size, context.file.size, '加密完成，正在交给系统保存…');
        document.getElementById('cancelVideoExportButton').disabled = true;
        downloadFile(
            result.file,
            sanitizeDownloadName(`${title}.emp4`, 'emp4'),
            () => store.removeStoredFile(result.opfsName).catch(() => {})
        );
        setVideoStatus('`.emp4` 已生成并交给保存位置；临时文件将在完成后清理。', 'success');
        exporting = false;
        root.setTimeout(closeExportProgress, 500);
    }

    function setSortOptions() {
        const select = document.getElementById('historySort');
        select.replaceChildren();
        for (const [value, label] of [['recent', '最近播放'], ['converted', '最近加入'], ['title', '标题']]) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            select.append(option);
        }
    }

    function renderFolders() {
        const select = document.getElementById('historyGroupFilterSelect');
        const definitions = [
            { folderId: 'all', name: '全部' },
            { folderId: 'ungrouped', name: '未分组' },
            ...folders
        ];
        select.replaceChildren();
        for (const folder of definitions) {
            const option = document.createElement('option');
            option.value = folder.folderId;
            const count = folder.folderId === 'all' ? assets.length : assets.filter(asset => {
                const membership = memberships.get(asset.assetId) || '';
                return folder.folderId === 'ungrouped' ? !membership : membership === folder.folderId;
            }).length;
            option.textContent = `${folder.name}（${count}）`;
            select.append(option);
        }
        if (!definitions.some(folder => folder.folderId === selectedFolder)) selectedFolder = 'all';
        select.value = selectedFolder;
        document.getElementById('historyViewSummary').textContent = definitions
            .find(folder => folder.folderId === selectedFolder)?.name || '全部文件夹';
    }

    function actionButton(label, action, assetId, className = '') {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.dataset.videoAssetAction = action;
        button.dataset.assetId = assetId;
        button.className = className;
        return button;
    }

    function createVideoGroupControl(asset) {
        const folderId = memberships.get(asset.assetId) || '';
        const folderName = folders.find(folder => folder.folderId === folderId)?.name || '未分组';
        const control = document.createElement('div');
        control.className = 'history-card-group-control';
        const label = document.createElement('span');
        label.className = 'history-card-group-label';
        label.textContent = Array.from(folderName).slice(0, 3).join('');
        label.title = folderName;
        const button = actionButton('移除分组', 'removeGroup', asset.assetId, 'history-remove-group-button');
        button.disabled = !folderId;
        button.title = folderId ? `移出“${folderName}”` : '当前视频未分组';
        button.setAttribute('aria-label', folderId ? `将《${asset.title}》移出分组“${folderName}”` : `《${asset.title}》当前未分组`);
        button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h6l2 2h10v12H3V5Zm4 7v2h10v-2H7Z"/></svg>';
        control.append(label, button);
        return control;
    }

    function render() {
        if (!active || !assetCenter.isActive('video')) return;
        renderFolders();
        const query = document.getElementById('historySearch').value.trim().toLocaleLowerCase();
        const sort = document.getElementById('historySort').value;
        const filtered = assets.filter(asset => {
            if (query && !asset.title.toLocaleLowerCase().includes(query)) return false;
            const membership = memberships.get(asset.assetId) || '';
            if (selectedFolder === 'ungrouped') return !membership;
            return selectedFolder === 'all' || membership === selectedFolder;
        }).slice();
        filtered.sort((left, right) => {
            if (sort === 'title') return left.title.localeCompare(right.title, 'zh-CN');
            if (sort === 'converted') return right.createdAt - left.createdAt;
            return (right.lastOpenedAt || right.createdAt) - (left.lastOpenedAt || left.createdAt);
        });
        grid.replaceChildren();
        for (const asset of filtered) {
            const card = document.createElement('article');
            card.className = 'video-asset-card';
            const missing = missingAssetIds.has(asset.assetId);
            card.classList.toggle('video-asset-missing', missing);
            const poster = actionButton('', 'play', asset.assetId, 'video-asset-poster');
            poster.className = 'video-asset-poster';
            poster.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7L8 5Z"/></svg>';
            poster.setAttribute('aria-label', `播放《${asset.title}》`);
            poster.disabled = missing;
            const duration = document.createElement('span');
            duration.className = 'video-asset-poster-duration';
            duration.textContent = formatDuration(asset.duration);
            const progress = document.createElement('span');
            progress.className = 'video-asset-poster-progress';
            const progressValue = document.createElement('span');
            const percentage = asset.duration > 0
                ? Math.min(100, Math.max(0, asset.playbackPosition / asset.duration * 100))
                : 0;
            progressValue.style.setProperty('--video-progress', `${percentage}%`);
            progress.append(progressValue);
            poster.append(duration, progress);
            const header = document.createElement('div');
            header.className = 'history-card-header';
            const title = document.createElement('h3');
            title.className = 'history-card-title';
            title.textContent = asset.title;
            const menu = actionButton('更多操作', 'menu', asset.assetId, 'history-menu-button');
            menu.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/></svg>';
            menu.setAttribute('aria-label', `打开《${asset.title}》的更多操作`);
            const headerTools = document.createElement('div');
            headerTools.className = 'history-card-header-tools';
            headerTools.append(createVideoGroupControl(asset), menu);
            header.append(title, headerTools);
            const meta = document.createElement('p');
            meta.className = 'history-card-meta';
            meta.textContent = missing
                ? `文件不可用 · 元数据已保留 · ${formatBytes(asset.fileSize || asset.plainSize)}`
                : `原始 MP4 · ${formatBytes(asset.fileSize || asset.plainSize)}`;
            const time = document.createElement('p');
            time.className = 'history-card-time';
            time.textContent = `最近：${asset.lastOpenedAt ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(asset.lastOpenedAt)) : '尚未播放'}`;
            const actions = document.createElement('div');
            actions.className = 'video-asset-actions';
            const exportArchive = actionButton('导出 .emp4', 'exportEmp4', asset.assetId);
            const exportOriginal = actionButton('导出 MP4', 'exportMp4', asset.assetId);
            exportArchive.disabled = missing;
            exportOriginal.disabled = missing;
            actions.append(exportArchive, exportOriginal);
            card.append(poster, header, meta, time, actions);
            grid.append(card);
        }
        document.getElementById('historyEmptyState').hidden = assets.length !== 0;
        document.getElementById('historyEmptyTitle').textContent = '视频资产还是空的';
        document.getElementById('historyEmptyDescription').textContent = '添加 MP4 或导入 `.emp4` 后会把原始 MP4 保存到应用数据。';
        document.getElementById('historyGoToComicButton').textContent = '前往视频模式';
        document.getElementById('clearHistoryButton').disabled = busy || assets.length === 0;
        if (playerDialog.open) renderEpisodeDrawer();
        assetStorage.updateStorageSummary(document.getElementById('historyStorageSummary')).catch(() => {});
    }

    async function refresh() {
        if (!active || !assetCenter.isActive('video')) return;
        const sequence = ++refreshSequence;
        const activation = assetCenter.getSequence();
        let state = await store.auditVideoAssets();
        const recoveredIds = new Set(state.recoveredIds || []);
        assetCenter.setCount('video', state.assets.length);
        for (const legacy of state.assets.filter(asset =>
            !legacyMigrationAttempts.has(asset.assetId)
            && (asset.storageFormat !== 'plain-mp4' || /\.emp4$/i.test(asset.opfsName)))) {
            legacyMigrationAttempts.add(legacy.assetId);
            try {
                setStatus(`正在迁移旧视频《${legacy.title}》到原始 MP4 存储…`);
                const file = await store.getVideoAssetFile(legacy);
                await importExternalArchive(file, legacy);
            } catch (error) {
                setStatus(`旧视频《${legacy.title}》迁移失败：${error.message}`, 'error');
            }
        }
        state = await store.auditVideoAssets();
        for (const assetId of state.recoveredIds || []) recoveredIds.add(assetId);
        assetCenter.setCount('video', state.assets.length);
        if (!active || !assetCenter.isCurrent('video', activation) || sequence !== refreshSequence) return;
        const listedIds = new Set(state.assets.map(asset => asset.assetId));
        for (const assetId of listedIds) recentlySavedAssets.delete(assetId);
        assets = state.assets.concat([...recentlySavedAssets.values()].filter(asset => !listedIds.has(asset.assetId)));
        folders = state.folders.sort((a, b) => a.createdAt - b.createdAt);
        memberships = new Map(state.memberships.map(item => [item.assetId, item.folderId]));
        missingAssetIds = new Set(state.missingIds);
        render();
        if (recoveredIds.size) {
            setStatus(`已从保留的原始 MP4 恢复 ${recoveredIds.size} 个视频索引。`, 'success');
        }
    }

    async function activateVideos() {
        active = true;
        setSortOptions();
        document.getElementById('historyDirectoryPanel').hidden = true;
        document.getElementById('historyDescription').textContent = '视频资产保存原始 MP4；.emp4 只在导入或导出时临时解密、加密。';
        document.getElementById('clearHistoryButton').textContent = '清空视频';
        document.getElementById('historySearch').value = '';
        document.getElementById('historyTab').click();
        await refresh();
    }

    function deactivate() {
        active = false;
        refreshSequence += 1;
        panel.classList.remove('video-assets-active');
    }

    function showVideoSheetView(view) {
        const views = {
            menu: 'videoAssetMenuView',
            rename: 'videoAssetRenameForm',
            group: 'videoAssetGroupForm',
            delete: 'videoAssetDeleteConfirm'
        };
        for (const [name, id] of Object.entries(views)) {
            document.getElementById(id).hidden = name !== view;
        }
        const asset = assets.find(item => item.assetId === selectedAssetId);
        const heading = document.getElementById('videoAssetMenuTitle');
        if (view === 'rename') heading.textContent = '修改名称';
        else if (view === 'group') heading.textContent = '添加至分组';
        else if (view === 'delete') heading.textContent = '删除视频';
        else heading.textContent = asset?.title || '视频';
    }

    function closeVideoActionSheet() {
        const dialog = document.getElementById('videoAssetMenuDialog');
        if (dialog.open) dialog.close();
        showVideoSheetView('menu');
    }

    function populateVideoGroupForm() {
        const form = document.getElementById('videoAssetGroupForm');
        form.dataset.createOnly = String(!selectedAssetId);
        const select = document.getElementById('videoAssetGroupSelect');
        select.replaceChildren(new Option('未分组', ''));
        for (const folder of folders) select.append(new Option(folder.name, folder.folderId));
        select.value = memberships.get(selectedAssetId) || '';
        document.getElementById('videoAssetNewGroupInput').value = '';
        document.getElementById('videoAssetGroupMessage').textContent = '';
    }

    async function handleAssetAction(action, assetId) {
        if (busy) return;
        const asset = assets.find(item => item.assetId === assetId);
        if (!asset) return;
        if (action === 'menu') {
            selectedAssetId = asset.assetId;
            document.getElementById('videoAssetMenuTitle').textContent = asset.title;
            showVideoSheetView('menu');
            const dialog = document.getElementById('videoAssetMenuDialog');
            if (!dialog.open) dialog.showModal();
            return;
        }
        if (action === 'removeGroup') {
            try {
                busy = true;
                await store.setVideoAssetFolder(assetId, '');
                await refresh();
                setStatus(`《${asset.title}》已移出分组。`, 'success');
            } catch (error) {
                setStatus(error.message || '无法移除视频分组。', 'error');
            } finally {
                busy = false;
                if (active) render();
            }
            return;
        }
        try {
            busy = true;
            render();
            const context = await unlockAsset(asset);
            currentContext = context;
            if (action === 'play') await openPlayer(context);
            else if (action === 'exportEmp4') await exportEmp4(context);
            else await exportOriginalMp4(context);
        } catch (error) {
            if (error.name !== 'AbortError') setStatus(error.message || '视频操作失败', 'error');
        } finally {
            busy = false;
            if (active) render();
        }
    }

    document.getElementById('videoCreateModeButton').addEventListener('click', () => setSourceMode('create'));
    document.getElementById('videoOpenModeButton').addEventListener('click', () => setSourceMode('open'));
    document.getElementById('videoSourceFile').addEventListener('change', event => {
        selectedSource = event.currentTarget.files?.[0] || null;
        releaseOutputUrl();
        document.getElementById('viewSavedVideoButton').hidden = true;
        if (selectedSource) {
            document.getElementById('videoArchiveName').value = titleFromName(selectedSource.name, 'mp4');
            setVideoStatus(`${selectedSource.name} 已选择。`);
        }
        setSourceMode('create');
        setBusy(false);
    });
    document.getElementById('videoArchiveFile').addEventListener('change', event => {
        selectedArchive = event.currentTarget.files?.[0] || null;
        selectedIncomingOpfsName = '';
        setSourceMode('open');
        setBusy(false);
    });
    document.getElementById('encryptVideoButton').addEventListener('click', () => {
        addSelectedVideo().catch(error => setVideoStatus(error.message || '视频保存失败', 'error'));
    });
    document.getElementById('openVideoButton').addEventListener('click', () => {
        openSelectedArchive().catch(error => setVideoStatus(error.message || '无法打开 .emp4', 'error'));
    });
    document.getElementById('cancelVideoButton').addEventListener('click', cancelTask);
    document.getElementById('viewSavedVideoButton').addEventListener('click', async () => {
        try {
            await assetCenter.activate('video');
            document.getElementById('historyTab').click();
        } catch (error) {
            setStatus(error.message || '无法打开视频资产', 'error');
        }
    });
    assetCenter.register('video', {
        activate: activateVideos,
        deactivate,
        render,
        refresh,
        handleGridClick(event) {
            const button = event.target.closest('button[data-video-asset-action]');
            if (button) handleAssetAction(button.dataset.videoAssetAction, button.dataset.assetId);
        },
        handleGroupChange(event) {
            selectedFolder = event.currentTarget.value;
            document.getElementById('historyViewMenu').open = false;
            render();
        },
        handleSortChange() {
            document.getElementById('assetSortMenu').open = false;
            render();
        },
        handleSearchInput: render,
        handleAddFolder() {
            selectedAssetId = '';
            populateVideoGroupForm();
            showVideoSheetView('group');
            document.getElementById('videoAssetGroupForm').dataset.createOnly = 'true';
            document.getElementById('videoAssetMenuTitle').textContent = '新建视频分组';
            const dialog = document.getElementById('videoAssetMenuDialog');
            if (!dialog.open) dialog.showModal();
            document.getElementById('videoAssetNewGroupInput').focus();
        },
        listGroups() {
            return folders.map(folder => ({ groupId: folder.folderId, name: folder.name }));
        },
        async createGroup(name) {
            const folder = await store.createVideoFolder(name);
            await refresh();
            return folder;
        },
        async renameGroup(folderId, name) {
            const folder = await store.renameVideoFolder(folderId, name);
            await refresh();
            return folder;
        },
        async deleteGroup(folderId) {
            if (selectedFolder === folderId) selectedFolder = 'all';
            await store.deleteVideoFolder(folderId);
            await refresh();
        },
        handleClear() {
            if (assets.length && confirm('清空全部视频资产？此操作无法撤销。')) {
                recentlySavedAssets.clear();
                store.clearVideoAssets().then(refresh).catch(error => setStatus(error.message, 'error'));
            }
        },
        handleEmptyAction() {
            document.getElementById('videoTab').click();
        }
    });
    for (const id of ['videoAssetMenuCancelButton', 'videoAssetMenuCloseButton']) {
        document.getElementById(id).addEventListener('click', closeVideoActionSheet);
    }
    document.getElementById('videoAssetMenuDialog').addEventListener('cancel', event => {
        event.preventDefault();
        closeVideoActionSheet();
    });
    document.getElementById('videoAssetMenuDialog').addEventListener('click', event => {
        if (event.target === event.currentTarget) closeVideoActionSheet();
    });
    document.getElementById('videoAssetRenameButton').addEventListener('click', () => {
        const asset = assets.find(item => item.assetId === selectedAssetId);
        if (!asset) return;
        document.getElementById('videoAssetRenameInput').value = asset.title;
        showVideoSheetView('rename');
        document.getElementById('videoAssetRenameInput').focus();
        document.getElementById('videoAssetRenameInput').select();
    });
    document.getElementById('videoAssetRenameCancelButton').addEventListener('click', () => showVideoSheetView('menu'));
    document.getElementById('videoAssetRenameForm').addEventListener('submit', async event => {
        event.preventDefault();
        const asset = assets.find(item => item.assetId === selectedAssetId);
        const title = document.getElementById('videoAssetRenameInput').value.trim();
        if (!asset || !title) return;
        await store.updateVideoAsset(asset.assetId, { title });
        closeVideoActionSheet();
        await refresh();
        setStatus('视频名称已保存。', 'success');
    });
    document.getElementById('videoAssetDeleteButton').addEventListener('click', () => showVideoSheetView('delete'));
    document.getElementById('videoAssetDeleteCancelButton').addEventListener('click', () => showVideoSheetView('menu'));
    document.getElementById('videoAssetDeleteConfirmButton').addEventListener('click', async () => {
        const asset = assets.find(item => item.assetId === selectedAssetId);
        if (!asset) return;
        closeVideoActionSheet();
        recentlySavedAssets.delete(asset.assetId);
        await store.deleteVideoAsset(asset.assetId);
        await refresh();
        setStatus('视频资产已删除。', 'success');
    });
    document.getElementById('videoAssetGroupButton').addEventListener('click', () => {
        populateVideoGroupForm();
        showVideoSheetView('group');
    });
    document.getElementById('videoAssetGroupCancelButton').addEventListener('click', () => showVideoSheetView('menu'));
    document.getElementById('videoAssetCreateGroupButton').addEventListener('click', async () => {
        const input = document.getElementById('videoAssetNewGroupInput');
        const message = document.getElementById('videoAssetGroupMessage');
        const name = input.value.trim();
        if (!name) {
            message.textContent = '请输入分组名称。';
            input.focus();
            return;
        }
        try {
            const folder = await store.createVideoFolder(name);
            folders.push(folder);
            folders.sort((left, right) => left.createdAt - right.createdAt);
            const select = document.getElementById('videoAssetGroupSelect');
            select.append(new Option(folder.name, folder.folderId));
            select.value = folder.folderId;
            input.value = '';
            message.textContent = `已新建分组“${folder.name}”。`;
            if (!selectedAssetId) {
                closeVideoActionSheet();
                await refresh();
                setStatus(`已新建视频分组“${folder.name}”。`, 'success');
            }
        } catch (error) {
            message.textContent = error.message || '无法新建分组。';
        }
    });
    document.getElementById('videoAssetGroupForm').addEventListener('submit', async event => {
        event.preventDefault();
        if (!selectedAssetId) {
            closeVideoActionSheet();
            return;
        }
        await store.setVideoAssetFolder(selectedAssetId, document.getElementById('videoAssetGroupSelect').value);
        closeVideoActionSheet();
        await refresh();
        setStatus('视频分组已保存。', 'success');
    });
    document.getElementById('videoAssetExportEmp4Button').addEventListener('click', () => {
        const assetId = selectedAssetId;
        closeVideoActionSheet();
        handleAssetAction('exportEmp4', assetId);
    });
    document.getElementById('videoAssetExportMp4Button').addEventListener('click', () => {
        const assetId = selectedAssetId;
        closeVideoActionSheet();
        handleAssetAction('exportMp4', assetId);
    });
    const videoActionSheet = document.getElementById('videoAssetActionSheet');
    videoActionSheet.addEventListener('pointerdown', event => {
        if (!event.target.closest('.video-sheet-drag-handle')) return;
        sheetGesture = { pointerId: event.pointerId, startY: event.clientY, lastY: event.clientY };
        videoActionSheet.setPointerCapture?.(event.pointerId);
    });
    videoActionSheet.addEventListener('pointermove', event => {
        if (!sheetGesture || sheetGesture.pointerId !== event.pointerId) return;
        sheetGesture.lastY = event.clientY;
    });
    videoActionSheet.addEventListener('pointerup', event => {
        if (!sheetGesture || sheetGesture.pointerId !== event.pointerId) return;
        const distance = sheetGesture.lastY - sheetGesture.startY;
        sheetGesture = null;
        if (distance > 64) closeVideoActionSheet();
    });
    videoActionSheet.addEventListener('pointercancel', () => { sheetGesture = null; });
    document.getElementById('closeVideoPlayerButton').addEventListener('click', closePlayer);
    playerDialog.addEventListener('cancel', event => {
        event.preventDefault();
        if (episodeDrawerOpen) {
            setEpisodeDrawerOpen(false);
            return;
        }
        if (!document.getElementById('videoPlayerMoreMenu').hidden) {
            togglePlayerMoreMenu(false);
            return;
        }
        closePlayer();
    });
    player.addEventListener('error', () => setPlayerStatus('视频解码失败；可能是设备不支持原 MP4 的编码格式，仍可导出原文件。'));
    player.addEventListener('loadedmetadata', () => {
        const saved = Math.max(0, Number(currentContext?.asset?.playbackPosition) || 0);
        const duration = player.duration;
        if (saved > 5 && Number.isFinite(duration) && duration - saved > 10) {
            player.currentTime = Math.min(saved, duration);
            setPlayerStatus(`已续播至 ${Math.floor(saved / 60)}:${String(Math.floor(saved % 60)).padStart(2, '0')}。`);
        } else {
            setPlayerStatus('视频已就绪。');
        }
        player.playbackRate = Number(currentContext?.asset?.playbackRate) || 1;
        updatePlayerControls();
        renderEpisodeDrawer();
    });
    player.addEventListener('durationchange', updatePlayerControls);
    player.addEventListener('timeupdate', () => {
        updatePlayerControls();
        queuePlaybackProgressSave();
    });
    player.addEventListener('play', () => {
        updatePlayerControls();
        requestWakeLock();
        setPlayerControlsVisible(true);
    });
    player.addEventListener('pause', () => {
        releaseWakeLock();
        savePlaybackProgress().catch(() => {});
        updatePlayerControls();
        setPlayerControlsVisible(true, false);
    });
    player.addEventListener('ended', () => {
        releaseWakeLock();
        savePlaybackProgress().catch(() => {});
        updatePlayerControls();
        setPlayerControlsVisible(true, false);
    });
    player.addEventListener('volumechange', updatePlayerControls);
    player.addEventListener('waiting', () => setPlayerStatus('正在缓冲视频…'));
    player.addEventListener('playing', () => {
        setPlayerStatus('正在播放。');
        updatePlayerControls();
        setPlayerControlsVisible(true);
    });
    document.getElementById('videoPlayPauseButton').addEventListener('click', togglePlayback);
    document.getElementById('videoCenterPlayButton').addEventListener('click', togglePlayback);
    player.addEventListener('click', () => {
        if (isLandscapePlayer() && playerShell.dataset.controlsVisible === 'false') {
            setPlayerControlsVisible(true);
            return;
        }
        togglePlayback();
    });
    document.getElementById('videoSeekBackwardButton').addEventListener('click', () => {
        player.currentTime = Math.max(0, player.currentTime - 10);
        queuePlaybackProgressSave();
    });
    document.getElementById('videoSeekForwardButton').addEventListener('click', () => {
        const limit = Number.isFinite(player.duration) ? player.duration : player.currentTime + 10;
        player.currentTime = Math.min(limit, player.currentTime + 10);
        queuePlaybackProgressSave();
    });
    document.getElementById('videoPlaybackRate').addEventListener('change', event => {
        player.playbackRate = Number(event.currentTarget.value) || 1;
        savePlaybackProgress().catch(() => {});
    });
    document.getElementById('videoMuteButton').addEventListener('click', () => {
        player.muted = !player.muted;
        updatePlayerControls();
    });
    const videoTimeline = document.getElementById('videoTimeline');
    videoTimeline.addEventListener('input', event => {
        timelineDragging = true;
        const duration = Number.isFinite(player.duration) ? player.duration : 0;
        document.getElementById('videoElapsedTime').textContent = formatDuration(duration * Number(event.currentTarget.value) / 1000);
        setPlayerControlsVisible(true, false);
    });
    videoTimeline.addEventListener('change', event => {
        const duration = Number.isFinite(player.duration) ? player.duration : 0;
        player.currentTime = duration * Number(event.currentTarget.value) / 1000;
        timelineDragging = false;
        updatePlayerControls();
        queuePlaybackProgressSave();
        setPlayerControlsVisible(true);
    });
    document.getElementById('videoFullscreenButton').addEventListener('click', enterVideoFullscreen);
    document.addEventListener('fullscreenchange', () => {
        if (!document.fullscreenElement) screen.orientation?.unlock?.();
        setEpisodeDrawerOpen(false);
        setPlayerControlsVisible(true);
    });
    for (const id of ['openVideoEpisodeDrawerButton', 'openVideoEpisodeRowButton']) {
        document.getElementById(id).addEventListener('click', () => setEpisodeDrawerOpen(true));
    }
    document.getElementById('closeVideoEpisodeDrawerButton').addEventListener('click', () => setEpisodeDrawerOpen(false));
    document.getElementById('videoEpisodeBackdrop').addEventListener('click', () => setEpisodeDrawerOpen(false));
    document.getElementById('videoEpisodeGroups').addEventListener('click', event => {
        const button = event.target.closest('button[data-video-episode-folder]');
        if (!button) return;
        selectedEpisodeFolder = button.dataset.videoEpisodeFolder;
        renderEpisodeDrawer();
    });
    document.getElementById('videoEpisodeList').addEventListener('click', event => {
        const button = event.target.closest('button[data-video-episode-asset]');
        if (!button || button.disabled) return;
        switchPlayerAsset(button.dataset.videoEpisodeAsset);
    });
    document.getElementById('videoMoreButton').addEventListener('click', () => togglePlayerMoreMenu());
    playerStage.addEventListener('pointermove', () => {
        if (isLandscapePlayer()) setPlayerControlsVisible(true);
    });
    playerDialog.addEventListener('pointerdown', event => {
        if (episodeDrawerOpen || event.target.closest('button, input, select, aside')) return;
        const fromRight = isLandscapePlayer();
        const atEdge = fromRight ? event.clientX >= root.innerWidth - 24 : event.clientX <= 24;
        if (atEdge) playerGesture = { pointerId: event.pointerId, startX: event.clientX, lastX: event.clientX, opening: true, fromRight };
    });
    episodeDrawer.addEventListener('pointerdown', event => {
        if (event.target.closest('button, input, select')) return;
        playerGesture = { pointerId: event.pointerId, startX: event.clientX, lastX: event.clientX, opening: false, fromRight: isLandscapePlayer() };
    });
    const movePlayerGesture = event => {
        if (playerGesture?.pointerId === event.pointerId) playerGesture.lastX = event.clientX;
    };
    const finishPlayerGesture = event => {
        if (!playerGesture || playerGesture.pointerId !== event.pointerId) return;
        const gesture = playerGesture;
        playerGesture = null;
        const distance = event.clientX - gesture.startX;
        if (gesture.opening) {
            if ((!gesture.fromRight && distance > 60) || (gesture.fromRight && distance < -60)) setEpisodeDrawerOpen(true);
        } else if ((!gesture.fromRight && distance < -60) || (gesture.fromRight && distance > 60)) {
            setEpisodeDrawerOpen(false);
        }
    };
    playerDialog.addEventListener('pointermove', movePlayerGesture);
    playerDialog.addEventListener('pointerup', finishPlayerGesture);
    playerDialog.addEventListener('pointercancel', () => { playerGesture = null; });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && !player.paused) requestWakeLock();
        else if (document.visibilityState !== 'visible') savePlaybackProgress().catch(() => {});
    });
    document.getElementById('exportCurrentEmp4Button').addEventListener('click', () => {
        if (!currentContext || activeTask || exporting) return;
        togglePlayerMoreMenu(false);
        exportEmp4(currentContext).catch(error => setPlayerStatus(error.message || '.emp4 导出失败'));
    });
    document.getElementById('decryptCurrentVideoButton').addEventListener('click', () => {
        togglePlayerMoreMenu(false);
        if (currentContext) exportOriginalMp4(currentContext)
            .catch(error => setPlayerStatus(error.message || '原始 MP4 导出失败'));
    });
    document.getElementById('cancelVideoExportButton').addEventListener('click', cancelTask);
    document.getElementById('videoExportProgressDialog').addEventListener('cancel', event => {
        event.preventDefault();
        cancelTask();
    });
    document.addEventListener('ecryptees-open-video-archive', event => {
        const detail = event.detail || {};
        if (!(detail.file instanceof Blob)) return;
        selectedArchive = detail.file;
        selectedIncomingOpfsName = String(detail.opfsName || '');
        document.getElementById('videoTab').click();
        setSourceMode('open');
        setBusy(false);
        setVideoStatus(`${selectedArchive.name} 已导入；可直接验证并打开。`);
    });
    root.addEventListener('pagehide', () => {
        savePlaybackProgress().catch(() => {});
        releasePlayback();
        releaseOutputUrl();
        worker?.terminate();
    });

    setSourceMode('create');
    setBusy(false);
    store.listVideoAssets().then(state => assetCenter.setCount('video', state.assets.length)).catch(() => {});
    root.EcrypteesVideoAssetsUI = Object.freeze({ isActive: () => active && assetCenter.isActive('video'), render, refresh, deactivate });
})(globalThis);
