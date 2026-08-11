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

test('image signature detection distinguishes AVIF, HEIC, and generic HEIF containers', () => {
    const makeFtyp = brand => {
        const bytes = new Uint8Array(32);
        bytes.set([0x00, 0x00, 0x00, 0x20]);
        bytes.set(new TextEncoder().encode('ftyp'), 4);
        bytes.set(new TextEncoder().encode(brand), 8);
        return bytes;
    };

    assert.equal(globalThis.Ecryptees.core.image.sniffImageType(makeFtyp('avif')).mime, 'image/avif');
    assert.equal(globalThis.Ecryptees.core.image.sniffImageType(makeFtyp('heic')).mime, 'image/heic');
    assert.equal(globalThis.Ecryptees.core.image.sniffImageType(makeFtyp('mif1')).mime, 'image/heif');
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
    const pwaPosition = index.indexOf('src="js/pwa.js"');
    const androidBridgePosition = index.indexOf('src="js/android-bridge.js"');

    assert.ok(
        corePosition >= 0
            && comicCorePosition > corePosition
            && historyCorePosition > comicCorePosition
            && androidBridgePosition > historyCorePosition
            && appPosition > androidBridgePosition
            && comicWorkerPosition > appPosition
            && comicAppPosition > comicWorkerPosition
            && pwaPosition > comicAppPosition,
        'scripts must load in core, comic-core, history-core, android-bridge, app, comic-worker, comic-app, pwa order'
    );
    assert.match(index, /href="css\/styles\.css"/);
    assert.match(index, /<script src="js\/core\.js" defer><\/script>/);
    assert.match(index, /<script src="js\/comic-core\.js" defer><\/script>/);
    assert.match(index, /<script src="js\/history-core\.js" defer><\/script>/);
    assert.match(index, /<script src="js\/app\.js" defer><\/script>/);
    assert.match(index, /<script src="js\/comic-worker\.js" defer><\/script>/);
    assert.match(index, /<script src="js\/comic-app\.js" defer><\/script>/);
    assert.match(index, /<script src="js\/pwa\.js" defer><\/script>/);
    assert.match(index, /<script src="js\/android-bridge\.js" defer><\/script>/);
    assert.doesNotMatch(index, /<style\b/);
    assert.doesNotMatch(index, /<script(?![^>]*\bsrc=)/);
    assert.doesNotMatch(index, /onclick\s*=/);
    assert.match(index, /<dialog[\s\S]*id="comicReaderDialog"/);
    assert.match(index, /id="comicReaderHint">书架保存原始页面和封面；长图仅在导出时生成/);
    assert.match(index, /最多 80 张 · 500 MiB · 原图无损封装/);
    assert.doesNotMatch(index, /id="exportComicLongImageButton"/);
    assert.doesNotMatch(index, /id="downloadComicLongImage"/);
    assert.match(index, /id="collapseComicReaderHeaderButton"[^>]*aria-expanded="true"/);
    assert.match(index, /id="expandComicReaderHeaderButton"[^>]*aria-expanded="false"/);
    assert.match(index, /id="closeComicReaderButton"[^>]*aria-label="关闭阅读"/);
    assert.match(index, /id="closeCollapsedComicReaderButton"[^>]*aria-label="关闭阅读"/);
    assert.match(index, /id="historyTab"[\s\S]*data-mode="history"/);
    assert.match(index, /id="historyPanel"/);
    assert.match(index, /id="selectHistoryDirectoryButton"/);
    assert.match(index, /id="migrateHistoryButton"/);
    assert.match(index, /id="openComicButton"[^>]*>解密、转存并阅读</);
    assert.match(index, /id="comicArchiveFile"[^>]*accept="\.ecomic,application\/vnd\.ecryptees\.ecomic"/);
    assert.doesNotMatch(index, /id="comicArchiveFile"[^>]*application\/octet-stream/);
    assert.match(index, /id="encryptComicButton"[^>]*>加密并加入书架</);
    assert.match(index, /class="button-group comic-actions"[\s\S]*id="downloadComicArchive"/);
    assert.doesNotMatch(index, /id="comicArchiveDownloadRow"/);
    assert.doesNotMatch(index, /id="exportComicZipButton"/);
    assert.doesNotMatch(index, /id="comicReaderSection"/);
    assert.match(comicWorker, /new self\.CompressionStream\('deflate'\)/);
    assert.match(comicWorker, /new self\.OffscreenCanvas/);
    assert.match(comicWorker, /class CodecTaskPool/);
    assert.match(comicWorker, /'encryptChunk'/);
    assert.match(comicWorker, /'decryptChunk'/);
    assert.match(comicWorker, /'inspectImage'/);
    assert.match(comicWorker, /normalizeParallelism\(value\)/);
    assert.match(comicWorker, /Math\.min\(4, Math\.trunc/);
    assert.match(comicWorker, /runBounded\(session\.manifest\.pages\.length, parallelism/);
    assert.match(comicWorker, /name: `\$\{baseName\}-long\.png`/);
    assert.doesNotMatch(comicWorker, /-long\.svg/);
    const comicApp = fs.readFileSync(path.join(repositoryRoot, 'js', 'comic-app.js'), 'utf8');
    assert.match(comicApp, /saveCurrentSessionToHistory\(\)/);
    assert.match(comicApp, /startJob\('historySave'/);
    assert.match(comicApp, /function createHistoryMenuButton\(book\)/);
    assert.match(comicApp, /GROUP_DATABASE_NAME = 'ecryptees-groups-v1'/);
    assert.match(comicApp, /createObjectStore\(GROUP_STORE, \{ keyPath: 'groupId' \}\)/);
    assert.match(comicApp, /createObjectStore\(GROUP_MEMBERSHIP_STORE, \{ keyPath: 'bookId' \}\)/);
    assert.match(comicApp, /function openHistoryFolderDialog\(bookId = ''\)/);
    assert.match(comicApp, /function openHistoryGroupDialog\(bookId\)/);
    assert.match(comicApp, /historyAction === 'menu'/);
    assert.match(comicApp, /createHistoryButton\('阅读', 'open'/);
    assert.match(comicApp, /createHistoryButton\('导出 \.ecomic', 'exportArchive'/);
    assert.match(comicApp, /createHistoryButton\('导出长图', 'exportLong'/);
    assert.match(comicApp, /createHistoryButton\('删除', 'delete'/);
    assert.doesNotMatch(comicApp, /createHistoryButton\('从头阅读'|history-progress-track|history-more/);
    assert.match(comicApp, /startJob\('historyExportArchive'/);
    assert.match(comicApp, /historyLongImageReady/);
    assert.match(comicApp, /historyArchiveReady/);
    assert.match(comicApp, /ecryptees-open-archive/);
    assert.match(comicApp, /releaseSelectedArchiveTemp\(\)/);
    assert.match(comicApp, /selectArchiveFile\(file, temporaryEntryName\)/);
    assert.match(comicApp, /已使用 \$\{used\} · 剩余 \$\{remaining\}/);
    assert.match(comicApp, /downloadLongImageFile\(message\.file, message\.name, message\.opfsName, message\.storageKind\)/);
    assert.match(comicApp, /function getComicParallelism\(\)/);
    assert.match(comicApp, /READER_HEADER_STORAGE_KEY/);
    assert.match(comicApp, /setReaderHeaderCollapsed\(readReaderHeaderPreference\(\), false, false\)/);
    assert.match(comicApp, /header\.inert = readerHeaderCollapsed/);
    assert.doesNotMatch(comicApp, /downloadComicLongImage|autoDownloadLongImage/);
    assert.match(comicWorker, /opfsName: entryName/);
    assert.match(comicWorker, /post\(payload\.resultType === 'historyExport' \? 'historyLongImageReady' : 'complete'/);
    assert.match(comicWorker, /size: 0,\s*generatedAt: 0,\s*entryName: ''/);
    assert.doesNotMatch(comicApp, /historyAction === 'rename'|history-progress-track|history-more/);
    assert.match(index, /id="addHistoryFolderButton"[^>]*aria-label="添加文件夹"/);
    assert.match(index, /id="historyViewMenu"[\s\S]*id="historySort"[\s\S]*id="historyGroupFilterSelect"/);
    assert.doesNotMatch(index, /id="historyGroupFilters"|class="history-group-filters"/);
    assert.match(comicApp, /function renderHistoryViewMenu\(\)/);
    assert.doesNotMatch(comicApp, /renderHistoryGroupFilters|data-history-group-filter/);
    assert.match(index, /id="historyBookMenuDialog"[\s\S]*修改名称[\s\S]*添加分组/);
    assert.match(comicApp, /showDirectoryPicker/);
    assert.match(comicApp, /EcrypteesAndroid\\\//);
    assert.match(comicApp, /historyDirectoryPanel'\)\.hidden = true/);
    assert.match(comicApp, /startWorker\('', true\)/);
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

test('PWA entry point is installable and caches only the application shell', () => {
    const index = fs.readFileSync(path.join(repositoryRoot, 'index.html'), 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'manifest.webmanifest'), 'utf8'));
    const serviceWorker = fs.readFileSync(path.join(repositoryRoot, 'service-worker.js'), 'utf8');
    const pwa = fs.readFileSync(path.join(repositoryRoot, 'js', 'pwa.js'), 'utf8');

    assert.equal(manifest.start_url, './index.html');
    assert.equal(manifest.scope, './');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.theme_color, '#ff4081');
    assert.ok(manifest.icons.some(icon => icon.sizes === '192x192' && icon.purpose.includes('maskable')));
    assert.ok(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose.includes('maskable')));
    for (const icon of manifest.icons) {
        assert.ok(fs.statSync(path.join(repositoryRoot, icon.src)).size > 0);
    }

    assert.match(index, /rel="manifest" href="manifest\.webmanifest"/);
    assert.match(index, /id="installAppButton"[^>]*>安装到桌面</);
    assert.match(pwa, /beforeinstallprompt/);
    assert.match(pwa, /navigator\.serviceWorker\.register\('\.\/service-worker\.js'\)/);
    assert.match(pwa, /supportedProtocol && !isAndroidAssetHost && window\.isSecureContext/);
    assert.match(serviceWorker, /const APP_SHELL = \[/);
    assert.match(serviceWorker, /'\.\/js\/comic-worker\.js'/);
    assert.match(serviceWorker, /'\.\/js\/android-bridge\.js'/);
    assert.doesNotMatch(serviceWorker, /\.ecomic|long\.png|blob:/);
});

test('Android wrapper loads local HTTPS assets and streams downloads through SAF', () => {
    const manifest = fs.readFileSync(
        path.join(repositoryRoot, 'android-app', 'app', 'src', 'main', 'AndroidManifest.xml'),
        'utf8'
    );
    const activity = fs.readFileSync(
        path.join(repositoryRoot, 'android-app', 'app', 'src', 'main', 'java', 'com', 'ecryptees', 'offline', 'MainActivity.java'),
        'utf8'
    );
    const bridge = fs.readFileSync(path.join(repositoryRoot, 'js', 'android-bridge.js'), 'utf8');
    const appBuild = fs.readFileSync(path.join(repositoryRoot, 'android-app', 'app', 'build.gradle'), 'utf8');
    const buildScript = fs.readFileSync(path.join(repositoryRoot, 'android-app', 'build-apk.ps1'), 'utf8');

    assert.doesNotMatch(manifest, /android\.permission\.INTERNET/);
    assert.doesNotMatch(manifest, /READ_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE/);
    assert.match(manifest, /android:allowBackup="false"/);
    assert.match(manifest, /android:launchMode="singleTop"/);
    assert.match(manifest, /android\.intent\.action\.VIEW/);
    assert.match(manifest, /android\.intent\.action\.SEND/);
    assert.match(manifest, /application\/vnd\.ecryptees\.ecomic/);
    assert.match(manifest, /android:mimeType="\*\/\*"/);
    assert.match(manifest, /android:host="\*" android:scheme="content"/);
    assert.match(manifest, /android:pathPattern="\.\*\\\\\.ecomic"/);
    assert.match(activity, /WebViewAssetLoader\.AssetsPathHandler/);
    assert.match(activity, /https:\/\/appassets\.androidplatform\.net\/assets\/index\.html/);
    assert.match(activity, /Intent\.ACTION_CREATE_DOCUMENT/);
    assert.match(activity, /Intent\.ACTION_OPEN_DOCUMENT|params\.createIntent\(\)/);
    assert.match(activity, /writeChunk\(String token, String base64Data\)/);
    assert.match(activity, /ImageDecoder\.decodeBitmap/);
    assert.match(activity, /beginHeicDecode\(String ignoredName\)/);
    assert.match(activity, /writeHeicChunk\(String token, String base64Data\)/);
    assert.match(activity, /commitHeicDecode\(String token, int maxDimension\)/);
    assert.match(activity, /getHeicDecodeStatus\(String token\)/);
    assert.match(activity, /readHeicChunk\(String token, long offset, int requestedLength\)/);
    assert.match(activity, /Executors\.newFixedThreadPool\(2\)/);
    assert.match(activity, /new Semaphore\(1, true\)/);
    assert.match(activity, /Bitmap\.CompressFormat\.PNG/);
    assert.match(activity, /protected void onNewIntent/);
    assert.match(activity, /Intent\.ACTION_SEND\.equals\(intent\.getAction\(\)\)/);
    assert.match(activity, /Intent\.EXTRA_STREAM, Uri\.class/);
    assert.match(activity, /clipData\.getItemCount\(\) > 1/);
    assert.match(activity, /OpenableColumns\.DISPLAY_NAME/);
    assert.match(activity, /endsWith\("\.ecomic"\)/);
    assert.match(activity, /claimIncomingDocument\(\)/);
    assert.match(activity, /readIncomingChunk\(String token, int requestedLength\)/);
    assert.match(activity, /finishIncomingDocument\(String token\)/);
    assert.match(activity, /MAX_INCOMING_ARCHIVE_BYTES/);
    assert.match(bridge, /response\.body\.getReader\(\)/);
    assert.match(bridge, /bridge\.writeChunk\(token, encodeBase64\(value\)\)/);
    assert.match(bridge, /EcrypteesAndroidMedia/);
    assert.match(bridge, /bridge\.commitHeicDecode\(token, maxDimension\)/);
    assert.match(bridge, /bridge\.getHeicDecodeStatus\(token\)/);
    assert.match(bridge, /activeMediaTasks < 2/);
    assert.match(bridge, /ecryptees-download-result/);
    assert.match(bridge, /emitDownloadResult\('success'/);
    assert.match(bridge, /emitDownloadResult\('cancelled'/);
    assert.match(bridge, /emitDownloadResult\('failed'/);
    assert.match(bridge, /application\/vnd\.ecryptees\.ecomic/);
    assert.match(bridge, /navigator\.storage\?\.getDirectory/);
    assert.match(bridge, /ECOMIC_MAGIC/);
    assert.match(bridge, /ecryptees-open-archive/);
    assert.match(bridge, /readIncomingChunk\(token, INCOMING_CHUNK_BYTES\)/);
    assert.doesNotMatch(bridge, /mediaQueue|queueMediaTask|finishHeicDecode/);
    assert.doesNotMatch(bridge, /await response\.arrayBuffer\(\)|await response\.blob\(\)/);
    assert.match(appBuild, /include 'js\/\*\*'/);
    assert.match(appBuild, /androidx\.webkit:webkit:1\.16\.0/);
    assert.match(buildScript, /apksigner\.bat/);
    assert.match(buildScript, /91306e7c15932646a58ffbd3443f541be57401f1f64106d8dcd0e97fbc5687e8/);
    assert.match(buildScript, /output-metadata\.json/);
    assert.match(buildScript, /Ecryptees-v\$versionName\.apk/);
    assert.match(buildScript, /APK version mismatch/);
});

test('JPG and JPEG remain selectable in browsers and Android document providers', () => {
    const index = fs.readFileSync(path.join(repositoryRoot, 'index.html'), 'utf8');
    const activity = fs.readFileSync(
        path.join(repositoryRoot, 'android-app', 'app', 'src', 'main', 'java', 'com', 'ecryptees', 'offline', 'MainActivity.java'),
        'utf8'
    );
    const appBuild = fs.readFileSync(path.join(repositoryRoot, 'android-app', 'app', 'build.gradle'), 'utf8');
    const serviceWorker = fs.readFileSync(path.join(repositoryRoot, 'service-worker.js'), 'utf8');
    const imageInput = index.match(/<input[\s\S]*?\bid="imageFile"[\s\S]*?>/)?.[0] || '';
    const comicInput = index.match(/<input[\s\S]*?\bid="comicFiles"[\s\S]*?>/)?.[0] || '';
    const jpegBytes = fs.readFileSync(path.join(repositoryRoot, 'assets', 'background.jpg'));

    assert.equal(globalThis.Ecryptees.core.image.sniffImageType(jpegBytes).mime, 'image/jpeg');

    for (const input of [imageInput, comicInput]) {
        assert.match(input, /accept="[^"]*\.jpg(?:,|")/);
        assert.match(input, /accept="[^"]*\.jpeg(?:,|")/);
        assert.match(input, /accept="[^"]*image\/jpeg(?:,|")/);
        assert.match(input, /accept="[^"]*\.heic(?:,|")/);
        assert.match(input, /accept="[^"]*\.heif(?:,|")/);
        assert.match(input, /accept="[^"]*image\/heic(?:,|")/);
        assert.match(input, /accept="[^"]*image\/heif(?:,|")/);
    }

    assert.match(activity, /params\.getAcceptTypes\(\)/);
    assert.match(activity, /createImageDocumentIntent\(params\)/);
    assert.match(appBuild, /versionCode 11/);
    assert.match(appBuild, /versionName '1\.0\.10'/);
    assert.match(serviceWorker, /const CACHE_NAME = 'ecryptees-app-v10'/);
});

test('Android comic picker returns every readable document without trusting provider MIME metadata', () => {
    const activity = fs.readFileSync(
        path.join(repositoryRoot, 'android-app', 'app', 'src', 'main', 'java', 'com', 'ecryptees', 'offline', 'MainActivity.java'),
        'utf8'
    );
    const appBuild = fs.readFileSync(path.join(repositoryRoot, 'android-app', 'app', 'build.gradle'), 'utf8');

    assert.match(activity, /new Intent\(Intent\.ACTION_OPEN_DOCUMENT\)/);
    assert.match(activity, /intent\.setType\("\*\/\*"\)/);
    assert.match(activity, /Intent\.EXTRA_ALLOW_MULTIPLE/);
    assert.match(activity, /data\.getClipData\(\)/);
    assert.match(activity, /getContentResolver\(\)\.openFileDescriptor\(uri, "r"\)/);
    assert.match(activity, /parseImageDocumentResult\(resultCode, data\)/);
    assert.match(appBuild, /versionCode 11/);
    assert.match(appBuild, /versionName '1\.0\.10'/);
});
