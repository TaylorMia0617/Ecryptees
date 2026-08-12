(function initializeWebImportCore(root) {
    'use strict';

    const MAX_CANDIDATES = 500;
    const LAZY_ATTRIBUTES = Object.freeze(['data-original', 'data-src', 'data-lazy-src']);
    const EIGHTEEN_COMIC_HOSTS = Object.freeze(new Set([
        '18comic.vip',
        '18comic.org',
        'jmcomic.me',
        'jmcomic1.me',
        'jm-comic1.art',
        'jm-comic2.art',
        'jm-comic3.art'
    ]));

    function rotateLeft(value, amount) {
        return (value << amount) | (value >>> (32 - amount));
    }

    function md5Hex(value) {
        const source = new TextEncoder().encode(String(value || ''));
        const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
        const bytes = new Uint8Array(paddedLength);
        bytes.set(source);
        bytes[source.length] = 0x80;
        const bitLength = BigInt(source.length) * 8n;
        for (let index = 0; index < 8; index += 1) {
            bytes[paddedLength - 8 + index] = Number((bitLength >> BigInt(index * 8)) & 0xffn);
        }
        const shifts = [
            7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
            5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
            4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
            6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
        ];
        const constants = Array.from({ length: 64 }, (_, index) =>
            Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) | 0);
        let a0 = 0x67452301;
        let b0 = 0xefcdab89 | 0;
        let c0 = 0x98badcfe | 0;
        let d0 = 0x10325476;

        for (let offset = 0; offset < bytes.length; offset += 64) {
            const words = new Int32Array(16);
            for (let index = 0; index < 16; index += 1) {
                const start = offset + index * 4;
                words[index] = bytes[start]
                    | (bytes[start + 1] << 8)
                    | (bytes[start + 2] << 16)
                    | (bytes[start + 3] << 24);
            }
            let a = a0;
            let b = b0;
            let c = c0;
            let d = d0;
            for (let index = 0; index < 64; index += 1) {
                let mix;
                let wordIndex;
                if (index < 16) {
                    mix = (b & c) | (~b & d);
                    wordIndex = index;
                } else if (index < 32) {
                    mix = (d & b) | (~d & c);
                    wordIndex = (5 * index + 1) % 16;
                } else if (index < 48) {
                    mix = b ^ c ^ d;
                    wordIndex = (3 * index + 5) % 16;
                } else {
                    mix = c ^ (b | ~d);
                    wordIndex = (7 * index) % 16;
                }
                const previousD = d;
                d = c;
                c = b;
                const sum = (a + mix + constants[index] + words[wordIndex]) | 0;
                b = (b + rotateLeft(sum, shifts[index])) | 0;
                a = previousD;
            }
            a0 = (a0 + a) | 0;
            b0 = (b0 + b) | 0;
            c0 = (c0 + c) | 0;
            d0 = (d0 + d) | 0;
        }

        return [a0, b0, c0, d0].map(word => [0, 8, 16, 24]
            .map(shift => ((word >>> shift) & 0xff).toString(16).padStart(2, '0'))
            .join('')).join('');
    }

    function get18ComicSliceCount(aid, pageId) {
        const numericAid = Number.parseInt(aid, 10);
        let key = md5Hex(`${aid}${pageId}`).slice(-1).charCodeAt(0);
        if (numericAid >= 268850 && numericAid <= 421925) {
            key %= 10;
        } else if (numericAid >= 421926) {
            key %= 8;
        }
        return key < 10 ? 2 + key * 2 : 10;
    }

    function resolve18ComicTransform(pageUrl, imageUrl, html = '') {
        try {
            const page = new URL(pageUrl);
            const image = new URL(imageUrl);
            if (!EIGHTEEN_COMIC_HOSTS.has(page.hostname.toLowerCase())) {
                return null;
            }
            const pageMatch = page.pathname.match(/\/photo\/(\d+)/i);
            const imageMatch = image.pathname.match(/\/media\/photos\/(\d+)\/([^/]+?)\.(jpe?g|png|webp|gif)$/i);
            if (!pageMatch || !imageMatch || pageMatch[1] !== imageMatch[1] || imageMatch[3].toLowerCase() === 'gif') {
                return null;
            }
            const thresholdMatch = String(html || '').match(/\bscramble_id\s*=\s*["']?(\d+)/i);
            const scrambleId = Number.parseInt(thresholdMatch?.[1] || '220980', 10);
            const aid = Number.parseInt(pageMatch[1], 10);
            if (!Number.isFinite(aid) || aid < scrambleId) {
                return null;
            }
            return Object.freeze({
                kind: '18comic-scramble',
                aid: String(aid),
                pageId: imageMatch[2],
                slices: get18ComicSliceCount(String(aid), imageMatch[2])
            });
        } catch (error) {
            return null;
        }
    }

    function parseSrcset(value) {
        return String(value || '')
            .split(',')
            .map((part, index) => {
                const tokens = part.trim().split(/\s+/);
                const url = tokens.shift() || '';
                const descriptor = tokens[0] || '';
                const number = Number.parseFloat(descriptor);
                return {
                    url,
                    score: Number.isFinite(number) ? number : index + 1
                };
            })
            .filter(candidate => candidate.url)
            .sort((left, right) => right.score - left.score)[0]?.url || '';
    }

    function selectImageSource(attributes) {
        const get = name => String(attributes?.[name] || '').trim();
        for (const name of LAZY_ATTRIBUTES) {
            if (get(name)) {
                return get(name);
            }
        }
        return parseSrcset(get('data-srcset'))
            || parseSrcset(get('srcset'))
            || get('src');
    }

    function normalizeHttpsUrl(value, baseUrl) {
        try {
            const url = new URL(String(value || '').trim(), baseUrl);
            if (url.protocol !== 'https:') {
                return '';
            }
            url.hash = '';
            return url.href;
        } catch (error) {
            return '';
        }
    }

    function resolveImageRecords(records, baseUrl, maximum = MAX_CANDIDATES) {
        const limit = Math.max(1, Math.min(MAX_CANDIDATES, Math.trunc(Number(maximum) || MAX_CANDIDATES)));
        const seen = new Map();
        const resolved = [];
        for (const record of records || []) {
            if (resolved.length >= limit) {
                break;
            }
            const rawUrl = selectImageSource(record);
            const url = normalizeHttpsUrl(rawUrl, baseUrl);
            if (!url) {
                continue;
            }
            const duplicateOf = seen.has(url) ? seen.get(url) : -1;
            if (duplicateOf < 0) {
                seen.set(url, resolved.length);
            }
            resolved.push(Object.freeze({
                url,
                duplicateOf,
                attributes: Object.freeze({ ...(record || {}) })
            }));
        }
        return resolved;
    }

    function extractImageCandidates(html, baseUrl, maximum = MAX_CANDIDATES) {
        if (typeof root.DOMParser !== 'function') {
            throw new Error('当前环境不支持 HTML 解析');
        }
        const document = new root.DOMParser().parseFromString(String(html || ''), 'text/html');
        const records = Array.from(document.querySelectorAll('img'), image => {
            const attributes = {};
            for (const name of [...LAZY_ATTRIBUTES, 'data-srcset', 'srcset', 'src']) {
                attributes[name] = image.getAttribute(name) || '';
            }
            return attributes;
        });
        return resolveImageRecords(records, baseUrl, maximum);
    }

    root.Ecryptees = root.Ecryptees || {};
    root.Ecryptees.webImport = Object.freeze({
        MAX_CANDIDATES,
        extractImageCandidates,
        get18ComicSliceCount,
        md5Hex,
        normalizeHttpsUrl,
        parseSrcset,
        resolve18ComicTransform,
        resolveImageRecords,
        selectImageSource
    });
})(typeof self !== 'undefined' ? self : globalThis);
