// src/services/onlineMusic/qishui/qishuiRecommendations.ts
// 汽水的电台：私人 FM 取同一个推荐流（queue=fm）；车机场景列表（feed_modes）做成电台卡，
// 点开一张卡就是按那个场景取歌。与桌面端一致：场景卡只在这个账号读到场景表后才出现。

import type { OnlineRecommendationProvider, ProviderCollection } from '../../../types/onlineMusic';
import { normalizeQishuiSong, qishuiImage } from './qishuiNormalize';
import { requestQishui } from './qishuiTransport';

interface QishuiScene {
    id: string;
    name: string;
    group: string;
    coverUrl?: unknown;
}

const SCENE_PREFIX = 'scene:';
const CATALOG_TTL_MS = 10 * 60 * 1000;

let scenes: QishuiScene[] = [];
let catalogAt = 0;
let catalogTask: Promise<QishuiScene[]> | null = null;

export const isQishuiSceneId = (id: string) => id.startsWith(SCENE_PREFIX);
export const qishuiSceneIdOf = (id: string) => id.slice(SCENE_PREFIX.length);
export const getQishuiScene = (id: string) => scenes.find(scene => `${SCENE_PREFIX}${scene.id}` === id);

export function clearQishuiRecommendations() {
    scenes = [];
    catalogAt = 0;
    catalogTask = null;
}

const readScenes = async (): Promise<QishuiScene[]> => {
    if (catalogTask && Date.now() - catalogAt < CATALOG_TTL_MS) return catalogTask;
    catalogAt = Date.now();
    const task = requestQishui<QishuiScene[]>('feed_modes').then(rows => {
        const seen = new Set<string>();
        const list = rows.filter(row => /^\d+$/.test(row.id) && row.name && !seen.has(row.id) && Boolean(seen.add(row.id)));
        scenes = list;
        return list;
    }).catch(error => {
        if (catalogTask === task) catalogTask = null;
        throw error;
    });
    catalogTask = task;
    return task;
};

export const qishuiRecommendations: OnlineRecommendationProvider = {
    async getPersonalFm(options) {
        const data = await requestQishui<{ items: unknown[] }>('feed', {
            queue: 'fm',
            limit: 20,
            ...(options?.mode === 'SCENE_RCMD' && options.submode ? { scene: options.submode } : {}),
            ...(options?.mode === 'FAMILIAR' ? { preference: 'familiar' } : {}),
            ...(options?.mode === 'EXPLORE' ? { preference: 'fresh' } : {}),
        });
        return data.items.map(normalizeQishuiSong);
    },
    async getRecommendedCollections(limit): Promise<ProviderCollection[]> {
        const list = await readScenes();
        return list.slice(0, limit).map(scene => ({
            providerId: 'qishui',
            id: `${SCENE_PREFIX}${scene.id}`,
            type: 'radio',
            name: scene.name,
            description: scene.group,
            coverUrl: qishuiImage(scene.coverUrl),
        }));
    },
    async dislikeSong(id) {
        await requestQishui('dislike_song', { id: String(id), disliked: true });
        console.info('[Qishui] Recommendation disliked');
        return {};
    },
};
