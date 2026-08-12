(function (root) {
    'use strict';

    const LOCK_STORAGE_KEY = 'ecryptees-app-lock-v1';
    const LOCK_VERSION = 1;
    const LOCK_ITERATIONS = 210000;
    const VERSION_FALLBACK = Object.freeze({ versionName: '1.0.13', versionCode: 14 });
    const nativeBridge = root.AndroidFileBridge || null;

    let unlockResolve;
    const whenUnlocked = new Promise(resolve => {
        unlockResolve = resolve;
    });
    let unlocked = false;
    let lockRecord = null;
    let lockRecordCorrupted = false;
    let failedUnlockAttempts = 0;
    let unlockCooldownUntil = 0;

    const settingsDialog = document.getElementById('appSettingsDialog');
    const pinDialog = document.getElementById('appPinDialog');
    const unlockDialog = document.getElementById('appUnlockDialog');
    const lockSummary = document.getElementById('appLockSummary');
    const configureLockButton = document.getElementById('configureAppLockButton');
    const disableLockButton = document.getElementById('disableAppLockButton');
    const disguiseToggle = document.getElementById('launcherDisguiseToggle');
    const disguiseSummary = document.getElementById('launcherDisguiseSummary');

    function bytesToBase64(bytes) {
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        return btoa(binary);
    }

    function base64ToBytes(value) {
        const binary = atob(value);
        return Uint8Array.from(binary, character => character.charCodeAt(0));
    }

    function isValidPin(value) {
        return /^\d{4}$/.test(value);
    }

    function validateLockRecord(value) {
        if (!value || value.version !== LOCK_VERSION || value.iterations !== LOCK_ITERATIONS) {
            return false;
        }
        if (typeof value.salt !== 'string' || typeof value.hash !== 'string') {
            return false;
        }
        try {
            return base64ToBytes(value.salt).byteLength === 16
                && base64ToBytes(value.hash).byteLength === 32;
        } catch (error) {
            return false;
        }
    }

    function readLockRecord() {
        let encoded;
        try {
            encoded = root.localStorage.getItem(LOCK_STORAGE_KEY);
        } catch (error) {
            return { record: null, corrupted: true };
        }
        if (!encoded) {
            return { record: null, corrupted: false };
        }
        try {
            const parsed = JSON.parse(encoded);
            return validateLockRecord(parsed)
                ? { record: parsed, corrupted: false }
                : { record: null, corrupted: true };
        } catch (error) {
            return { record: null, corrupted: true };
        }
    }

    async function derivePinHash(pin, salt, iterations = LOCK_ITERATIONS) {
        if (!root.crypto?.subtle) {
            throw new Error('当前系统不支持安全保存应用锁');
        }
        const key = await root.crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(pin),
            'PBKDF2',
            false,
            ['deriveBits']
        );
        const bits = await root.crypto.subtle.deriveBits({
            name: 'PBKDF2',
            hash: 'SHA-256',
            salt,
            iterations
        }, key, 256);
        return new Uint8Array(bits);
    }

    async function createLockRecord(pin) {
        const salt = root.crypto.getRandomValues(new Uint8Array(16));
        const hash = await derivePinHash(pin, salt);
        return {
            version: LOCK_VERSION,
            iterations: LOCK_ITERATIONS,
            salt: bytesToBase64(salt),
            hash: bytesToBase64(hash)
        };
    }

    async function verifyPin(pin, record = lockRecord) {
        if (!record || !isValidPin(pin)) {
            return false;
        }
        const expected = base64ToBytes(record.hash);
        const actual = await derivePinHash(pin, base64ToBytes(record.salt), record.iterations);
        if (actual.byteLength !== expected.byteLength) {
            return false;
        }
        let difference = 0;
        for (let index = 0; index < actual.byteLength; index += 1) {
            difference |= actual[index] ^ expected[index];
        }
        return difference === 0;
    }

    function setLockRecord(record) {
        root.localStorage.setItem(LOCK_STORAGE_KEY, JSON.stringify(record));
        lockRecord = record;
        lockRecordCorrupted = false;
        updateLockSettings();
    }

    function clearLockRecord() {
        root.localStorage.removeItem(LOCK_STORAGE_KEY);
        lockRecord = null;
        lockRecordCorrupted = false;
        updateLockSettings();
    }

    function completeUnlock() {
        if (unlocked) {
            return;
        }
        unlocked = true;
        document.body.dataset.lockState = 'unlocked';
        if (unlockDialog.open) {
            unlockDialog.close();
        }
        unlockResolve();
        document.dispatchEvent(new CustomEvent('ecryptees-app-unlocked'));
    }

    function showUnlockScreen(message = '') {
        document.body.dataset.lockState = 'locked';
        const error = document.getElementById('appUnlockError');
        error.textContent = message;
        error.hidden = !message;
        if (!unlockDialog.open) {
            unlockDialog.showModal();
        }
        root.requestAnimationFrame(() => document.getElementById('unlockAppPin').focus());
    }

    function updateLockSettings() {
        if (lockRecordCorrupted) {
            lockSummary.textContent = '应用锁数据异常；只能清除应用数据或卸载恢复';
            configureLockButton.disabled = true;
            disableLockButton.hidden = true;
            return;
        }
        const enabled = !!lockRecord;
        lockSummary.textContent = enabled
            ? '已开启；仅在冷启动时要求四位密码'
            : '未开启；用于遮挡应用内容，不会加密书架文件';
        configureLockButton.textContent = enabled ? '修改密码' : '设置应用锁';
        configureLockButton.disabled = false;
        disableLockButton.hidden = !enabled;
    }

    function setPinDialogMode(mode) {
        const changing = mode === 'change';
        const disabling = mode === 'disable';
        pinDialog.dataset.mode = mode;
        document.getElementById('appPinDialogTitle').textContent = disabling
            ? '关闭应用锁'
            : (changing ? '修改应用锁密码' : '设置应用锁');
        document.getElementById('appPinDescription').textContent = disabling
            ? '请输入当前四位密码。关闭后，下次冷启动不再要求解锁。'
            : (changing ? '先验证当前密码，再设置新的四位数字密码。' : '请输入并确认四位数字密码。');
        document.getElementById('currentPinField').hidden = !changing && !disabling;
        document.getElementById('currentAppPin').hidden = !changing && !disabling;
        document.getElementById('newPinField').hidden = disabling;
        document.getElementById('newAppPin').hidden = disabling;
        document.getElementById('confirmPinField').hidden = disabling;
        document.getElementById('confirmAppPin').hidden = disabling;
        document.getElementById('appPinSubmitButton').textContent = disabling ? '确认关闭' : '保存';
        document.getElementById('appPinError').hidden = true;
        document.getElementById('appPinForm').reset();
        pinDialog.showModal();
        root.requestAnimationFrame(() => document.getElementById(changing || disabling ? 'currentAppPin' : 'newAppPin').focus());
    }

    function closePinDialog() {
        document.getElementById('appPinForm').reset();
        document.getElementById('appPinError').hidden = true;
        pinDialog.close();
    }

    function openSettings() {
        root.EcrypteesAppNavigation?.closeDrawer?.(false);
        updateLockSettings();
        if (!settingsDialog.open) {
            settingsDialog.showModal();
        }
    }

    function readNativeVersion() {
        if (typeof nativeBridge?.getAppVersionInfo !== 'function') {
            return VERSION_FALLBACK;
        }
        try {
            const value = JSON.parse(nativeBridge.getAppVersionInfo());
            if (typeof value.versionName === 'string' && Number.isFinite(Number(value.versionCode))) {
                return { versionName: value.versionName, versionCode: Number(value.versionCode) };
            }
        } catch (error) {
            // Use the web package version when the native bridge is unavailable or malformed.
        }
        return VERSION_FALLBACK;
    }

    function initializeDisguiseSetting() {
        if (typeof nativeBridge?.setLauncherDisguiseEnabled !== 'function'
            || typeof nativeBridge?.isLauncherDisguiseEnabled !== 'function') {
            disguiseToggle.disabled = true;
            disguiseSummary.textContent = '仅 Android APK 支持桌面伪装';
            return;
        }
        try {
            disguiseToggle.checked = !!nativeBridge.isLauncherDisguiseEnabled();
            disguiseSummary.textContent = disguiseToggle.checked
                ? 'Android 桌面名称和图标当前显示为“计算器”'
                : '开启后，Android 桌面名称和图标显示为“计算器”';
        } catch (error) {
            disguiseToggle.disabled = true;
            disguiseSummary.textContent = '无法读取 Android 桌面伪装状态';
        }
    }

    document.getElementById('appSettingsButton').addEventListener('click', openSettings);
    document.getElementById('appSettingsCloseButton').addEventListener('click', () => settingsDialog.close());
    configureLockButton.addEventListener('click', () => setPinDialogMode(lockRecord ? 'change' : 'set'));
    disableLockButton.addEventListener('click', () => setPinDialogMode('disable'));
    document.getElementById('appPinCancelButton').addEventListener('click', closePinDialog);

    document.getElementById('appPinForm').addEventListener('submit', async event => {
        event.preventDefault();
        const mode = pinDialog.dataset.mode || 'set';
        const currentPin = document.getElementById('currentAppPin').value;
        const newPin = document.getElementById('newAppPin').value;
        const confirmPin = document.getElementById('confirmAppPin').value;
        const error = document.getElementById('appPinError');
        const submit = document.getElementById('appPinSubmitButton');
        error.hidden = true;
        submit.disabled = true;
        try {
            if ((mode === 'change' || mode === 'disable') && !(await verifyPin(currentPin))) {
                throw new Error('当前密码不正确');
            }
            if (mode === 'disable') {
                clearLockRecord();
                closePinDialog();
                return;
            }
            if (!isValidPin(newPin)) {
                throw new Error('密码必须是四位数字');
            }
            if (newPin !== confirmPin) {
                throw new Error('两次输入的新密码不一致');
            }
            setLockRecord(await createLockRecord(newPin));
            closePinDialog();
        } catch (failure) {
            error.textContent = failure.message || '无法保存应用锁';
            error.hidden = false;
        } finally {
            submit.disabled = false;
        }
    });

    document.getElementById('appUnlockForm').addEventListener('submit', async event => {
        event.preventDefault();
        const pinInput = document.getElementById('unlockAppPin');
        const error = document.getElementById('appUnlockError');
        const submit = document.getElementById('unlockAppButton');
        if (lockRecordCorrupted) {
            error.textContent = '应用锁数据异常。只能清除应用数据或卸载恢复；私有书架与阅读进度会同时删除。';
            error.hidden = false;
            return;
        }
        const remaining = unlockCooldownUntil - Date.now();
        if (remaining > 0) {
            error.textContent = `尝试次数过多，请等待 ${Math.ceil(remaining / 1000)} 秒后再试。`;
            error.hidden = false;
            return;
        }
        submit.disabled = true;
        try {
            if (!(await verifyPin(pinInput.value))) {
                failedUnlockAttempts += 1;
                pinInput.value = '';
                if (failedUnlockAttempts >= 5) {
                    failedUnlockAttempts = 0;
                    unlockCooldownUntil = Date.now() + 30000;
                    throw new Error('尝试次数过多，请等待 30 秒后再试。');
                }
                throw new Error('密码不正确');
            }
            failedUnlockAttempts = 0;
            completeUnlock();
        } catch (failure) {
            error.textContent = failure.message || '无法解锁应用';
            error.hidden = false;
            pinInput.focus();
        } finally {
            submit.disabled = false;
        }
    });

    unlockDialog.addEventListener('cancel', event => event.preventDefault());
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && unlockDialog.open) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);

    disguiseToggle.addEventListener('change', () => {
        const requested = disguiseToggle.checked;
        disguiseToggle.disabled = true;
        try {
            const changed = nativeBridge.setLauncherDisguiseEnabled(requested);
            if (!changed) {
                throw new Error('Android 未能切换桌面入口');
            }
            disguiseSummary.textContent = requested
                ? '桌面已显示为“计算器”；系统设置仍可查看真实应用身份'
                : '桌面已恢复显示为 Ecryptees';
        } catch (error) {
            disguiseToggle.checked = !requested;
            disguiseSummary.textContent = error.message || '桌面伪装切换失败';
        } finally {
            disguiseToggle.disabled = false;
        }
    });

    const version = readNativeVersion();
    document.getElementById('appVersionInfo').textContent = `${version.versionName} · code ${version.versionCode}`;
    initializeDisguiseSetting();
    const initialLock = readLockRecord();
    lockRecord = initialLock.record;
    lockRecordCorrupted = initialLock.corrupted;
    updateLockSettings();
    if (lockRecordCorrupted) {
        showUnlockScreen('应用锁数据异常。只能清除应用数据或卸载恢复；私有书架与阅读进度会同时删除。');
    } else if (lockRecord) {
        showUnlockScreen();
    } else {
        completeUnlock();
    }

    root.EcrypteesAppSecurity = Object.freeze({
        whenUnlocked,
        isUnlocked: () => unlocked
    });
})(globalThis);
