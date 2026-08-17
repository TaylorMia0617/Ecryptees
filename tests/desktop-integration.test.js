const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('Tauri desktop package stays offline and builds only the web shell', () => {
    const packageJson = JSON.parse(read('package.json'));
    const config = JSON.parse(read('src-tauri/tauri.conf.json'));
    const prepare = read('scripts/prepare-desktop.ps1');

    assert.equal(packageJson.version, '1.1.4');
    assert.equal(packageJson.devDependencies['@tauri-apps/cli'], '2.11.4');
    assert.match(packageJson.scripts['desktop:build'], /build-desktop\.ps1/);
    assert.equal(config.version, '1.1.4');
    assert.deepEqual(config.bundle.targets, ['nsis']);
    assert.equal(config.bundle.windows.webviewInstallMode.type, 'offlineInstaller');
    assert.equal(config.build.frontendDist, '../desktop-dist');
    assert.match(config.build.beforeBuildCommand, /-File scripts\/prepare-desktop\.ps1$/);
    assert.doesNotMatch(config.build.beforeBuildCommand, /\.\.\/scripts/);
    assert.match(prepare, /'assets', 'css', 'js'/);
    assert.doesNotMatch(prepare, /android-app|tests|design-qa/);
    assert.doesNotMatch(JSON.stringify(config), /https?:\/\/(?!schema\.tauri\.app|ipc\.localhost|asset\.localhost)/);
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
