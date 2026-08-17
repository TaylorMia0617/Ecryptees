const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('Tauri desktop package keeps the local shell offline and builds only bundled assets', () => {
    const packageJson = JSON.parse(read('package.json'));
    const config = JSON.parse(read('src-tauri/tauri.conf.json'));
    const prepare = read('scripts/prepare-desktop.ps1');

    assert.equal(packageJson.version, '1.1.5');
    assert.equal(packageJson.devDependencies['@tauri-apps/cli'], '2.11.4');
    assert.match(packageJson.scripts['desktop:build'], /build-desktop\.ps1/);
    assert.equal(config.version, '1.1.5');
    assert.deepEqual(config.bundle.targets, ['nsis']);
    assert.equal(config.bundle.windows.webviewInstallMode.type, 'offlineInstaller');
    assert.equal(config.build.frontendDist, '../desktop-dist');
    assert.match(config.build.beforeBuildCommand, /-File scripts\/prepare-desktop\.ps1$/);
    assert.doesNotMatch(config.build.beforeBuildCommand, /\.\.\/scripts/);
    assert.match(prepare, /'assets', 'css', 'js'/);
    assert.doesNotMatch(prepare, /android-app|tests|design-qa/);
    assert.doesNotMatch(JSON.stringify(config), /https?:\/\/(?!schema\.tauri\.app|ipc\.localhost|asset\.localhost)/);
});

test('release uses the GUI subsystem and desktop web imports use a bounded native bridge', () => {
    const main = read('src-tauri/src/main.rs');
    const rust = read('src-tauri/src/network.rs');
    const bridge = read('js/desktop-network.js');
    const comic = read('js/comic-app.js');
    const config = JSON.parse(read('src-tauri/tauri.conf.json'));

    assert.match(main, /cfg_attr\(not\(debug_assertions\), windows_subsystem = "windows"\)/);
    assert.match(rust, /const MAX_HTML_BYTES: u64 = 5 \* 1024 \* 1024/);
    assert.match(rust, /const MAX_IMAGE_BYTES: u64 = 500 \* 1024 \* 1024/);
    assert.match(rust, /const MAX_REDIRECTS: usize = 5/);
    assert.match(rust, /const MAX_ACTIVE_TASKS: usize = 2/);
    assert.match(rust, /resolve_to_addrs/);
    assert.match(rust, /\.no_proxy\(\)/);
    assert.match(rust, /不能读取本机或局域网地址/);
    assert.match(rust, /fake-ip-filter/);
    assert.match(rust, /cf-mitigated/);
    assert.match(rust, /cloudflareChallenge/);
    assert.match(bridge, /read_desktop_network_chunk/);
    assert.match(bridge, /normalizeBytes/);
    assert.match(comic, /const nativeNetwork = isAndroidRuntime \? androidNetwork : desktopNetwork/);
    assert.match(comic, /hasNativeNetwork/);
    assert.doesNotMatch(config.app.security.csp, /connect-src[^;]*https:/);
});

test('Windows dynamic capture is isolated, token scoped, and blocks private resources', () => {
    const rust = read('src-tauri/src/render_capture.rs');
    const bridge = read('js/desktop-network.js');
    const comic = read('js/comic-app.js');
    const capability = JSON.parse(read('src-tauri/capabilities/capture.json'));

    assert.equal(capability.local, false);
    assert.deepEqual(capability.windows, ['capture-*']);
    assert.deepEqual(capability.permissions, ['core:event:allow-emit']);
    assert.match(rust, /WebviewUrl::External\(Url::parse\("about:blank"\)/);
    assert.match(rust, /AddWebResourceRequestedFilter/);
    assert.match(rust, /validate_public_url/);
    assert.match(rust, /COREWEBVIEW2_PERMISSION_STATE_DENY/);
    assert.match(rust, /on_new_window\(\|_, _\| NewWindowResponse::Deny\)/);
    assert.match(rust, /on_download\(\|_, _\| false\)/);
    assert.match(rust, /awaitingVerification/);
    assert.match(rust, /Ecryptees 网页验证/);
    assert.match(rust, /pageReady/);
    assert.match(rust, /data_directory\(task\.browser_directory\.clone\(\)\)/);
    assert.match(rust, /MAX_CAPTURE_BYTES: u64 = 500 \* 1024 \* 1024/);
    assert.match(rust, /MAX_NAVIGATIONS: usize = 5/);
    assert.match(bridge, /begin_desktop_rendered_page_capture/);
    assert.match(bridge, /interactiveVerification/);
    assert.match(bridge, /read_desktop_rendered_page_image_chunk/);
    assert.match(comic, /const renderedNetwork = isAndroidRuntime \? androidNetwork : desktopNetwork/);
    assert.match(comic, /requiresInteractiveVerification/);
});

test('desktop bridge uses scoped kinds and fixed-size raw chunks', () => {
    const bridge = read('js/desktop-storage.js');
    const rust = read('src-tauri/src/lib.rs');

    assert.match(bridge, /\['image', 'comic', 'video'\]/);
    assert.match(bridge, /4 \* 1024 \* 1024/);
    assert.match(bridge, /x-ecryptees-token/);
    assert.match(bridge, /abort_asset_write/);
    assert.match(bridge, /ecryptees-desktop-cache/);
    assert.match(rust, /const RESERVE_BYTES: u64 = 64 \* 1024 \* 1024/);
    assert.match(rust, /validate_asset_id/);
    assert.match(rust, /trash::delete/);
    assert.match(rust, /paths_overlap/);
    assert.match(rust, /managed_asset_directories/);
});

test('desktop settings expose three separate locations and migration choices', () => {
    const html = read('index.html');
    const settings = read('js/settings.js');
    const serviceWorker = read('service-worker.js');

    for (const label of ['图片保存路径', '漫画保存路径', '视频保存路径']) {
        assert.match(html, new RegExp(label));
    }
    assert.match(html, /迁移已有资产/);
    assert.match(html, /仅供新资产使用/);
    assert.match(settings, /desktopStorage\.setRoot/);
    assert.match(settings, /value\.warnings/);
    assert.match(serviceWorker, /js\/desktop-storage\.js/);
});
