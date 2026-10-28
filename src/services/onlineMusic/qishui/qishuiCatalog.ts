// src/services/onlineMusic/qishui/qishuiCatalog.ts
// 目录与账号歌单的读取；分页元数据由车机协议给出。

import i18n from '../../../i18n/config';
import type {
    OnlineCatalogProvider,
    OnlineLibraryProvider,
    ProviderCollection,
    ProviderLikedSongIds,
    ProviderPage,
} from '../../../types/onlineMusic';
import { OnlineProviderError } from '../../../types/onlineMusic';
import { normalizeQishuiCollection, normalizeQishuiSong, record, type QishuiRecord } from './qishuiNormalize';
import { requestQishui } from './qishuiTransport';
import { readQishuiSongs } from './qishuiPlayback';
import { getQishuiScene, isQishuiSceneId, qishuiSceneIdOf } from './qishuiRecommendations';

const RECENT_ID = 'recent-played';

// 「最近播放」是本地构造的入口，接口不给它封面：拿最近一首的封面当入口图。
// 只归一化一次、不触发可用性检查/补封面请求，失败就不带图。
const recentCover = async (): Promise<string> => {
    try {
        const page = await requestQishui<ProviderPage<unknown>>('recent_played', { limit: 1, offset: 0 });
        const first = page.items[0];
        if (!first) return '';
        return normalizeQishuiSong(first).album?.coverUrl || '';
    } catch {
        return '';
    }
};

const recentCollection = async (): Promise<ProviderCollection> => {
    const coverUrl = await recentCover();
    return {
        providerId: 'qishui',
        id: RECENT_ID,
        type: 'history',
        name: i18n.t('qishui.recentPlayed'),
        isOwned: false,
        ...(coverUrl ? { coverUrl } : {}),
    };
};

export const qishuiCatalog: OnlineCatalogProvider = {
    async getPlaylistTracks(id, limit, offset, collection) {
        if (id === RECENT_ID) {
            const page = await requestQishui<ProviderPage<unknown>>('recent_played', { limit, offset });
            return { ...page, items: await readQishuiSongs(page.items) };
        }
        if (isQishuiSceneId(String(id))) {
            // 场景电台没有"第几页"：每次取一批新的，界面按流的语义继续。
            const page = await requestQishui<{ items: unknown[]; hasMore: boolean }>('feed', {
                scene: qishuiSceneIdOf(String(id)),
                queue: 'fm',
                limit,
                first: offset === 0,
            });
            return {
                items: await readQishuiSongs(page.items),
                hasMore: page.hasMore,
                nextOffset: offset + page.items.length,
            };
        }
        const page = await requestQishui<ProviderPage<unknown>>('playlist_tracks', {
            id: String(id),
            limit,
            offset,
            ownerId: typeof collection?.providerData?.ownerId === 'string' ? collection.providerData.ownerId : '',
        });
        return { ...page, items: await readQishuiSongs(page.items) };
    },
    async getPlaylistDetail(id, collection) {
        if (id === RECENT_ID) return recentCollection();
        if (isQishuiSceneId(String(id))) {
            const scene = getQishuiScene(String(id));
            if (!scene) return collection ?? null;
            return {
                providerId: 'qishui',
                id: String(id),
                type: 'radio',
                name: scene.name,
                description: scene.group,
                ...(collection ?? {}),
            };
        }
        const raw = await requestQishui('playlist_detail', {
            id: String(id),
            limit: 1,
            ownerId: typeof collection?.providerData?.ownerId === 'string' ? collection.providerData.ownerId : '',
        });
        if (!raw) return null;
        const detail = normalizeQishuiCollection({ ...record(raw), isOwned: collection?.isOwned ?? record(raw).isOwned });
        return { ...collection, ...detail, ...(collection?.isLiked === true ? { isLiked: true } : {}) };
    },
    async getArtistSongs(id, limit, offset) {
        const page = await requestQishui<ProviderPage<unknown>>('artist_songs', { id: String(id), limit, offset });
        return { ...page, items: page.items.map(normalizeQishuiSong) };
    },
    async getArtistDetail(id) {
        const raw = await requestQishui('artist_detail', { id: String(id) });
        return raw ? normalizeQishuiCollection(raw, 'artist') : null;
    },
};

export const qishuiLibrary: OnlineLibraryProvider = {
    async getUserPlaylists(_userId, limit, offset) {
        // 只读的「最近播放」卡占一行；把库的 offset 换算成歌单行。
        const first = offset === 0;
        const page = await requestQishui<ProviderPage<QishuiRecord>>('user_playlists', {
            limit: first ? Math.max(1, limit - 1) : limit,
            offset: Math.max(0, offset - 1),
        });
        const rows = first && limit === 1 ? [] : page.items.map(item => normalizeQishuiCollection(item));
        const items = [...(first ? [await recentCollection()] : []), ...rows];
        return {
            items,
            hasMore: first && limit === 1 ? page.items.length > 0 || page.hasMore : page.hasMore,
            nextOffset: offset + items.length,
            ...(page.total === undefined ? {} : { total: page.total + 1 }),
        };
    },
    async getLikedSongIds() {
        const data = await requestQishui<ProviderLikedSongIds>('liked_songs');
        if (!Array.isArray(data.ids) || data.ids.some(id => typeof id !== 'string' || !/^\d+$/.test(id)) || typeof data.whole !== 'boolean') {
            throw new OnlineProviderError('invalid-response', 'Qishui liked songs are missing', 'qishui');
        }
        console.info('[Qishui] Liked songs read', { count: data.ids.length, whole: data.whole });
        return { ids: data.ids, whole: data.whole };
    },
};
