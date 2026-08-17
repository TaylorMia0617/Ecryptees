(function (root) {
    'use strict';

    function normalizeMemberships(value) {
        if (value instanceof Map) {
            return value;
        }
        return new Map(Object.entries(value || {}));
    }

    const titleCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
    const chineseDigits = Object.freeze({ 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 });
    const englishNumbers = Object.freeze({
        zero: 0, one: 1, first: 1, two: 2, second: 2, three: 3, third: 3,
        four: 4, fourth: 4, five: 5, fifth: 5, six: 6, sixth: 6,
        seven: 7, seventh: 7, eight: 8, eighth: 8, nine: 9, ninth: 9,
        ten: 10, tenth: 10, eleven: 11, eleventh: 11, twelve: 12, twelfth: 12,
        thirteen: 13, thirteenth: 13, fourteen: 14, fourteenth: 14,
        fifteen: 15, fifteenth: 15, sixteen: 16, sixteenth: 16,
        seventeen: 17, seventeenth: 17, eighteen: 18, eighteenth: 18,
        nineteen: 19, nineteenth: 19, twenty: 20, twentieth: 20,
        thirty: 30, thirtieth: 30, forty: 40, fortieth: 40, fifty: 50, fiftieth: 50,
        sixty: 60, sixtieth: 60, seventy: 70, seventieth: 70,
        eighty: 80, eightieth: 80, ninety: 90, ninetieth: 90
    });
    const englishNumberWord = Object.keys(englishNumbers).concat(['hundred', 'hundredth', 'thousand', 'thousandth'])
        .sort((left, right) => right.length - left.length).join('|');
    const naturalTokenPattern = new RegExp(
        `\\b(?:${englishNumberWord})(?:[\\s-]+(?:and[\\s-]+)?(?:${englishNumberWord}))*\\b|\\d+|[零〇一二两三四五六七八九十百千万]+|[\\p{L}]+|[^\\p{L}\\d]+`,
        'giu'
    );

    function parseChineseNumber(text) {
        const chars = Array.from(String(text || ''));
        if (!chars.some(char => ['十', '百', '千', '万'].includes(char))) {
            return Number(chars.map(char => chineseDigits[char]).join(''));
        }
        const units = { 十: 10, 百: 100, 千: 1000 };
        let total = 0;
        let section = 0;
        let number = 0;
        for (const char of chars) {
            if (Object.prototype.hasOwnProperty.call(chineseDigits, char)) {
                number = chineseDigits[char];
            } else if (char === '万') {
                section += number;
                total += Math.max(1, section) * 10000;
                section = 0;
                number = 0;
            } else {
                section += Math.max(1, number) * units[char];
                number = 0;
            }
        }
        return total + section + number;
    }

    function parseEnglishNumber(text) {
        const words = String(text || '').toLocaleLowerCase().split(/[\s-]+/).filter(word => word !== 'and');
        let total = 0;
        let current = 0;
        for (const word of words) {
            if (word === 'hundred' || word === 'hundredth') current = Math.max(1, current) * 100;
            else if (word === 'thousand' || word === 'thousandth') {
                total += Math.max(1, current) * 1000;
                current = 0;
            } else current += englishNumbers[word] || 0;
        }
        return total + current;
    }

    function naturalTitleTokens(value) {
        return Array.from(String(value || '').matchAll(naturalTokenPattern), match => {
            const text = match[0];
            if (/^\d+$/.test(text)) return { kind: 'number', value: Number(text) };
            if (/^[零〇一二两三四五六七八九十百千万]+$/.test(text)) {
                return { kind: 'number', value: parseChineseNumber(text) };
            }
            if (new RegExp(`^(?:${englishNumberWord})`, 'i').test(text)) {
                return { kind: 'number', value: parseEnglishNumber(text) };
            }
            return { kind: 'text', value: text.toLocaleLowerCase() };
        });
    }

    function compareNaturalTitles(left, right) {
        const leftTitle = String(left?.title ?? left ?? '');
        const rightTitle = String(right?.title ?? right ?? '');
        const leftTokens = naturalTitleTokens(leftTitle);
        const rightTokens = naturalTitleTokens(rightTitle);
        for (let index = 0; index < Math.max(leftTokens.length, rightTokens.length); index++) {
            if (!leftTokens[index]) return -1;
            if (!rightTokens[index]) return 1;
            const leftToken = leftTokens[index];
            const rightToken = rightTokens[index];
            if (leftToken.kind === 'number' && rightToken.kind === 'number' && leftToken.value !== rightToken.value) {
                return leftToken.value - rightToken.value;
            }
            const compared = titleCollator.compare(String(leftToken.value), String(rightToken.value));
            if (compared) return compared;
        }
        const titleCompared = titleCollator.compare(leftTitle, rightTitle);
        if (titleCompared) return titleCompared;
        return titleCollator.compare(String(left?.bookId || ''), String(right?.bookId || ''));
    }

    function applyManualOrder(books, orderedIds) {
        const positions = new Map((Array.isArray(orderedIds) ? orderedIds : [])
            .map((bookId, index) => [String(bookId || ''), index]));
        return (Array.isArray(books) ? books : []).slice().sort((left, right) => {
            const leftPosition = positions.get(String(left.bookId || ''));
            const rightPosition = positions.get(String(right.bookId || ''));
            if (leftPosition !== undefined && rightPosition !== undefined) return leftPosition - rightPosition;
            if (leftPosition !== undefined) return -1;
            if (rightPosition !== undefined) return 1;
            return compareNaturalTitles(left, right);
        });
    }

    function getBookSequence(books, memberships, groupId = 'all', sort = 'recent') {
        const membershipMap = normalizeMemberships(memberships);
        const selectedGroup = String(groupId || 'all');
        const sequence = (Array.isArray(books) ? books : [])
            .filter(book => {
                const membership = membershipMap.get(String(book.bookId || '')) || '';
                if (selectedGroup === 'ungrouped') {
                    return !membership;
                }
                return selectedGroup === 'all' || membership === selectedGroup;
            })
            .slice();
        sequence.sort((left, right) => {
            if (sort === 'title') {
                return String(left.title || '').localeCompare(String(right.title || ''), 'zh-CN');
            }
            if (sort === 'natural') return compareNaturalTitles(left, right);
            if (sort === 'converted') {
                return (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0);
            }
            return (Number(right.lastOpenedAt) || Number(right.updatedAt) || 0)
                - (Number(left.lastOpenedAt) || Number(left.updatedAt) || 0);
        });
        return sequence;
    }

    function getAdjacentBookId(books, currentBookId, direction) {
        const index = books.findIndex(book => String(book.bookId || '') === String(currentBookId || ''));
        const targetIndex = index + (direction < 0 ? -1 : 1);
        if (index < 0 || targetIndex < 0 || targetIndex >= books.length) {
            return '';
        }
        return String(books[targetIndex].bookId || '');
    }

    function getSwipeDirection(deltaX, deltaY, viewportWidth) {
        const width = Math.max(1, Number(viewportWidth) || 1);
        const horizontal = Number(deltaX) || 0;
        const vertical = Math.abs(Number(deltaY) || 0);
        const distance = Math.abs(horizontal);
        if (distance < Math.max(96, width / 3) || vertical > Math.min(96, distance * 0.45)) {
            return 0;
        }
        return horizontal < 0 ? 1 : -1;
    }

    function getDrawerExpandDirection(deltaX, deltaY) {
        const horizontal = Number(deltaX) || 0;
        const vertical = Math.abs(Number(deltaY) || 0);
        if (Math.abs(horizontal) < 56 || vertical > Math.abs(horizontal) * 0.65) return 0;
        return horizontal > 0 ? 1 : -1;
    }

    function clampPageIndex(index, pageCount) {
        const lastIndex = Math.max(0, Math.trunc(Number(pageCount) || 0) - 1);
        return Math.max(0, Math.min(lastIndex, Math.trunc(Number(index) || 0)));
    }

    root.Ecryptees = root.Ecryptees || {};
    root.Ecryptees.reader = Object.freeze({
        getBookSequence,
        compareNaturalTitles,
        applyManualOrder,
        getAdjacentBookId,
        getSwipeDirection,
        getDrawerExpandDirection,
        clampPageIndex
    });
})(typeof globalThis !== 'undefined' ? globalThis : self);
