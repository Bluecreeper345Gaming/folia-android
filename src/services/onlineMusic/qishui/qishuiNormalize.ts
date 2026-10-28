// src/services/onlineMusic/qishui/qishuiNormalize.ts
// 车机协议的实体归一化：64 位媒体 id 不做取整，播放能力不从付费标签去猜。

import type { UnifiedSong } from '../../../types';
import type { ProviderCollection, ProviderUser } from '../../../types/onlineMusic';
import { OnlineProviderError } from '../../../types/onlineMusic';

export type QishuiRecord = Record<string, any>;
export const record = (raw: unknown): QishuiRecord => (
    raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as QishuiRecord : {}
);
const text = (value: unknown) => (value == null ? '' : String(value));

// 汽水（Luna）有一部分封面是 800KB 级原图（tos-cn-v-* 路径），CDN 支持把模板尾巴换成小尺寸 webp。
// 其它路径（tos-cn-i-* 等）的原图本来就是几十 KB 的 png，套 c5 模板会直接 403——
// 那些必须保留原来的 ~tplv-xxx-image.image，不能改。
const QISHUI_COVER_SIZE = 480;
const qishuiSizedImage = (url: string): string => (
    /\/tos-cn-v-[^/]+\//.test(url) && /~[^/~]+$/.test(url)
        ? url.replace(/~[^/~]+$/, `~c5_${QISHUI_COVER_SIZE}x${QISHUI_COVER_SIZE}.webp`)
        : url
);

export function qishuiImage(raw: unknown): string {
    if (typeof raw === 'string') return raw.startsWith('https://') ? qishuiSizedImage(raw) : '';
    const value = record(raw);
    const url = Array.isArray(value.urls)
        ? value.urls.find((item: unknown) => typeof item === 'string' && item.startsWith('https://'))
        : '';
    if (!url) return '';
    const resolved = value.uri && url.endsWith('/')
        ? `${url}${value.uri}${value.template_prefix ? `~${value.template_prefix}-image.image` : ''}`
        : url;
    return qishuiSizedImage(resolved);
}

export function normalizeQishuiSong(raw: unknown): UnifiedSong {
    const song = record(raw);
    if (song.sourceRef?.kind === 'online' && song.sourceRef.providerId === 'qishui') return song as UnifiedSong;
    const base = record(song.base_info);
    const id = text(base.id || song.id);
    if (!/^\d+$/.test(id)) throw new OnlineProviderError('invalid-response', 'Qishui track ID is missing', 'qishui');
    const related = record(song.related_info);
    const album = record(related.album_link);
    const artists = Array.isArray(related.artist_links) ? related.artist_links : base.song_maker_team?.composers || [];
    return {
        id,
        name: text(base.name),
        durationMs: Math.max(0, Number(base.duration_ms) || 0),
        artists: artists
            .filter((artist: QishuiRecord) => artist.name)
            .map((artist: QishuiRecord) => ({
                id: text(artist.id),
                name: text(artist.name),
                ...(artist.id ? { catalogRef: { providerId: 'qishui', kind: 'artist' as const, id: text(artist.id) } } : {}),
            })),
        // 车机 SDK 没有专辑接口：保留元数据，但不要生成打不开的专辑入口。
        album: { id: text(album.id), name: text(album.name), coverUrl: qishuiImage(song.display_info?.cover_url) },
        sourceRef: { kind: 'online', providerId: 'qishui', mediaId: id },
    };
}

export function normalizeQishuiCollection(raw: unknown, type = 'playlist'): ProviderCollection {
    const item = record(raw);
    if (item.providerId === 'qishui') return item as ProviderCollection;
    const base = record(item.base_info);
    if (!base.id) throw new OnlineProviderError('invalid-response', 'Qishui collection ID is missing', 'qishui');
    const owner = record(item.relation_info?.owner);
    return {
        providerId: 'qishui',
        id: text(base.id),
        type,
        name: text(base.title || base.name),
        coverUrl: qishuiImage(type === 'artist' ? base.url_avatar : item.display_info?.url_cover),
        description: text(base.desc || base.intro),
        ...(item.resource_cnt?.track_cnt == null ? {} : { trackCount: Number(item.resource_cnt.track_cnt) }),
        ...(owner.id ? { creator: { id: text(owner.id), nickname: text(owner.nickname) } } : {}),
        ...(item.isOwned == null ? {} : { isOwned: Boolean(item.isOwned) }),
        providerData: { ownerId: text(base.owner_id || owner.id) },
        ...(Number(base.type) === 1 && item.isOwned === true ? { isLiked: true } : {}),
    };
}

export function normalizeQishuiUser(raw: unknown): ProviderUser {
    const user = record(raw);
    if (!user.id) throw new OnlineProviderError('invalid-response', 'Qishui account ID is missing', 'qishui');
    return {
        id: text(user.id),
        nickname: text(user.nickname),
        avatarUrl: qishuiImage(user.avatar),
        vipType: user.isVip ? 1 : 0,
    };
}
