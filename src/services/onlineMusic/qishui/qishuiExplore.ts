// src/services/onlineMusic/qishui/qishuiExplore.ts
// 汽水自己的推荐流（探索页）：每次从头发起一轮新的读，翻页接着同一轮继续。

import i18n from '../../../i18n/config';
import type { UnifiedSong } from '../../../types';
import type { OnlineExploreProvider, ProviderExploreItem } from '../../../types/onlineMusic';
import { normalizeQishuiSong } from './qishuiNormalize';
import { requestQishui } from './qishuiTransport';

const TRIES_PER_BATCH = 3;
const cursorOf = (read: number, batch: number) => `qishui:${read}:${batch}`;

let read = 0;
let batches = 0;
let shown = new Set<string>();

export function clearQishuiExplore() {
    read += 1;
    batches = 0;
    shown = new Set();
}

async function nextItems(first: boolean, mine: number): Promise<{ items: ProviderExploreItem[]; hasMore: boolean } | null> {
    let hasMore = true;
    for (let attempt = 0; attempt < TRIES_PER_BATCH && hasMore; attempt += 1) {
        const data = await requestQishui<{ items: unknown[]; hasMore: boolean }>('feed', {
            queue: 'explore',
            first: first && attempt === 0,
            limit: 20,
        });
        if (mine !== read) return null;
        hasMore = data.hasMore;
        const fresh: UnifiedSong[] = [];
        for (const song of data.items.map(normalizeQishuiSong)) {
            const key = String(song.id);
            if (shown.has(key)) continue;
            shown.add(key);
            fresh.push(song);
        }
        if (!fresh.length) continue;
        return { items: fresh.map(song => ({ kind: 'song' as const, song })), hasMore };
    }
    return { items: [], hasMore: false };
}

export const qishuiExplore: OnlineExploreProvider = {
    async getFeed(cursor) {
        if (cursor) return { sections: [] };
        const mine = ++read;
        shown = new Set();
        const page = await nextItems(true, mine);
        if (!page) return { sections: [] };
        batches = 1;
        console.info('[Qishui] Explore stream read', { count: page.items.length });
        return {
            sections: [{
                id: 'stream',
                title: i18n.t('qishui.recommended'),
                items: page.items,
                ...(page.hasMore ? { moreCursor: cursorOf(mine, 1) } : {}),
            }],
            refreshReadsAnew: true,
        };
    },
    async getSectionItems(cursor) {
        const parsed = /^qishui:(\d+):(\d+)$/.exec(cursor);
        if (!parsed || Number(parsed[1]) !== read || batches >= 10) return { items: [] };
        const mine = read;
        const page = await nextItems(false, mine);
        if (!page) return { items: [] };
        batches += 1;
        return {
            items: page.items,
            ...(page.hasMore && batches < 10 ? { moreCursor: cursorOf(mine, batches) } : {}),
        };
    },
};
