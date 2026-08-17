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
            if (seen.has(url)) continue;
            seen.set(url, resolved.length);
            resolved.push(Object.freeze({
                url,
                duplicateOf: -1,
                attributes: Object.freeze({ ...(record || {}) })
            }));
        }
        return resolved;
    }

    function uniqueImageCandidates(candidates) {
        const seen = new Set();
        return (candidates || []).filter(candidate => {
            if (!candidate || candidate.duplicateOf >= 0) return false;
            const key = String(candidate.url || '');
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    function extractImageCandidates(html, baseUrl, maximum = MAX_CANDIDATES) {
        if (typeof root.DOMParser !== 'function') {
            throw new Error('当前环境不支持 HTML 解析');
        }
        const document = new root.DOMParser().parseFromString(String(html || ''), 'text/html');
        const recordForImage = image => {
            const attributes = {};
            for (const name of [...LAZY_ATTRIBUTES, 'data-srcset', 'srcset', 'src']) {
                attributes[name] = image.getAttribute(name) || '';
            }
            return attributes;
        };
        const allImages = Array.from(document.querySelectorAll('img'));
        const tracks = Array.from(document.querySelectorAll('main, article, section, div, ul, ol'))
            .map(container => {
                const images = Array.from(container.querySelectorAll('img'));
                const label = `${container.tagName} ${container.id} ${container.className} ${container.getAttribute('role') || ''}`;
                const semantic = /(?:reader|viewer|comic|chapter|page|panel|slide|image|picture|photo|manga)/i.test(label);
                const excluded = /(?:recommend|related|comment|avatar|icon|cover|banner|advert|toolbar|menu|catalog|chapter-list)/i.test(label);
                let score = images.length * 10;
                if (semantic) score += 520;
                if (excluded) score -= 5000;
                return { images, score, semantic, excluded };
            })
            .filter(track => track.images.length >= 2 && track.semantic && !track.excluded)
            .sort((left, right) => right.score - left.score || right.images.length - left.images.length);
        const images = tracks[0]?.images || allImages;
        return resolveImageRecords(images.map(recordForImage), baseUrl, maximum);
    }

    function decodeEmbeddedText(value) {
        return String(value || '')
            .replace(/\\u002[fF]/g, '/')
            .replace(/\\u003[aA]/g, ':')
            .replace(/\\u0026/g, '&')
            .replace(/\\u003[dD]/g, '=')
            .replace(/\\"/g, '"')
            .replace(/\\'/g, "'")
            .replace(/\\\//g, '/');
    }

    function isImageAddress(value) {
        try {
            const url = new URL(value);
            return url.protocol === 'https:'
                && /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|webp)(?:$|[._~-])/i.test(url.pathname);
        } catch (error) {
            return false;
        }
    }

    function isLikelyThumbnailUrl(value) {
        try {
            const url = new URL(value);
            if (/(?:^|\/)(?:thumbs?|thumbnails?|previews?|small)(?:\/|$)/i.test(url.pathname)) {
                return true;
            }
            for (const name of ['w', 'width', 'size']) {
                const number = Number.parseInt(url.searchParams.get(name) || '', 10);
                if (Number.isFinite(number) && number > 0 && number <= 480) {
                    return true;
                }
            }
        } catch (error) {
            return false;
        }
        return false;
    }

    function findClosingBracket(value, start) {
        let depth = 0;
        let quote = '';
        let escaped = false;
        for (let index = start; index < value.length; index += 1) {
            const character = value[index];
            if (quote) {
                if (escaped) {
                    escaped = false;
                } else if (character === '\\') {
                    escaped = true;
                } else if (character === quote) {
                    quote = '';
                }
                continue;
            }
            if (character === '"' || character === "'" || character === '`') {
                quote = character;
            } else if (character === '[') {
                depth += 1;
            } else if (character === ']') {
                depth -= 1;
                if (depth === 0) {
                    return index;
                }
            }
        }
        return -1;
    }

    function splitTopLevelArray(value, maximum = MAX_CANDIDATES) {
        const items = [];
        let start = 0;
        let quote = '';
        let escaped = false;
        let curlyDepth = 0;
        let squareDepth = 0;
        let roundDepth = 0;
        for (let index = 0; index <= value.length; index += 1) {
            const character = value[index] || ',';
            if (quote) {
                if (escaped) {
                    escaped = false;
                } else if (character === '\\') {
                    escaped = true;
                } else if (character === quote) {
                    quote = '';
                }
                continue;
            }
            if (character === '"' || character === "'" || character === '`') {
                quote = character;
            } else if (character === '{') {
                curlyDepth += 1;
            } else if (character === '}') {
                curlyDepth = Math.max(0, curlyDepth - 1);
            } else if (character === '[') {
                squareDepth += 1;
            } else if (character === ']') {
                squareDepth = Math.max(0, squareDepth - 1);
            } else if (character === '(') {
                roundDepth += 1;
            } else if (character === ')') {
                roundDepth = Math.max(0, roundDepth - 1);
            } else if (character === ',' && curlyDepth === 0 && squareDepth === 0 && roundDepth === 0) {
                const item = value.slice(start, index).trim();
                if (item) {
                    items.push(item);
                    if (items.length >= maximum) {
                        break;
                    }
                }
                start = index + 1;
            }
        }
        return items;
    }

    function embeddedVariantScore(key, value) {
        const label = `${key} ${value}`.toLowerCase();
        let score = 0;
        if (/(?:original|origin|raw|full|source)/.test(label)) score += 160;
        if (/(?:large|big|high|hd|1280|1920|2048|2560)/.test(label)) score += 100;
        if (/(?:image|picture|photo|page|src|url)/.test(key.toLowerCase())) score += 30;
        if (/(?:thumb|small|preview|avatar|icon|cover|banner|recommend|related)/.test(label)) score -= 180;
        const dimensions = Array.from(label.matchAll(/(?:^|[^\d])(?:w|width)?[._~-]?(\d{3,4})(?:[^\d]|$)/g), match => Number(match[1]));
        if (dimensions.length) {
            score += Math.min(160, Math.max(...dimensions) / 8);
        }
        return score;
    }

    function extractImageRecordFromObject(value) {
        const decoded = decodeEmbeddedText(value);
        const matches = [];
        const expression = /(?:["']?([A-Za-z_$][\w$-]*)["']?)\s*:\s*["'](https:\/\/[^"'<>\s\\]+)["']/gi;
        let match;
        while ((match = expression.exec(decoded))) {
            const url = normalizeHttpsUrl(match[2].replace(/[),;]+$/, ''), match[2]);
            if (url && isImageAddress(url)) {
                matches.push({
                    key: match[1],
                    url,
                    score: embeddedVariantScore(match[1], url)
                });
            }
        }
        matches.sort((left, right) => right.score - left.score);
        return matches[0] || null;
    }

    function embeddedArrayNameScore(name) {
        let score = 0;
        if (/(?:comic|chapter|page|panel|slide|image|picture|photo)/i.test(name)) score += 220;
        if (/(?:images|pages|pictures|photos|slides|panels)$/i.test(name)) score += 80;
        if (/(?:recommend|related|comment|avatar|icon|cover|banner|advert|thumb|catalog|list)/i.test(name)) score -= 300;
        return score;
    }

    function extractStructuredImageTracks(html, baseUrl, maximum = MAX_CANDIDATES) {
        const decoded = decodeEmbeddedText(html);
        const tracks = [];
        const expression = /["']?([A-Za-z_$][\w$-]{1,48})["']?\s*:\s*\[/g;
        let match;
        let scanned = 0;
        while ((match = expression.exec(decoded)) && scanned < 300) {
            scanned += 1;
            const nameScore = embeddedArrayNameScore(match[1]);
            if (nameScore <= 0) {
                continue;
            }
            const openIndex = expression.lastIndex - 1;
            const closeIndex = findClosingBracket(decoded, openIndex);
            if (closeIndex < 0) {
                continue;
            }
            const items = splitTopLevelArray(decoded.slice(openIndex + 1, closeIndex), maximum);
            const records = [];
            for (const item of items) {
                const image = extractImageRecordFromObject(item);
                if (image) {
                    records.push({
                        src: image.url,
                        embedded: 'structured',
                        trackName: match[1],
                        variantKey: image.key
                    });
                }
            }
            if (records.length >= 2) {
                const coherence = Math.round(records.length / Math.max(1, items.length) * 120);
                const trackScore = nameScore + coherence;
                for (const record of records) {
                    record.trackScore = String(trackScore);
                }
                tracks.push(resolveImageRecords(records, baseUrl, maximum));
            }
        }
        return tracks;
    }

    function extractEmbeddedImageCandidates(html, baseUrl, maximum = MAX_CANDIDATES) {
        const structuredTracks = extractStructuredImageTracks(html, baseUrl, maximum);
        if (structuredTracks.length) {
            return selectBestCandidateSet(...structuredTracks);
        }

        const decoded = decodeEmbeddedText(html);
        const matches = decoded.match(/https:\/\/[^\s"'<>\\]+/gi) || [];
        const clusters = new Map();
        for (const match of matches) {
            const url = normalizeHttpsUrl(match.replace(/[),;]+$/, ''), baseUrl);
            if (url && isImageAddress(url)) {
                const parsed = new URL(url);
                const firstPath = parsed.pathname.split('/').filter(Boolean)[0] || '';
                const key = `${parsed.origin}/${firstPath}`;
                const records = clusters.get(key) || [];
                records.push({
                    src: url,
                    embedded: 'fallback',
                    trackScore: '-80'
                });
                clusters.set(key, records);
            }
        }
        const tracks = Array.from(clusters.values())
            .filter(records => records.length >= 3)
            .map(records => resolveImageRecords(records, baseUrl, maximum));
        return tracks.length ? selectBestCandidateSet(...tracks) : [];
    }

    function uniqueCandidateCount(candidates) {
        return (candidates || []).filter(candidate => candidate.duplicateOf < 0).length;
    }

    function candidateSetScore(candidates) {
        const unique = (candidates || []).filter(candidate => candidate.duplicateOf < 0);
        const thumbnails = unique.filter(candidate => isLikelyThumbnailUrl(candidate.url)).length;
        const trackScore = Number(unique[0]?.attributes?.trackScore) || 0;
        const semanticBonus = unique[0]?.attributes?.embedded === 'structured' && trackScore >= 200 ? 10000 : 0;
        return unique.length * 10 - thumbnails * 8 + trackScore + semanticBonus;
    }

    function selectBestCandidateSet(...sets) {
        return sets.reduce((best, candidates) =>
            candidateSetScore(candidates) > candidateSetScore(best) ? candidates : best, []);
    }

    function hasReaderPageHint(html) {
        const value = String(html || '');
        return /(?:id|class|aria-label|title)=["'][^"']*(?:reader|viewer|read-online|chapter-images|comic-images|comic-contain|image-container|page-select|slide|manga-pages|images)[^"']*["']/i.test(value)
            || />\s*(?:read online|开始阅读|在线阅读|下一页|下页)\s*</i.test(value);
    }

    function shouldCaptureRenderedPage(candidates, html) {
        const unique = uniqueCandidateCount(candidates);
        const thumbnails = (candidates || []).filter(candidate =>
            candidate.duplicateOf < 0 && isLikelyThumbnailUrl(candidate.url)).length;
        const mostlyThumbnails = unique > 0 && thumbnails / unique >= 0.6;
        const trackType = candidates?.[0]?.attributes?.embedded || '';
        const highConfidenceStructured = trackType === 'structured'
            && Number(candidates?.[0]?.attributes?.trackScore || 0) >= 200;
        return !highConfidenceStructured
            && (unique === 0 || ((unique <= 5 || mostlyThumbnails || trackType === 'fallback') && hasReaderPageHint(html)));
    }

    root.Ecryptees = root.Ecryptees || {};
    root.Ecryptees.webImport = Object.freeze({
        MAX_CANDIDATES,
        extractEmbeddedImageCandidates,
        extractStructuredImageTracks,
        extractImageCandidates,
        get18ComicSliceCount,
        md5Hex,
        normalizeHttpsUrl,
        parseSrcset,
        selectBestCandidateSet,
        shouldCaptureRenderedPage,
        resolve18ComicTransform,
        resolveImageRecords,
        selectImageSource,
        uniqueImageCandidates
    });
})(typeof self !== 'undefined' ? self : globalThis);
