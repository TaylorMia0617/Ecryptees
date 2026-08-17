(async function () {
    'use strict';

    const bridge = globalThis.AndroidRenderedCapture;
    const token = String(globalThis.__ECRYPTEES_CAPTURE_TOKEN__ || '');
    const maximum = Math.max(1, Math.min(80, Number(globalThis.__ECRYPTEES_CAPTURE_MAXIMUM__) || 80));
    const READER_SETTLE_CYCLES = 6;
    delete globalThis.__ECRYPTEES_CAPTURE_TOKEN__;
    delete globalThis.__ECRYPTEES_CAPTURE_MAXIMUM__;
    const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    const captureStateKey = `ecryptees-capture-${token}`;
    let restoredState = {};
    try {
        restoredState = JSON.parse(sessionStorage.getItem(captureStateKey) || '{}');
    } catch (error) {
        restoredState = {};
    }
    const capturedSources = new Set(Array.isArray(restoredState.sources) ? restoredState.sources : []);
    const failedSources = new Set();
    let mutationVersion = 0;
    const mutationObserver = new MutationObserver(records => {
        if (records.some(record => record.type === 'childList'
            || ['src', 'srcset', 'data-src', 'data-original', 'data-lazy-src'].includes(record.attributeName))) {
            mutationVersion += 1;
        }
    });
    mutationObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['src', 'srcset', 'data-src', 'data-original', 'data-lazy-src'],
        childList: true,
        subtree: true
    });
    let capturedCount = Math.max(
        Array.isArray(restoredState.sources) ? restoredState.sources.length : 0,
        typeof bridge?.getRenderedImageCount === 'function'
            ? Number(await Promise.resolve(bridge.getRenderedImageCount(token))) || 0
            : 0
    );

    function saveCaptureState(extra = {}) {
        try {
            sessionStorage.setItem(captureStateKey, JSON.stringify({
                sources: Array.from(capturedSources).slice(-maximum),
                resumeIndex: Number(restoredState.resumeIndex) || 0,
                ...extra
            }));
            restoredState = { ...restoredState, ...extra };
        } catch (error) {
            // The native task still retains already completed images.
        }
    }

    function elementLabel(element) {
        return `${element?.tagName || ''} ${element?.id || ''} ${element?.className || ''} ${element?.getAttribute?.('role') || ''}`;
    }

    function hasExcludedContext(image) {
        let element = image;
        for (let depth = 0; element && depth < 6; depth += 1, element = element.parentElement) {
            if (/^(?:NAV|HEADER|FOOTER|ASIDE|BUTTON)$/i.test(element.tagName || '')) {
                return true;
            }
            if (/(?:avatar|icon|logo|comment|recommend|related|advert|banner|toolbar|menu|float|cover|catalog|chapter-list)/i.test(elementLabel(element))) {
                return true;
            }
        }
        return false;
    }

    function isUsableImage(image) {
        const source = image.currentSrc || image.src || '';
        return /^(blob:|data:image\/|https:\/\/)/i.test(source)
            && !failedSources.has(source)
            && !hasExcludedContext(image)
            && image.naturalWidth >= 120
            && image.naturalHeight >= 180
            && image.naturalWidth * image.naturalHeight >= 80000;
    }

    function containerScore(container, images) {
        const label = elementLabel(container);
        let score = images.length * 30;
        if (/(?:reader|viewer|comic|chapter|page|panel|slide|image|picture|photo)/i.test(label)) score += 140;
        if (/(?:recommend|related|comment|avatar|icon|cover|banner|catalog|list)/i.test(label)) score -= 220;
        score += images.reduce((total, image) => {
            const ratio = image.naturalHeight / Math.max(1, image.naturalWidth);
            return total + (ratio >= 1 ? 12 : 0) + (image.naturalWidth >= 600 ? 10 : 0);
        }, 0);
        return score;
    }

    function imageElements() {
        const usable = Array.from(document.images).filter(isUsableImage);
        if (usable.length <= 1) {
            return usable;
        }
        const groups = new Map();
        for (const image of usable) {
            let container = image.parentElement;
            for (let depth = 0; container && depth < 5; depth += 1, container = container.parentElement) {
                if (container === document.body || container === document.documentElement) {
                    break;
                }
                const images = groups.get(container) || [];
                images.push(image);
                groups.set(container, images);
            }
        }
        const best = Array.from(groups.entries())
            .map(([container, images]) => ({ container, images, score: containerScore(container, images) }))
            .sort((left, right) => right.score - left.score || right.images.length - left.images.length)[0];
        return best?.images || usable;
    }

    function findReaderLink() {
        const current = new URL(location.href);
        const choices = Array.from(document.querySelectorAll('a[href]')).map(anchor => {
            let url;
            try {
                url = new URL(anchor.href, current);
            } catch (error) {
                return null;
            }
            if (url.protocol !== 'https:' || url.href === current.href || url.origin !== current.origin) {
                return null;
            }
            const label = `${anchor.id} ${anchor.className} ${anchor.getAttribute('aria-label') || ''} ${anchor.title} ${anchor.textContent}`;
            let score = 0;
            if (/(?:reader|viewer|read-online)/i.test(`${url.pathname} ${label}`)) score += 4;
            if (/(?:read online|开始阅读|在线阅读|阅读|看图)/i.test(label)) score += 3;
            if (/^(?:#|javascript:)/i.test(anchor.getAttribute('href') || '')) score -= 6;
            return score > 0 ? { url: url.href, score } : null;
        }).filter(Boolean).sort((left, right) => right.score - left.score);
        return choices[0]?.url || '';
    }

    function findPageSelect() {
        return Array.from(document.querySelectorAll('select'))
            .map(select => {
                const label = `${select.id} ${select.name} ${select.className} ${select.getAttribute('aria-label') || ''}`;
                const eligible = select.options.length > 1
                    && select.options.length <= 500
                    && /(?:page|panel|slide|image|页|张)/i.test(label);
                const visible = eligible
                    && select.getClientRects().length > 0
                    && !select.closest('.hidden, [hidden], [aria-hidden="true"]');
                return { select, eligible, visible };
            })
            .filter(candidate => candidate.eligible)
            .sort((left, right) => Number(right.visible) - Number(left.visible)
                || right.select.options.length - left.select.options.length)[0]?.select || null;
    }

    function findNextControl() {
        const controls = Array.from(document.querySelectorAll('button, a[href], [role="button"]'));
        return controls.find(control => {
            const label = `${control.id} ${control.className} ${control.getAttribute('aria-label') || ''} ${control.title} ${control.textContent}`;
            const disabled = control.disabled
                || control.getAttribute('aria-disabled') === 'true'
                || control.classList.contains('disabled');
            return !disabled
                && /(?:next[-_ ]?(?:page|panel)|下一页|下页|后一页)/i.test(label)
                && !/(?:chapter|scene|章节|下一章)/i.test(label);
        }) || null;
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

    async function captureImage(image) {
        if (capturedCount >= maximum) {
            return false;
        }
        const source = image.currentSrc || image.src || '';
        if (!source || capturedSources.has(source)) {
            return false;
        }
        if (/^https:\/\//i.test(source)) {
            if (typeof bridge.addRenderedPageSource !== 'function'
                    || !await Promise.resolve(bridge.addRenderedPageSource(token, source))) {
                throw new Error(`第 ${capturedCount + 1} 张动态图片地址无法写入任务`);
            }
            capturedSources.add(source);
            capturedCount += 1;
            saveCaptureState();
            return true;
        }
        try {
            const response = await fetch(source, { credentials: 'omit', cache: 'no-store' });
            if (!response.ok) {
                throw new Error(`第 ${capturedCount + 1} 张动态图片读取失败：HTTP ${response.status}`);
            }
            const blob = await response.blob();
            const mime = blob.type || 'image/jpeg';
            if (!mime.startsWith('image/') || blob.size <= 0) {
                throw new Error(`第 ${capturedCount + 1} 张动态图片内容无效`);
            }
            const order = capturedCount;
            const capturedIndex = Number(await Promise.resolve(bridge.beginRenderedImage(
                token,
                order,
                safeName(source, order, mime),
                mime,
                blob.size
            )));
            if (!Number.isInteger(capturedIndex) || capturedIndex < 0) {
                throw new Error(`第 ${order + 1} 张动态图片无法写入临时空间`);
            }
            for (let offset = 0; offset < blob.size; offset += 192 * 1024) {
                const bytes = new Uint8Array(await blob.slice(offset, offset + 192 * 1024).arrayBuffer());
                if (!await Promise.resolve(bridge.writeRenderedImageChunk(token, capturedIndex, encodeBase64(bytes)))) {
                    throw new Error(`第 ${order + 1} 张动态图片写入失败`);
                }
            }
            if (!await Promise.resolve(bridge.finishRenderedImage(token, capturedIndex))) {
                throw new Error(`第 ${order + 1} 张动态图片写入不完整`);
            }
            capturedSources.add(source);
            capturedCount += 1;
            saveCaptureState();
            return true;
        } catch (error) {
            failedSources.add(source);
            throw error;
        }
    }

    async function captureCurrentImages() {
        let added = 0;
        for (const image of imageElements()) {
            if (capturedCount >= maximum) {
                break;
            }
            try {
                if (await captureImage(image)) {
                    added += 1;
                }
            } catch (error) {
                // A failed decorative or expired image must not stop the remaining reader sequence.
            }
        }
        return added;
    }

    async function waitForImages(attempts = 24) {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            const lazyImages = Array.from(document.querySelectorAll('img[data-original], img[data-src], img[data-lazy-src]'));
            const target = lazyImages[Math.min(attempt, Math.max(0, lazyImages.length - 1))];
            target?.scrollIntoView({ block: 'center', behavior: 'auto' });
            const before = mutationVersion;
            await sleep(attempt < 3 ? 250 : 500);
            if (imageElements().length) {
                return;
            }
            if (mutationVersion === before && attempt > 4) {
                scrollBy(0, Math.max(420, Math.round(innerHeight * 0.7)));
            }
        }
    }

    try {
        if (!bridge || !token) {
            throw new Error('动态网页捕获通道不可用');
        }

        await waitForImages();
        if (imageElements().length <= 5) {
            const readerUrl = findReaderLink();
            const navigationKey = `ecryptees-reader-${token}`;
            if (readerUrl && sessionStorage.getItem(navigationKey) !== readerUrl) {
                sessionStorage.setItem(navigationKey, readerUrl);
                if (typeof bridge.navigateRenderedPage === 'function'
                        && await Promise.resolve(bridge.navigateRenderedPage(token, readerUrl))) {
                    return;
                }
            }
        }

        await captureCurrentImages();
        const pageSelect = findPageSelect();
        if (pageSelect) {
            const pageCount = Math.min(maximum, pageSelect.options.length);
            const resumeIndex = Math.max(0, Math.min(pageCount - 1, Number(restoredState.resumeIndex) || 0));
            for (let index = resumeIndex; index < pageCount && capturedCount < maximum; index += 1) {
                if (pageSelect.selectedIndex !== index) {
                    saveCaptureState({ resumeIndex: index });
                    pageSelect.selectedIndex = index;
                    pageSelect.dispatchEvent(new Event('input', { bubbles: true }));
                    pageSelect.dispatchEvent(new Event('change', { bubbles: true }));
                }
                await sleep(700);
                await waitForImages();
                await captureCurrentImages();
                saveCaptureState({ resumeIndex: index + 1 });
            }
        } else {
            let stableBottomCycles = 0;
            for (let cycle = 0; cycle < 160 && capturedCount < maximum; cycle += 1) {
                const added = await captureCurrentImages();
                const documentHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
                const atBottom = scrollY + innerHeight >= documentHeight - 32;
                if (added) {
                    stableBottomCycles = 0;
                } else if (atBottom) {
                    stableBottomCycles += 1;
                }
                if (atBottom && stableBottomCycles >= READER_SETTLE_CYCLES) {
                    const next = findNextControl();
                    if (!next) {
                        break;
                    }
                    const before = location.href;
                    next.click();
                    await sleep(900);
                    await waitForImages();
                    const nextAdded = await captureCurrentImages();
                    if (!nextAdded && location.href === before) {
                        stableBottomCycles += 1;
                    } else {
                        stableBottomCycles = 0;
                    }
                    if (stableBottomCycles >= 6) {
                        break;
                    }
                } else {
                    const images = imageElements();
                    const pending = images.find(image => !capturedSources.has(image.currentSrc || image.src || ''));
                    if (pending) {
                        pending.scrollIntoView({ block: 'center', behavior: 'auto' });
                    } else if (!atBottom) {
                        scrollBy(0, Math.max(420, Math.round(innerHeight * 0.72)));
                    } else {
                        scrollTo(0, documentHeight);
                    }
                    await sleep(pending ? 450 : 700);
                }
            }
        }

        if (!capturedCount) {
            throw new Error('页面运行完成后仍未找到漫画图片');
        }
        await Promise.resolve(bridge.finishRenderedPage(token, capturedCount));
    } catch (error) {
        await Promise.resolve(bridge?.failRenderedPage(token, error?.message || '动态网页分析失败'));
    } finally {
        mutationObserver.disconnect();
        scrollTo(0, 0);
    }
})();
