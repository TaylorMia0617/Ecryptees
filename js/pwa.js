(function () {
    'use strict';

    const installRow = document.getElementById('installAppRow');
    const installButton = document.getElementById('installAppButton');
    const supportedProtocol = location.protocol === 'https:'
        || (location.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(location.hostname));
    const isAndroidAssetHost = location.hostname === 'appassets.androidplatform.net';
    let installPrompt = null;

    function isStandalone() {
        return window.matchMedia('(display-mode: standalone)').matches
            || window.navigator.standalone === true;
    }

    function hideInstallAction() {
        installPrompt = null;
        if (installRow) installRow.hidden = true;
    }

    window.addEventListener('beforeinstallprompt', event => {
        event.preventDefault();
        installPrompt = event;
        if (installRow && !isStandalone()) installRow.hidden = false;
    });

    window.addEventListener('appinstalled', hideInstallAction);

    if (installButton) {
        installButton.addEventListener('click', async () => {
            if (!installPrompt) return;
            installButton.disabled = true;
            try {
                await installPrompt.prompt();
                await installPrompt.userChoice;
            } finally {
                installButton.disabled = false;
                hideInstallAction();
            }
        });
    }

    if ('serviceWorker' in navigator && supportedProtocol && !isAndroidAssetHost && window.isSecureContext) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./service-worker.js').catch(error => {
                console.warn('离线应用注册失败：', error);
            });
        });
    }
})();
