(function (root) {
    'use strict';

    const namespace = root.Ecryptees = root.Ecryptees || {};

    const codebook = ['齁', '哦', '噢', '喔', '咕', '咿', '嗯', '啊', '～', '哈', '！', '唔', '哼', '❤', '呃', '呼'];
    const imageCodebook = Array.from(
        // 平假名（清音 46）
        'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん' +
        // 平假名（浊音 20）
        'がぎぐげござじずぜぞだぢづでどばびぶべぼ' +
        // 平假名（半浊音 5）
        'ぱぴぷぺぽ' +
        // 片假名（清音 46）
        'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン' +
        // 片假名（浊音 20）
        'ガギグゲゴザジズゼゾダヂヅデドバビブベボ' +
        // 片假名（半浊音 5）
        'パピプペポ' +
        // 小写平假名（10）
        'ぁぃぅぇぉっゃゅょゎ' +
        // 小写片假名（10）
        'ァィゥェォッャュョヮ' +
        // 中文萌系语气词（去重，50 个）
        '啊呀哦噢喔诶唉哎呦哇呵嘿嘻嗷喵呐吖咯咧吧呗呸扑咚啪噗咔咕哩噜咻嘶唰哒咛嘤哼嗯哈哟嘛呢啦耶喽嘎呱叽喳吱嘟' +
        // 二次元常用汉字（44 个）
        '萌幻樱雪月星梦恋爱心音光空风雨云虹霞露霜花草木林森山川海洋岛港町村都市国家族人友伴侣亲'
    );
    const codebookMap = {};
    const codebookCodeMap = new Uint8Array(65536);
    const codebookCodeUnits = new Uint16Array(16);
    const encodedByteMap = new Array(256);
    const imageCodebookCodeMap = new Uint16Array(65536);
    const imageCodebookCodeUnits = new Uint16Array(256);
    const IMAGE_MAGIC = new Uint8Array([0x4D, 0x53, 0x42, 0x54, 0x49, 0x4D, 0x47, 0x00]);
    const LEGACY_IMAGE_VERSION = 1;
    const COMPACT_IMAGE_VERSION = 2;
    const IMAGE_VERSION = 3;
    const IMAGE_HEADER_SIZE = 21;
    const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
    const MAX_IMAGE_PIXELS = 40 * 1000 * 1000;
    const MAX_METADATA_BYTES = 8 * 1024;
    const MAX_COMPACT_IMAGE_CODE_LENGTH = IMAGE_HEADER_SIZE + MAX_METADATA_BYTES + MAX_IMAGE_BYTES;
    const MAX_IMAGE_CODE_LENGTH = MAX_COMPACT_IMAGE_CODE_LENGTH * 2;
    const MAX_CIPHER_TEXT_FILE_BYTES = MAX_IMAGE_CODE_LENGTH * 3 + 3;
    const IMAGE_WORK_CHUNK_BYTES = 128 * 1024;
    const utf16Decoder = new TextDecoder('utf-16le');
    const COMPRESSION_PRESETS = {
        clear: {
            label: '清晰',
            maxEdge: 1920,
            initialQuality: 0.82,
            minimumQuality: 0.66,
            targetBytes: 512 * 1024,
            targetRatio: 0.5,
            description: '最长边 1920px，JPG 初始质量 82%，优先保留细节。'
        },
        balanced: {
            label: '平衡',
            maxEdge: 1440,
            initialQuality: 0.72,
            minimumQuality: 0.5,
            targetBytes: 300 * 1024,
            targetRatio: 0.35,
            description: '最长边 1440px，JPG 初始质量 72%，自动多轮缩减。'
        },
        extreme: {
            label: '极限',
            maxEdge: 960,
            initialQuality: 0.55,
            minimumQuality: 0.34,
            targetBytes: 150 * 1024,
            targetRatio: 0.2,
            description: '最长边 960px，JPG 初始质量 55%，优先缩短密文。'
        }
    };
    const IMAGE_FORMATS = {
        'image/png': { label: 'PNG', extension: 'png' },
        'image/jpeg': { label: 'JPEG', extension: 'jpg' },
        'image/gif': { label: 'GIF', extension: 'gif' },
        'image/webp': { label: 'WebP', extension: 'webp' },
        'image/bmp': { label: 'BMP', extension: 'bmp' },
        'image/avif': { label: 'AVIF', extension: 'avif' }
    };

    codebookCodeMap.fill(0xFF);
    for (let i = 0; i < codebook.length; i++) {
        codebookMap[codebook[i]] = i;
        codebookCodeMap[codebook[i].charCodeAt(0)] = i;
        codebookCodeUnits[i] = codebook[i].charCodeAt(0);
    }

    for (let byte = 0; byte < 256; byte++) {
        encodedByteMap[byte] = codebook[(byte >> 4) & 0x0F] + codebook[byte & 0x0F];
    }

    if (imageCodebook.length !== 256 || new Set(imageCodebook).size !== 256) {
        throw new Error('图片密文字符表必须包含 256 个不同字符');
    }

    imageCodebookCodeMap.fill(0xFFFF);
    for (let byte = 0; byte < imageCodebook.length; byte++) {
        const codeUnit = imageCodebook[byte].charCodeAt(0);
        imageCodebookCodeMap[codeUnit] = byte;
        imageCodebookCodeUnits[byte] = codeUnit;
    }

    const legacyImageCodePrefix = Array.from(IMAGE_MAGIC, byte => encodedByteMap[byte]).join('');
    const imageCodePrefix = Array.from(IMAGE_MAGIC, byte => imageCodebook[byte]).join('');

    class CipherError extends Error {
        constructor(code, message) {
            super(message);
            this.name = 'CipherError';
            this.code = code;
        }
    }

    function encodeBytes(bytes) {
        let encoded = '';

        for (let byte of bytes) {
            encoded += encodedByteMap[byte];
        }

        return encoded;
    }

    function decodeCode(input) {
        if (input.length % 2 !== 0) {
            throw new CipherError('ODD_LENGTH', '输入长度必须为偶数');
        }

        const bytes = new Uint8Array(input.length / 2);

        for (let i = 0; i < input.length; i += 2) {
            const high = codebookCodeMap[input.charCodeAt(i)];
            const low = codebookCodeMap[input.charCodeAt(i + 1)];

            if (high === 0xFF || low === 0xFF) {
                throw new CipherError('ILLEGAL_CHARACTER', '输入包含非法字符');
            }

            bytes[i / 2] = (high << 4) | low;
        }

        return bytes;
    }

    function waitForNextFrame() {
        return new Promise(resolve => {
            let settled = false;
            const finish = () => {
                if (settled) {
                    return;
                }

                settled = true;
                root.clearTimeout(fallbackTimer);
                resolve();
            };
            const fallbackTimer = root.setTimeout(finish, 50);

            if (typeof root.requestAnimationFrame === 'function') {
                root.requestAnimationFrame(() => root.setTimeout(finish, 0));
            }
        });
    }

    async function encodeImageByteSegmentsChunked(segments, onProgress) {
        const totalBytes = segments.reduce((total, bytes) => total + bytes.length, 0);
        const chunks = [];
        let processedBytes = 0;
        let lastProgress = -1;

        if (totalBytes === 0) {
            onProgress(100);
            return '';
        }

        for (const bytes of segments) {
            for (let offset = 0; offset < bytes.length; offset += IMAGE_WORK_CHUNK_BYTES) {
                const end = Math.min(offset + IMAGE_WORK_CHUNK_BYTES, bytes.length);
                const utf16Bytes = new Uint8Array((end - offset) * 2);
                let outputIndex = 0;

                for (let i = offset; i < end; i++) {
                    const codeUnit = imageCodebookCodeUnits[bytes[i]];
                    utf16Bytes[outputIndex++] = codeUnit & 0xFF;
                    utf16Bytes[outputIndex++] = codeUnit >>> 8;
                }

                chunks.push(utf16Decoder.decode(utf16Bytes));
                processedBytes += end - offset;
                const progress = Math.max(1, Math.round((processedBytes / totalBytes) * 100));

                if (progress !== lastProgress) {
                    lastProgress = progress;
                    onProgress(progress);
                }

                await waitForNextFrame();
            }
        }

        return chunks.join('');
    }

    async function decodeLegacyImageCodeChunked(input, onProgress) {
        if (input.length % 2 !== 0) {
            throw new CipherError('ODD_LENGTH', '图片密文长度必须为偶数');
        }

        const bytes = new Uint8Array(input.length / 2);
        const chunkSize = IMAGE_WORK_CHUNK_BYTES * 2;
        let lastProgress = -1;

        if (input.length === 0) {
            onProgress(100);
            return bytes;
        }

        for (let offset = 0; offset < input.length; offset += chunkSize) {
            const end = Math.min(offset + chunkSize, input.length);

            let outputIndex = offset / 2;

            for (let i = offset; i < end; i += 2) {
                const high = codebookCodeMap[input.charCodeAt(i)];
                const low = codebookCodeMap[input.charCodeAt(i + 1)];

                if (high === 0xFF || low === 0xFF) {
                    throw new CipherError('ILLEGAL_CHARACTER', '图片密文包含非法字符');
                }

                bytes[outputIndex++] = (high << 4) | low;
            }

            const progress = Math.max(1, Math.round((end / input.length) * 100));
            if (progress !== lastProgress) {
                lastProgress = progress;
                onProgress(progress);
            }
            await waitForNextFrame();
        }

        return bytes;
    }

    async function decodeCompactImageCodeChunked(input, onProgress) {
        const bytes = new Uint8Array(input.length);
        let lastProgress = -1;

        for (let offset = 0; offset < input.length; offset += IMAGE_WORK_CHUNK_BYTES) {
            const end = Math.min(offset + IMAGE_WORK_CHUNK_BYTES, input.length);

            for (let i = offset; i < end; i++) {
                const byte = imageCodebookCodeMap[input.charCodeAt(i)];

                if (byte === 0xFFFF) {
                    throw new CipherError('ILLEGAL_CHARACTER', '图片密文包含非法字符');
                }

                bytes[i] = byte;
            }

            const progress = Math.max(1, Math.round((end / input.length) * 100));
            if (progress !== lastProgress) {
                lastProgress = progress;
                onProgress(progress);
            }
            await waitForNextFrame();
        }

        return bytes;
    }

    async function decodeImageCodeChunked(input, onProgress) {
        if (input.startsWith(imageCodePrefix)) {
            return {
                payload: await decodeCompactImageCodeChunked(input, onProgress),
                cipherFamily: 'compact'
            };
        }

        if (input.startsWith(legacyImageCodePrefix)) {
            return {
                payload: await decodeLegacyImageCodeChunked(input, onProgress),
                cipherFamily: 'legacy'
            };
        }

        throw new Error('这不是有效的图片密文');
    }

    const crc32Table = (() => {
        const table = new Uint32Array(256);

        for (let i = 0; i < 256; i++) {
            let value = i;

            for (let bit = 0; bit < 8; bit++) {
                value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
            }

            table[i] = value >>> 0;
        }

        return table;
    })();

    function calculateCrc32(bytes) {
        let crc = 0xFFFFFFFF;

        for (let i = 0; i < bytes.length; i++) {
            crc = crc32Table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
        }

        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    async function calculateCrc32Chunked(bytes, onProgress) {
        let crc = 0xFFFFFFFF;
        let lastProgress = -1;

        if (bytes.length === 0) {
            onProgress(100);
            return 0;
        }

        for (let offset = 0; offset < bytes.length; offset += IMAGE_WORK_CHUNK_BYTES) {
            const end = Math.min(offset + IMAGE_WORK_CHUNK_BYTES, bytes.length);

            for (let i = offset; i < end; i++) {
                crc = crc32Table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
            }

            const progress = Math.max(1, Math.round((end / bytes.length) * 100));
            if (progress !== lastProgress) {
                lastProgress = progress;
                onProgress(progress);
            }
            await waitForNextFrame();
        }

        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    function matchesBytes(bytes, offset, expected) {
        if (bytes.length < offset + expected.length) {
            return false;
        }

        for (let i = 0; i < expected.length; i++) {
            if (bytes[offset + i] !== expected[i]) {
                return false;
            }
        }

        return true;
    }

    function readAscii(bytes, offset, length) {
        let value = '';

        for (let i = 0; i < length && offset + i < bytes.length; i++) {
            value += String.fromCharCode(bytes[offset + i]);
        }

        return value;
    }

    function sniffImageType(bytes) {
        if (matchesBytes(bytes, 0, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) {
            return { mime: 'image/png', ...IMAGE_FORMATS['image/png'] };
        }

        if (matchesBytes(bytes, 0, [0xFF, 0xD8, 0xFF])) {
            return { mime: 'image/jpeg', ...IMAGE_FORMATS['image/jpeg'] };
        }

        const gifHeader = readAscii(bytes, 0, 6);
        if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
            return { mime: 'image/gif', ...IMAGE_FORMATS['image/gif'] };
        }

        if (readAscii(bytes, 0, 4) === 'RIFF' && readAscii(bytes, 8, 4) === 'WEBP') {
            return { mime: 'image/webp', ...IMAGE_FORMATS['image/webp'] };
        }

        if (readAscii(bytes, 0, 2) === 'BM') {
            return { mime: 'image/bmp', ...IMAGE_FORMATS['image/bmp'] };
        }

        if (readAscii(bytes, 4, 4) === 'ftyp') {
            const brandArea = readAscii(bytes, 8, Math.min(32, Math.max(0, bytes.length - 8)));
            if (brandArea.includes('avif') || brandArea.includes('avis')) {
                return { mime: 'image/avif', ...IMAGE_FORMATS['image/avif'] };
            }
        }

        return null;
    }

    function skipGifSubBlocks(bytes, offset) {
        let cursor = offset;

        while (cursor < bytes.length) {
            const blockSize = bytes[cursor++];
            if (blockSize === 0) {
                return cursor;
            }
            cursor += blockSize;
        }

        return bytes.length;
    }

    function isAnimatedGif(bytes) {
        if (bytes.length < 13) {
            return false;
        }

        let cursor = 13;
        const globalColorTableFlag = (bytes[10] & 0x80) !== 0;
        if (globalColorTableFlag) {
            cursor += 3 * (1 << ((bytes[10] & 0x07) + 1));
        }

        let frameCount = 0;
        while (cursor < bytes.length) {
            const marker = bytes[cursor++];

            if (marker === 0x3B) {
                break;
            }

            if (marker === 0x21) {
                cursor += 1;
                cursor = skipGifSubBlocks(bytes, cursor);
                continue;
            }

            if (marker !== 0x2C || cursor + 9 > bytes.length) {
                break;
            }

            frameCount++;
            if (frameCount > 1) {
                return true;
            }

            const packed = bytes[cursor + 8];
            cursor += 9;
            if ((packed & 0x80) !== 0) {
                cursor += 3 * (1 << ((packed & 0x07) + 1));
            }

            cursor += 1;
            cursor = skipGifSubBlocks(bytes, cursor);
        }

        return false;
    }

    function isAnimatedWebp(bytes) {
        let cursor = 12;

        while (cursor + 8 <= bytes.length) {
            const chunkName = readAscii(bytes, cursor, 4);
            const chunkLength = bytes[cursor + 4]
                | (bytes[cursor + 5] << 8)
                | (bytes[cursor + 6] << 16)
                | (bytes[cursor + 7] << 24);

            if (chunkName === 'ANIM' || chunkName === 'ANMF') {
                return true;
            }

            cursor += 8 + (chunkLength >>> 0) + ((chunkLength >>> 0) & 1);
        }

        return false;
    }

    function isAnimatedImage(bytes, format) {
        if (format.mime === 'image/gif') {
            return isAnimatedGif(bytes);
        }

        if (format.mime === 'image/webp') {
            return isAnimatedWebp(bytes);
        }

        if (format.mime === 'image/avif') {
            return readAscii(bytes, 8, Math.min(32, Math.max(0, bytes.length - 8))).includes('avis');
        }

        return false;
    }


    function makeCompressedName(name) {
        const baseName = String(name || 'image').replace(/\.[^.]*$/, '') || 'image';
        return `${baseName}-compressed.jpg`;
    }

    function canvasToJpeg(canvas, quality) {
        return new Promise((resolve, reject) => {
            canvas.toBlob(blob => {
                if (!blob || blob.type !== 'image/jpeg') {
                    reject(new Error('当前浏览器不支持 JPG 图片压缩'));
                    return;
                }

                resolve(blob);
            }, 'image/jpeg', quality);
        });
    }

    async function createBitmapFromFile(file) {
        try {
            return await createImageBitmap(file, { imageOrientation: 'from-image' });
        } catch (error) {
            return createImageBitmap(file);
        }
    }

    async function createJpegDownloadBlob(imageBytes, mime) {
        const sourceBlob = new Blob([imageBytes], { type: mime });
        if (mime === 'image/jpeg') {
            return sourceBlob;
        }

        const bitmap = await createBitmapFromFile(sourceBlob);
        if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > MAX_IMAGE_PIXELS) {
            bitmap.close?.();
            throw new Error('解码后的图片像素不能超过 4000 万');
        }

        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d', { alpha: false });

        if (!context) {
            bitmap.close?.();
            throw new Error('当前浏览器无法创建 JPG 转换画布');
        }

        try {
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(bitmap, 0, 0);
            await waitForNextFrame();
            return await canvasToJpeg(canvas, 0.9);
        } finally {
            context.clearRect(0, 0, canvas.width, canvas.height);
            canvas.width = 1;
            canvas.height = 1;
            bitmap.close?.();
        }
    }

    function makeJpegDownloadName(name) {
        const baseName = String(name || 'decoded-image').replace(/\.[^.]*$/, '') || 'decoded-image';
        return sanitizeDownloadName(`${baseName}.jpg`, 'jpg');
    }

    function buildProcessedImage(image, bytes, options) {
        const format = options.format;
        const outputName = options.outputName;
        const metadata = {
            name: outputName,
            type: format.mime,
            size: bytes.length,
            source: {
                name: image.file.name,
                type: image.format.mime,
                size: image.bytes.length,
                width: options.sourceWidth || null,
                height: options.sourceHeight || null,
                animated: image.animated
            },
            compression: {
                mode: options.mode,
                codec: options.codec,
                quality: options.quality === null ? null : Math.round(options.quality * 100),
                width: options.width || null,
                height: options.height || null,
                animation: options.animation
            }
        };

        return {
            bytes,
            format,
            outputName,
            metadata,
            quality: options.quality,
            width: options.width,
            height: options.height,
            sourceWidth: options.sourceWidth,
            sourceHeight: options.sourceHeight,
            usedOriginal: options.codec === 'original',
            animation: options.animation
        };
    }

    async function optimizeImage(image, mode, onProgress) {
        const preset = COMPRESSION_PRESETS[mode];

        onProgress({ percent: 5, message: '正在解码图片像素' });
        const bitmap = await createBitmapFromFile(image.file);
        const sourceWidth = bitmap.width;
        const sourceHeight = bitmap.height;

        if (!sourceWidth || !sourceHeight || sourceWidth * sourceHeight > MAX_IMAGE_PIXELS) {
            bitmap.close?.();
            throw new Error('图片像素不能超过 4000 万');
        }

        const initialScale = Math.min(1, preset.maxEdge / Math.max(sourceWidth, sourceHeight));
        let width = Math.max(1, Math.round(sourceWidth * initialScale));
        let height = Math.max(1, Math.round(sourceHeight * initialScale));
        let quality = preset.initialQuality;
        const targetBytes = Math.min(
            preset.targetBytes,
            Math.max(32 * 1024, Math.round(image.bytes.length * preset.targetRatio))
        );
        const totalPasses = 5;
        let best = null;
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d', { alpha: true });

        if (!context) {
            bitmap.close?.();
            throw new Error('当前浏览器无法创建图片压缩画布');
        }

        try {
            for (let pass = 1; pass <= totalPasses; pass++) {
                canvas.width = width;
                canvas.height = height;
                context.fillStyle = '#ffffff';
                context.fillRect(0, 0, width, height);
                context.drawImage(bitmap, 0, 0, width, height);
                await waitForNextFrame();

                const blob = await canvasToJpeg(canvas, quality);
                const candidateBytes = new Uint8Array(await blob.arrayBuffer());

                if (!best || candidateBytes.length < best.bytes.length) {
                    best = buildProcessedImage(image, candidateBytes, {
                        format: { mime: 'image/jpeg', ...IMAGE_FORMATS['image/jpeg'] },
                        outputName: makeCompressedName(image.file.name),
                        mode,
                        codec: 'jpeg',
                        quality,
                        width,
                        height,
                        sourceWidth,
                        sourceHeight,
                        animation: image.animated ? 'first-frame' : 'none'
                    });
                }

                const percent = Math.round((pass / totalPasses) * 95);
                onProgress({
                    percent,
                    message: `第 ${pass}/${totalPasses} 轮：${width}×${height}，质量 ${Math.round(quality * 100)}%，${formatBytes(candidateBytes.length)}`
                });

                if (candidateBytes.length <= targetBytes) {
                    break;
                }

                if (quality - 0.08 >= preset.minimumQuality) {
                    quality = Math.max(preset.minimumQuality, quality - 0.08);
                } else {
                    width = Math.max(1, Math.round(width * 0.84));
                    height = Math.max(1, Math.round(height * 0.84));
                    quality = Math.min(preset.initialQuality, preset.minimumQuality + 0.08);
                }
            }
        } finally {
            context.clearRect(0, 0, canvas.width, canvas.height);
            canvas.width = 1;
            canvas.height = 1;
            bitmap.close?.();
        }

        onProgress({ percent: 100, message: 'JPG 图片压缩完成' });
        return best;
    }

    function buildImagePrefix(image, imageCrc32) {
        const metadataBytes = new TextEncoder().encode(JSON.stringify(image.metadata || {
            name: image.file.name,
            type: image.format.mime,
            size: image.bytes.length
        }));

        if (metadataBytes.length > MAX_METADATA_BYTES) {
            throw new Error('图片文件名过长，无法写入密文');
        }

        const prefix = new Uint8Array(IMAGE_HEADER_SIZE + metadataBytes.length);
        const view = new DataView(prefix.buffer);
        prefix.set(IMAGE_MAGIC, 0);
        prefix[8] = IMAGE_VERSION;
        view.setUint32(9, metadataBytes.length, false);
        view.setUint32(13, image.bytes.length, false);
        view.setUint32(17, imageCrc32, false);
        prefix.set(metadataBytes, IMAGE_HEADER_SIZE);
        return prefix;
    }

    function buildImagePayload(image) {
        const prefix = buildImagePrefix(image, calculateCrc32(image.bytes));
        const payload = new Uint8Array(prefix.length + image.bytes.length);
        payload.set(prefix, 0);
        payload.set(image.bytes, prefix.length);
        return payload;
    }

    function parseImagePayload(payload) {
        if (payload.length < IMAGE_HEADER_SIZE || !matchesBytes(payload, 0, IMAGE_MAGIC)) {
            throw new Error('这不是有效的图片密文');
        }

        if (payload[8] !== LEGACY_IMAGE_VERSION
            && payload[8] !== COMPACT_IMAGE_VERSION
            && payload[8] !== IMAGE_VERSION) {
            throw new Error(`不支持的图片密文版本：${payload[8]}`);
        }

        const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        const metadataLength = view.getUint32(9, false);
        const imageLength = view.getUint32(13, false);
        const expectedCrc32 = view.getUint32(17, false);

        if (metadataLength === 0 || metadataLength > MAX_METADATA_BYTES) {
            throw new Error('图片密文的文件信息无效');
        }

        if (imageLength === 0 || imageLength > MAX_IMAGE_BYTES) {
            throw new Error('图片密文中的图片大小无效或超过 15 MiB');
        }

        const expectedLength = IMAGE_HEADER_SIZE + metadataLength + imageLength;
        if (payload.length !== expectedLength) {
            throw new Error('图片密文长度不完整');
        }

        const metadataBytes = payload.subarray(IMAGE_HEADER_SIZE, IMAGE_HEADER_SIZE + metadataLength);
        const imageBytes = payload.slice(IMAGE_HEADER_SIZE + metadataLength);
        let metadata;

        try {
            metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadataBytes));
        } catch (error) {
            throw new Error('图片密文的文件信息已损坏');
        }

        if (!metadata || typeof metadata.name !== 'string' || typeof metadata.type !== 'string' || metadata.size !== imageLength) {
            throw new Error('图片密文的文件信息无效');
        }

        const format = sniffImageType(imageBytes);
        if (!format || !IMAGE_FORMATS[format.mime]) {
            throw new Error('图片密文中不是受支持的图片格式');
        }

        if (metadata.type !== format.mime) {
            throw new Error('图片密文的格式信息与图片内容不一致');
        }

        if (calculateCrc32(imageBytes) !== expectedCrc32) {
            throw new Error('图片密文校验失败，内容可能已损坏');
        }

        return { metadata, imageBytes, format };
    }

    function formatBytes(byteCount) {
        if (byteCount < 1024) {
            return `${byteCount} B`;
        }

        if (byteCount < 1024 * 1024) {
            return `${(byteCount / 1024).toFixed(1)} KiB`;
        }

        return `${(byteCount / (1024 * 1024)).toFixed(2)} MiB`;
    }

    function sanitizeDownloadName(name, extension) {
        const sanitized = Array.from(String(name || '')
            .replace(/[\\/:*?"<>|\u0000-\u001F\u007F]/g, '_')
            .trim())
            .slice(0, 180)
            .join('');

        return sanitized || `decoded-image.${extension}`;
    }
    const codec = Object.freeze({
        CipherError,
        encodeBytes,
        decodeCode,
        waitForNextFrame,
        encodeImageByteSegmentsChunked,
        decodeImageCodeChunked,
        calculateCrc32,
        calculateCrc32Chunked,
        buildImagePrefix,
        buildImagePayload,
        parseImagePayload
    });
    const image = Object.freeze({
        sniffImageType,
        isAnimatedImage,
        createJpegDownloadBlob,
        optimizeImage
    });
    const utils = Object.freeze({
        makeCompressedName,
        makeJpegDownloadName,
        formatBytes,
        sanitizeDownloadName
    });
    const config = Object.freeze({
        codebook,
        imageCodebook,
        IMAGE_MAGIC,
        LEGACY_IMAGE_VERSION,
        COMPACT_IMAGE_VERSION,
        IMAGE_VERSION,
        IMAGE_HEADER_SIZE,
        MAX_IMAGE_BYTES,
        MAX_IMAGE_PIXELS,
        MAX_METADATA_BYTES,
        MAX_COMPACT_IMAGE_CODE_LENGTH,
        MAX_IMAGE_CODE_LENGTH,
        MAX_CIPHER_TEXT_FILE_BYTES,
        IMAGE_WORK_CHUNK_BYTES,
        COMPRESSION_PRESETS,
        IMAGE_FORMATS,
        legacyImageCodePrefix,
        imageCodePrefix
    });

    namespace.core = Object.freeze({ codec, image, utils, config });
})(globalThis);
