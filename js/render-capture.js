(async function () {
    'use strict';

    const bridge = globalThis.AndroidRenderedCapture;
    const token = String(globalThis.__ECRYPTEES_CAPTURE_TOKEN__ || '');
    const maximum = Math.max(1, Math.min(80, Number(globalThis.__ECRYPTEES_CAPTURE_MAXIMUM__) || 80));
    delete globalThis.__ECRYPTEES_CAPTURE_TOKEN__;
    delete globalThis.__ECRYPTEES_CAPTURE_MAXIMUM__;
    const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

    function imageElements() {
        const container = document.querySelector('#chapter-images, [data-chapter-images], .chapter-images');
        return Array.from((container || document).querySelectorAll('img'))
            .filter(image => {
                const source = image.currentSrc || image.src || '';
                return /^(blob:|data:image\/|https:\/\/)/i.test(source)
                    && image.naturalWidth >= 100
                    && image.naturalHeight >= 100;
            });
    }

    function encodeBase64(bytes) {
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        return btoa(binary);
    }

    function safeName(source, index, mime) {
        try {
            const name = decodeURIComponent(new URL(source).pathname.split('/').pop() || '');
            if (name && /\.[a-z0-9]{2,5}$/i.test(name)) {
                return name;
            }
        } catch (error) {
            // Blob URLs and generated addresses use the deterministic fallback below.
        }
        const extension = mime.includes('png') ? 'png' : (mime.includes('webp') ? 'webp' : 'jpg');
        return `page-${String(index + 1).padStart(3, '0')}.${extension}`;
    }

    try {
        if (!bridge || !token) {
            throw new Error('动态网页捕获通道不可用');
        }
        let images = [];
        let stableCycles = 0;
        let lastCount = -1;
        for (let cycle = 0; cycle < 90; cycle += 1) {
            let targets = Array.from(document.querySelectorAll('#chapter-images .chapter-image'));
            if (!targets.length) {
                targets = Array.from(document.querySelectorAll(
                    '#chapter-images img, [data-chapter-images] img, .chapter-images img'
                ));
            }
            const target = targets[Math.min(cycle, Math.max(0, targets.length - 1))];
            target?.scrollIntoView({ block: 'center', behavior: 'auto' });
            await sleep(cycle < targets.length ? 450 : 750);
            images = imageElements();
            if (images.length > 0 && images.length === lastCount) {
                stableCycles += 1;
            } else {
                stableCycles = 0;
            }
            lastCount = images.length;
            const expected = document.querySelectorAll('#chapter-images .chapter-image').length;
            if (stableCycles >= 3 && (!expected || images.length >= expected)) {
                break;
            }
        }
        images = imageElements().slice(0, maximum);
        if (!images.length) {
            throw new Error('页面运行完成后仍未找到漫画图片');
        }

        for (let index = 0; index < images.length; index += 1) {
            const source = images[index].currentSrc || images[index].src;
            const response = await fetch(source, { credentials: 'omit', cache: 'no-store' });
            if (!response.ok) {
                throw new Error(`第 ${index + 1} 张动态图片读取失败：HTTP ${response.status}`);
            }
            const blob = await response.blob();
            const mime = blob.type || 'image/jpeg';
            if (!mime.startsWith('image/') || blob.size <= 0) {
                throw new Error(`第 ${index + 1} 张动态图片内容无效`);
            }
            if (!bridge.beginRenderedImage(token, index, safeName(source, index, mime), mime, blob.size)) {
                throw new Error(`第 ${index + 1} 张动态图片无法写入临时空间`);
            }
            for (let offset = 0; offset < blob.size; offset += 192 * 1024) {
                const bytes = new Uint8Array(await blob.slice(offset, offset + 192 * 1024).arrayBuffer());
                if (!bridge.writeRenderedImageChunk(token, index, encodeBase64(bytes))) {
                    throw new Error(`第 ${index + 1} 张动态图片写入失败`);
                }
            }
            if (!bridge.finishRenderedImage(token, index)) {
                throw new Error(`第 ${index + 1} 张动态图片写入不完整`);
            }
        }
        bridge.finishRenderedPage(token, images.length);
    } catch (error) {
        bridge?.failRenderedPage(token, error?.message || '动态网页分析失败');
    } finally {
        scrollTo(0, 0);
    }
})();
