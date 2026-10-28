// src/audioNative/ytmBrowse.ts
// 手机版（WebView）里直接跑 YouTube 的 InnerTube 浏览接口：歌单、喜欢、专辑、歌手、探索页、
// 电台（mix）与收藏。
//
// 桌面版把这一层放在主进程（electron/ytm/*.cjs）里，用 youtubei.js 的 YTMUSIC 客户端；
// 手机上没有主进程，youtubei 的会话在 WebView 里也不一定建得起来（见 ytm.ts 里那段说明），
// 所以这里回到最朴素的一层：POST /youtubei/v1/browse（或 next），自己把 JSON 解析成
// services/onlineMusic/ytm/ytmTransport.ts 里那套 wire 形状。
//
// 页面版式是按 2026-10 的实测样本写的：
//   - 歌单页 / 专辑页 / 歌手页：musicResponsiveHeaderRenderer（或 musicImmersiveHeaderRenderer）
//     + musicResponsiveListItemRenderer 行（歌名、歌手、专辑、时长、playlistSetVideoId）
//   - 探索页 / 首页：musicCarouselShelfRenderer / musicShelfRenderer，条目是
//     musicTwoRowItemRenderer（卡片）或 musicResponsiveListItemRenderer（行）
//   - 电台：/next 的 playlistPanelVideoRenderer
// 认不出的版式只会少几条，不会把整页当成空。
import type {
    YtmWireAlbum,
    YtmWireArtistPage,
    YtmWireCollection,
    YtmWireExploreItem,
    YtmWireExplorePage,
    YtmWirePage,
    YtmWirePlaylistPage,
    YtmWireSong,
} from '../services/onlineMusic/ytm/ytmTransport';
import { innertubePost, sha256Hex } from './ytmHttp';

const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const node = (value: unknown): any => (value && typeof value === 'object' ? value : null);

const txt = (value: unknown): string => arr(node(value)?.runs)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((run: any) => String(node(run)?.text ?? ''))
    .join('');

/** "4:30" / "1:02:03" → 毫秒；不是时长就是 0。 */
const durationMsOf = (text: string): number => {
    const parts = String(text || '').trim().split(':').map(part => Number(part));
    if (parts.length < 2 || parts.some(part => !Number.isFinite(part))) return 0;
    return Math.max(0, Math.round(parts.reduce((total, part) => total * 60 + part, 0) * 1000));
};

const DURATION_TEXT = /^\d+(?::\d{1,2})+$/;
// 副标题里这些不是歌手：版式标签、播放量、点赞数。
const SERVICE_LABELS = new Set([
    '单曲', '专辑', '播放列表', '合辑', 'EP', '单曲和迷你专辑', '歌手', '视频', '播客', '音乐视频',
    'Song', 'Single', 'Album', 'Playlist', 'Artist', 'Video', 'EP', 'Podcast',
]);
const NOT_AN_ARTIST = /(次观看|播放次数|人赞|views?|likes?|订阅者|subscribers?)/i;
const YEAR_ONLY = /^\d{4}(年)?$/;
const isMetaPart = (part: string): boolean => NOT_AN_ARTIST.test(part) || YEAR_ONLY.test(part);
const isServiceLabel = (text: string): boolean => SERVICE_LABELS.has(text);
const artistNames = (text: string): string[] => String(text || '')
    .split(/[、,&/]|和/)
    .map(name => name.trim())
    .filter(Boolean);

/** 一个节点下所有同名的子节点（文档顺序）。 */
const findAll = (root: unknown, key: string): unknown[] => {
    const out: unknown[] = [];
    const walk = (value: unknown): void => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
            value.forEach(walk);
            return;
        }
        for (const [name, child] of Object.entries(value)) {
            if (name === key) out.push(child);
            walk(child);
        }
    };
    walk(root);
    return out;
};

const lastThumb = (list: unknown): string => String(node(arr(list).slice(-1)[0])?.url ?? '');
const coverOf = (item: unknown): string => (
    // 行（musicResponsiveListItemRenderer）用 thumbnail，卡片（musicTwoRowItemRenderer）用 thumbnailRenderer。
    lastThumb(node(node(item)?.thumbnail)?.musicThumbnailRenderer?.thumbnail?.thumbnails)
    || lastThumb(node(node(item)?.thumbnailRenderer)?.musicThumbnailRenderer?.thumbnail?.thumbnails)
    || lastThumb(node(node(item)?.thumbnail)?.thumbnails)
    || lastThumb(node(node(item)?.thumbnailRenderer)?.thumbnail?.thumbnails)
);

/** 一行/一张卡里的歌手与专辑 id（YouTube 把链接挂在 run 的 browseEndpoint 上）。 */
const catalogOf = (runs: unknown[]) => {
    const artists: Array<{ id: string; name: string }> = [];
    let albumId = '';
    let albumName = '';
    for (const run of runs) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const endpoint = node(run)?.navigationEndpoint?.browseEndpoint as any;
        const pageType = String(endpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType ?? '');
        const id = String(endpoint?.browseId ?? '');
        if (!id) continue;
        if (pageType === 'MUSIC_PAGE_TYPE_ARTIST') artists.push({ id, name: String(node(run)?.text ?? '') });
        else if (pageType === 'MUSIC_PAGE_TYPE_ALBUM') {
            albumId = id;
            albumName = String(node(run)?.text ?? '');
        }
    }
    return { artists: artists.filter(artist => artist.name), albumId, albumName };
};

const partsOf = (text: string): string[] => String(text || '')
    .split('•')
    .map(part => part.trim())
    .filter(Boolean);

const videoIdOf = (row: unknown): string => String(
    node(row)?.playlistItemData?.videoId
    ?? node(row)?.navigationEndpoint?.watchEndpoint?.videoId
    ?? node(row)?.overlay?.playButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId
    ?? node(row)?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
        ?.playNavigationEndpoint?.watchEndpoint?.videoId
    ?? '',
);

/** 歌单/专辑/歌手页里的一行（musicResponsiveListItemRenderer）。 */
const songOfRow = (row: unknown): YtmWireSong | null => {
    const id = videoIdOf(row);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const columns: any[] = arr(node(row)?.flexColumns)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((column: any) => column?.musicResponsiveListItemFlexColumnRenderer);
    const name = txt(columns[0]?.text);
    if (!id || !name) return null;
    const parts: string[] = [];
    const runs: unknown[] = [];
    for (const column of columns.slice(1)) {
        runs.push(...arr(column?.text?.runs));
        parts.push(...partsOf(txt(column?.text)));
    }
    const { artists: linked, albumId, albumName } = catalogOf(runs);
    const durationPart = parts.find(part => DURATION_TEXT.test(part)) ?? '';
    const meta = parts.filter(part => part !== durationPart && !isMetaPart(part));
    const artists = linked.length > 0
        ? linked
        : artistNames(meta[0] ?? '').map(artistName => ({ id: '', name: artistName }));
    const setVideoId = String(node(row)?.playlistItemData?.playlistSetVideoId ?? '');
    return {
        id,
        name,
        artists,
        // 专辑页的行第二列常常是空的（"播放次数"），所以专辑名宁可空着，也不要拿播放量顶替。
        album: { id: albumId, name: albumName || String(meta[1] ?? ''), coverUrl: coverOf(row) },
        durationMs: durationMsOf(durationPart),
        ...(setVideoId ? { setVideoId } : {}),
    };
};

/** 电台（/next 的 playlistPanelVideoRenderer）里的一行。 */
const songOfPanelRow = (row: unknown): YtmWireSong | null => {
    const id = String(node(row)?.videoId ?? node(row)?.playlistItemData?.videoId ?? '');
    const name = txt(node(row)?.title);
    if (!id || !name) return null;
    const byline = arr(node(row)?.longBylineText?.runs).length > 0
        ? arr(node(row)?.longBylineText?.runs)
        : arr(node(row)?.shortBylineText?.runs);
    const { artists: linked } = catalogOf(byline);
    const parts = partsOf(txt({ runs: byline }));
    const artists = linked.length > 0
        ? linked
        : artistNames(parts.find(part => !isMetaPart(part)) ?? '')
            .map(artistName => ({ id: '', name: artistName }));
    const setVideoId = String(node(row)?.playlistSetVideoId ?? '');
    return {
        id,
        name,
        artists,
        album: { id: '', name: '', coverUrl: coverOf(row) },
        durationMs: durationMsOf(txt(node(row)?.lengthText)),
        ...(setVideoId ? { setVideoId } : {}),
    };
};

/** 一张卡（musicTwoRowItemRenderer）指向的集合：歌单、专辑或歌手。 */
const collectionOfCard = (card: unknown): { collection: YtmWireCollection; wideCoverUrl?: string } | null => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const endpoint = node(node(card)?.navigationEndpoint)?.browseEndpoint as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const titleRun = node(arr(node(card)?.title?.runs)[0]) as any;
    const browseId = String(endpoint?.browseId ?? titleRun?.navigationEndpoint?.browseEndpoint?.browseId ?? '');
    const pageType = String(
        endpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType
        ?? titleRun?.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs
            ?.browseEndpointContextMusicConfig?.pageType
        ?? '',
    );
    if (!browseId) return null;
    // 歌单的 browseId 一律带 VL 前缀；专辑是 MPRE…，歌手是 UC…。
    const isList = browseId.startsWith('VL');
    let type: YtmWireCollection['type'];
    if (isList) type = 'playlist';
    else if (pageType === 'MUSIC_PAGE_TYPE_ALBUM' || browseId.startsWith('MPRE')) type = 'album';
    else if (pageType === 'MUSIC_PAGE_TYPE_ARTIST' || browseId.startsWith('UC')) type = 'artist';
    else return null;
    const id = isList ? browseId.slice(2) : browseId;
    const name = txt(node(card)?.title);
    if (!name) return null;
    const cardParts = partsOf(txt(node(card)?.subtitle));
    const names = cardParts.filter(part => !isServiceLabel(part) && !isMetaPart(part));
    const year = /^(\d{4})/.exec(cardParts.find(part => /^\d{4}(年)?$/.test(part)) ?? '')?.[1];
    // RD… 是 YouTube 现场生成的电台/混音：它没有歌单页，只能按"队列"读（`mix`）。
    const mix = type === 'playlist' && id.startsWith('RD');
    const videoId = mix && id.startsWith('RDAMVM') ? id.slice('RDAMVM'.length) : '';
    const cover = coverOf(card);
    return {
        collection: {
            id,
            type,
            name,
            coverUrl: cover,
            artists: names.length > 0 ? artistNames(names.join(' ')).map(artistName => ({ id: '', name: artistName })) : [],
            ...(mix ? { mix: true, ...(videoId ? { videoId } : {}) } : {}),
            ...(year ? { year: Number(year) } : {}),
        },
        ...(String(node(card)?.aspectRatio ?? '') === 'MUSIC_TWO_ROW_ITEM_THUMBNAIL_ASPECT_RATIO_16_9' ? { wideCoverUrl: cover } : {}),
    };
};

/** 列表行（musicResponsiveListItemRenderer）指向的集合：库里以列表显示的歌单/专辑。 */
const collectionOfListRow = (row: unknown): YtmWireCollection | null => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const endpoint = node(node(row)?.navigationEndpoint)?.browseEndpoint as any;
    const browseId = String(endpoint?.browseId ?? '');
    if (!browseId) return null;
    const pageType = String(endpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType ?? '');
    const isList = browseId.startsWith('VL');
    let type: YtmWireCollection['type'];
    if (isList) type = 'playlist';
    else if (pageType === 'MUSIC_PAGE_TYPE_ALBUM' || browseId.startsWith('MPRE')) type = 'album';
    else if (pageType === 'MUSIC_PAGE_TYPE_ARTIST' || browseId.startsWith('UC')) type = 'artist';
    else return null;
    const id = isList ? browseId.slice(2) : browseId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const columns: any[] = arr(node(row)?.flexColumns)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((column: any) => column?.musicResponsiveListItemFlexColumnRenderer);
    const name = txt(columns[0]?.text);
    if (!name) return null;
    const rest = partsOf(columns.slice(1).map(column => txt(column?.text)).filter(Boolean).join(' • '));
    const names = rest.filter(part => !isServiceLabel(part) && !isMetaPart(part) && !DURATION_TEXT.test(part));
    const countMatch = /(\d[\d,]*)\s*(?:首|曲目|songs?|tracks?)/i.exec(rest.join(' '));
    const mix = type === 'playlist' && id.startsWith('RD');
    return {
        id,
        type,
        name,
        coverUrl: coverOf(row),
        artists: names.length > 0 ? artistNames(names.join(' ')).map(artistName => ({ id: '', name: artistName })) : [],
        ...(countMatch ? { trackCount: Number(countMatch[1].replace(/,/g, '')) } : {}),
        ...(mix ? { mix: true, ...(id.startsWith('RDAMVM') ? { videoId: id.slice('RDAMVM'.length) } : {}) } : {}),
    };
};

/** 卡片形式的歌曲（探索页"新音乐视频"那种）。 */
const songOfCard = (card: unknown): YtmWireSong | null => {
    const id = videoIdOf(card);
    const name = txt(node(card)?.title);
    if (!id || !name) return null;
    const subtitle = partsOf(txt(node(card)?.subtitle));
    return {
        id,
        name,
        artists: artistNames(subtitle.find(part => !isMetaPart(part)) ?? '')
            .map(artistName => ({ id: '', name: artistName })),
        album: { id: '', name: '', coverUrl: coverOf(card) },
        durationMs: 0,
    };
};

const exploreItemOf = (item: unknown): YtmWireExploreItem[] => {
    if (node(item)?.musicTwoRowItemRenderer) {
        const card = node(item).musicTwoRowItemRenderer;
        const collection = collectionOfCard(card);
        if (collection) {
            return [{
                kind: 'collection',
                collection: collection.collection,
                ...(collection.wideCoverUrl ? { wideCoverUrl: collection.wideCoverUrl } : {}),
            }];
        }
        const song = songOfCard(card);
        return song ? [{ kind: 'song', song }] : [];
    }
    if (node(item)?.musicResponsiveListItemRenderer) {
        const row = node(item).musicResponsiveListItemRenderer;
        const song = songOfRow(row);
        if (song) return [{ kind: 'song', song }];
        const collection = collectionOfListRow(row);
        return collection ? [{ kind: 'collection', collection }] : [];
    }
    return [];
};

/** 探索页/首页的一排一排：每排一个标题，条目按顺序解析。 */
const exploreSections = (root: unknown): Array<{ title: string; items: YtmWireExploreItem[] }> => {
    const sections: Array<{ title: string; items: YtmWireExploreItem[] }> = [];
    const walk = (value: unknown): void => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
            value.forEach(walk);
            return;
        }
        const carousel = node(value)?.musicCarouselShelfRenderer;
        if (carousel) {
            sections.push({
                title: txt(carousel?.header?.musicCarouselShelfBasicHeaderRenderer?.title).trim(),
                items: arr(carousel?.contents).flatMap(exploreItemOf),
            });
            return;
        }
        const shelf = node(value)?.musicShelfRenderer;
        if (shelf) {
            sections.push({ title: txt(shelf?.title).trim(), items: arr(shelf?.contents).flatMap(exploreItemOf) });
            return;
        }
        for (const key of Object.keys(value)) walk(node(value)[key]);
    };
    walk(root);
    return sections.filter(section => section.items.length > 0);
};

/** 页头的总数/年份：`musicResponsiveHeaderRenderer` 或 `musicImmersiveHeaderRenderer`。 */
const headerOf = (root: unknown) => (
    node(findAll(root, 'musicResponsiveHeaderRenderer')[0])
    ?? node(findAll(root, 'musicDetailHeaderRenderer')[0])
    ?? node(findAll(root, 'musicImmersiveHeaderRenderer')[0])
    ?? node(findAll(root, 'musicVisualHeaderRenderer')[0])
);

const trackCountOf = (root: unknown): number | undefined => {
    const header = headerOf(root);
    const text = [txt(header?.secondSubtitle), txt(header?.subtitle)].join(' ');
    const match = /([\d,]+)\s*(?:首|曲目|songs?|tracks?)/i.exec(text);
    return match ? Number(match[1].replace(/,/g, '')) : undefined;
};

const playlistIdOfHeader = (header: unknown): string => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const button of arr(node(header)?.buttons) as any[]) {
        const endpoint = button?.musicPlayButtonRenderer?.playNavigationEndpoint
            ?? button?.buttonRenderer?.navigationEndpoint;
        const id = endpoint?.watchPlaylistEndpoint?.playlistId ?? endpoint?.watchEndpoint?.playlistId;
        if (id) return String(id);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const play = node(header)?.playButton?.buttonRenderer?.navigationEndpoint as any;
    return String(play?.watchPlaylistEndpoint?.playlistId ?? play?.watchEndpoint?.playlistId ?? '');
};

/** 页尾的续页 token：取最后一个（页级 token 排在各排之后）。 */
const continuationOf = (root: unknown): string | undefined => {
    const tokens = findAll(root, 'continuationItemRenderer')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((item: any) => item?.continuationEndpoint?.continuationCommand?.token)
        .filter((token): token is string => typeof token === 'string' && token.length > 0);
    return tokens.length > 0 ? tokens[tokens.length - 1] : undefined;
};

/** YouTube 没登录时会回一段"请登录"的提示，而不是空列表。 */
const signInRequired = (root: unknown): boolean => findAll(root, 'messageRenderer')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .some((message: any) => /登录|sign.?in/i.test(`${txt(message?.text)} ${txt(message?.subtext)}`));

const songRows = (root: unknown): YtmWireSong[] => findAll(root, 'musicResponsiveListItemRenderer')
    .map(songOfRow)
    .filter((song): song is YtmWireSong => song !== null);

/**
 * 一页里的歌：只看歌架（歌单页的 musicPlaylistShelfRenderer、专辑/歌手页的 musicShelfRenderer）
 * 里的行。页尾常有"你可能还喜欢"之类的架子，整页扫描会把别人的歌也扫进来。
 * 一个架子都没有（版式变了）才退回整页扫描。
 */
const songsInPage = (root: unknown): YtmWireSong[] => {
    const shelves = [...findAll(root, 'musicPlaylistShelfRenderer'), ...findAll(root, 'musicShelfRenderer')];
    const rows = shelves.length > 0
        ? shelves.flatMap(shelf => songRows(shelf))
        : songRows(root);
    return uniqueSongs(rows);
};

const uniqueSongs = (songs: YtmWireSong[]): YtmWireSong[] => {
    const seen = new Set<string>();
    return songs.filter(song => {
        if (seen.has(song.id)) return false;
        seen.add(song.id);
        return true;
    });
};

const uniqueCollections = (collections: YtmWireCollection[]): YtmWireCollection[] => {
    const seen = new Set<string>();
    return collections.filter(collection => {
        const key = `${collection.type}:${collection.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

const collectionsOf = (root: unknown, type?: YtmWireCollection['type']): YtmWireCollection[] => {
    const cards = findAll(root, 'musicTwoRowItemRenderer')
        .map(collectionOfCard)
        .filter((item): item is { collection: YtmWireCollection } => item !== null)
        .map(item => item.collection);
    const rows = findAll(root, 'musicResponsiveListItemRenderer')
        .map(collectionOfListRow)
        .filter((collection): collection is YtmWireCollection => collection !== null);
    const all = uniqueCollections([...cards, ...rows]);
    return type ? all.filter(collection => collection.type === type) : all;
};

/**
 * 当前登录的是哪个账号 —— 与桌面版同一套读法（electron/ytm/webPages.cjs accountFromList）：
 *   POST /account/accounts_list → 菜单里 isSelected 那一项 → accountName 是昵称，
 *   supportedTokens 里的 obfuscatedGaiaId 是 Google 的身份，
 *   对外只露 `sha256('folia-ytm:' + gaiaId)` 的前 24 位（桌面就是这么显示的：一串十六进制）。
 * Premium 读 /account/account_menu 里的图标（有 UNLIMITED＝不是会员，有 MONETIZATION_ON＝是会员）。
 * 以前这里读的是 /account/account_menu 的 header，还拿邮箱当昵称，所以显示得跟桌面完全对不上。
 */
export const readYtmAccount = async (): Promise<{
    id: string; nickname: string; avatarUrl: string; vipType?: number;
} | null> => {
    const list = await innertubePost('account/accounts_list', {});
    const accounts: unknown[] = [];
    for (const action of arr(node(list)?.actions)) {
        const menu = node(node(action)?.getMultiPageMenuAction)?.menu?.multiPageMenuRenderer;
        for (const section of arr(menu?.sections)) {
            for (const group of arr(node(section)?.accountSectionListRenderer?.contents)) {
                for (const entry of arr(node(group)?.accountItemSectionRenderer?.contents)) {
                    if (node(entry)?.accountItem) accounts.push(node(entry).accountItem);
                }
            }
        }
    }
    const account = accounts.find(item => node(item)?.isSelected === true) ?? accounts[0];
    const nickname = txt(node(account)?.accountName) || String(node(account)?.accountName?.text ?? '');
    if (!nickname) {
        const renderers = [...new Set((() => {
            const found: string[] = [];
            JSON.stringify(list, (key, value) => {
                if (/Renderer$/.test(key)) found.push(key);
                return value;
            });
            return found;
        })())];
        console.warn(`[YTM][browse] accounts_list named no account (top keys: ${Object.keys(node(list) ?? {}).join(',') || 'none'}; `
            + `renderers: ${renderers.slice(0, 10).join(',') || 'none'})`);
        return null;
    }
    // Google 的身份在 supportedTokens 的 accountStateToken.obfuscatedGaiaId 里，页面上不直接用。
    let gaiaId = '';
    for (const token of arr(node(account)?.serviceEndpoint?.selectActiveIdentityEndpoint?.supportedTokens)) {
        const value = node(node(token)?.accountStateToken)?.obfuscatedGaiaId;
        if (typeof value === 'string' && value) { gaiaId = value; break; }
    }
    const handle = txt(node(account)?.channelHandle);
    const id = (await sha256Hex(`folia-ytm:${gaiaId || handle || nickname}`)).slice(0, 24);
    const avatarUrl = lastThumb(node(node(account)?.accountPhoto)?.thumbnails);

    // Premium：菜单里有"升级"入口（UNLIMITED）就是没会员，有"会员"入口（MONETIZATION_ON）就是会员。
    let vipType: number | undefined;
    try {
        const menu = await innertubePost('account/account_menu', {});
        const icons = new Set<string>();
        const visit = (value: unknown): void => {
            if (!value || typeof value !== 'object') return;
            const icon = node(value)?.iconType;
            if (typeof icon === 'string') icons.add(icon);
            for (const child of Object.values(node(value) ?? {})) visit(child);
        };
        visit(menu);
        if (icons.has('UNLIMITED')) vipType = 0;
        else if (icons.has('MONETIZATION_ON')) vipType = 1;
    } catch (error) {
        console.warn('[YTM][browse] premium could not be read:', error instanceof Error ? error.message : String(error));
    }

    console.log(`[YTM][browse] account: nickname=${nickname} id=${id} gaia=${gaiaId ? '有' : '无'} handle=${handle || '(空)'} `
        + `avatar=${avatarUrl ? '有' : '无'} premium=${vipType === undefined ? '未读出' : vipType ? '是' : '否'}`);
    return { id, nickname, avatarUrl, ...(vipType === undefined ? {} : { vipType }) };
};

// ---------------------------------------------------------------------------
// 各个操作
// ---------------------------------------------------------------------------

const readPlaylistPage = async (
    id: string,
    continuation: string | undefined,
    guest: boolean,
): Promise<YtmWirePlaylistPage> => {
    const json = await innertubePost('browse', continuation ? { continuation } : { browseId: `VL${id}` }, { guest });
    const items = songsInPage(json);
    const trackCount = trackCountOf(json);
    const next = continuationOf(json);
    if (items.length === 0 && !continuation && signInRequired(json)) {
        throw new Error(`YouTube Music 需要登录后才能读取这个歌单（${id}）`);
    }
    console.log(`[YTM][browse] playlist ${id}${continuation ? ' (续页)' : ''}: ${items.length} 首`
        + `${trackCount === undefined ? '' : `（页头写 ${trackCount} 首）`}${next ? '，还有续页' : ''}`
        + `${items.length === 0 ? `（${signInRequired(json) ? '页面在要登录' : '页面没有行'}）` : ''}`);
    return {
        items,
        ...(next ? { continuation: next } : {}),
        ...(trackCount === undefined ? {} : { trackCount }),
    };
};

const readLibraryPage = async (
    browseId: string,
    type: YtmWireCollection['type'],
    continuation?: string,
): Promise<YtmWirePage<YtmWireCollection>> => {
    const json = await innertubePost('browse', continuation ? { continuation } : { browseId });
    const items = collectionsOf(json, type);
    if (items.length === 0 && !continuation && signInRequired(json)) {
        throw new Error('YouTube Music 需要登录后才能读取你的音乐库');
    }
    const next = continuationOf(json);
    const names = items.slice(0, 5).map(item => item.name).filter(Boolean).join(' / ');
    console.log(`[YTM][browse] ${browseId}${continuation ? ' (续页)' : ''}: ${items.length} 个${type === 'album' ? '专辑' : '歌单'}${next ? '，还有续页' : ''}`
        + `${names ? `：${names}` : ''}`);
    return { items, ...(next ? { continuation: next } : {}) };
};

const readAlbum = async (id: string): Promise<YtmWireAlbum> => {
    const json = await innertubePost('browse', { browseId: id });
    const header = headerOf(json);
    const items = songsInPage(json);
    const subtitle = partsOf(txt(header?.subtitle));
    const year = /^(\d{4})/.exec(subtitle.find(part => /^\d{4}(年)?$/.test(part)) ?? '')?.[1];
    const trackCount = trackCountOf(json);
    const listId = playlistIdOfHeader(header);
    const collection: YtmWireCollection = {
        id,
        type: 'album',
        name: txt(header?.title),
        coverUrl: coverOf(header),
        artists: artistNames(subtitle.filter(part => !isServiceLabel(part) && !isMetaPart(part)).join(' '))
            .map(artistName => ({ id: '', name: artistName })),
        ...(trackCount === undefined ? {} : { trackCount }),
        ...(listId ? { playlistId: listId } : {}),
        ...(year ? { year: Number(year) } : {}),
    };
    if (items.length === 0 && signInRequired(json)) {
        throw new Error(`YouTube Music 需要登录后才能读取这张专辑（${id}）`);
    }
    // 专辑页的行一般没有歌手与专辑列（那两列空着），按页头补齐：这些歌都属于这张专辑。
    const filled = items.map(song => ({
        ...song,
        artists: song.artists.length > 0 ? song.artists : collection.artists ?? [],
        album: {
            id: song.album.id || collection.id,
            name: song.album.name || collection.name,
            coverUrl: song.album.coverUrl || collection.coverUrl,
        },
    }));
    console.log(`[YTM][browse] album ${id}: ${filled.length} 首，list id ${collection.playlistId ?? '（页头没写）'}`);
    return { collection, items: filled };
};

const readArtist = async (id: string): Promise<YtmWireArtistPage> => {
    const json = await innertubePost('browse', { browseId: id });
    const header = headerOf(json);
    const songs = uniqueSongs(arr(findAll(json, 'musicShelfRenderer')).flatMap(shelf => songRows(shelf)));
    const albums = collectionsOf(json, 'album');
    const collection: YtmWireCollection = {
        id,
        type: 'artist',
        name: txt(header?.title),
        coverUrl: coverOf(header),
        ...(txt(header?.description) ? { description: txt(header?.description) } : {}),
    };
    console.log(`[YTM][browse] artist ${id}: ${songs.length} 首歌，${albums.length} 张专辑`);
    return { collection, songs, albums };
};

const readExplore = async (continuation?: string): Promise<YtmWireExplorePage> => {
    const json = await innertubePost('browse', continuation ? { continuation } : { browseId: 'FEmusic_home' });
    let sections = exploreSections(json);
    const next = continuationOf(json);
    if (!continuation) {
        // 首页是"给你的"（登录后才丰富）；"探索"页有新专辑、时下流行这些首页未必有的栏目。
        // 两页并起来，同名的栏目只留第一次出现的那一排。
        const more = await innertubePost('browse', { browseId: 'FEmusic_explore' })
            .then(exploreSections)
            .catch(error => {
                console.warn(`[YTM][browse] explore page could not be read (${error instanceof Error ? error.message : String(error)})`);
                return [] as Array<{ title: string; items: YtmWireExploreItem[] }>;
            });
        const seen = new Set(sections.map(section => section.title));
        sections = [...sections, ...more.filter(section => !seen.has(section.title))];
    }
    if (sections.length === 0 && !continuation) {
        if (signInRequired(json)) throw new Error('YouTube Music 需要登录后才能读取探索页');
        throw new Error('YouTube 探索页没有解析出任何栏目（页面版式可能变了）');
    }
    console.log(`[YTM][browse] explore${continuation ? ' (续页)' : ''}: ${sections.length} 个栏目，`
        + `${sections.reduce((sum, section) => sum + section.items.length, 0)} 条；`
        + `其中歌单/混音 ${sections.flatMap(section => section.items)
            .filter(item => item.kind === 'collection' && item.collection.type === 'playlist').length} 个`
        + `${next ? '，还有续页' : ''}`);
    return { sections, ...(next ? { continuation: next } : {}) };
};

const readMix = async (id: string, videoId?: string): Promise<YtmWirePage<YtmWireSong>> => {
    // RDAMVM… 是 "这首歌的电台"；RDCLAK… / RD… 是 YouTube 现场生成的混音，都走 /next 的队列。
    const playlistId = id.startsWith('RD') ? id : `RDAMVM${id}`;
    const json = await innertubePost('next', { playlistId, ...(videoId ? { videoId } : {}) }, { guest: true });
    const items = uniqueSongs(findAll(json, 'playlistPanelVideoRenderer')
        .map(songOfPanelRow)
        .filter((song): song is YtmWireSong => song !== null));
    if (items.length === 0) {
        throw new Error(`YouTube 没有给出这个电台的歌曲（${playlistId}）`);
    }
    console.log(`[YTM][browse] mix ${playlistId}: ${items.length} 首`);
    return { items };
};

const rateSong = async (id: string, liked: boolean): Promise<Record<string, never>> => {
    // like/like 与 like/dislike 都不需要额外参数：会话 + 视频 id 就够了。
    await innertubePost(liked ? 'like/like' : 'like/dislike', { target: { videoId: id } });
    console.log(`[YTM][browse] ${liked ? 'like' : 'dislike'} ${id}`);
    return {};
};

const editPlaylist = async (params: Record<string, string | undefined>): Promise<Record<string, never>> => {
    const id = String(params.id ?? '');
    const videoIds = String(params.videoIds ?? '').split(',').map(value => value.trim()).filter(Boolean);
    const setVideoIds = String(params.setVideoIds ?? '').split(',').map(value => value.trim());
    const actions = params.action === 'add'
        ? videoIds.map(videoId => ({ action: 'ACTION_ADD_VIDEO', addedVideoId: videoId }))
        : videoIds.map((videoId, index) => ({
            action: 'ACTION_REMOVE_VIDEO',
            removedVideoId: videoId,
            ...(setVideoIds[index] ? { setVideoId: setVideoIds[index] } : {}),
        }));
    if (actions.length === 0) return {};
    await innertubePost('browse/edit_playlist', { playlistId: id, actions });
    console.log(`[YTM][browse] playlist ${id}: ${actions.length} 首${params.action === 'add' ? '加入' : '移出'}`);
    return {};
};

const readSaved = async (id: string, albumId?: string): Promise<{ saved: boolean }> => {
    // 收藏状态就写在专辑页头的收藏按钮上（isToggled）。读不到就当没收藏：不让一个读状态把整页弄挂。
    // 歌单页那个 toggle 是"稍后观看"，不是"收藏到音乐库"，所以歌单一律按"未收藏"答。
    const browseId = albumId || (id.startsWith('MPRE') ? id : '');
    if (!browseId) {
        console.log(`[YTM][browse] saved(${id}): 歌单的收藏状态这一版不读，按未收藏答`);
        return { saved: false };
    }
    const json = await innertubePost('browse', { browseId });
    const toggles = [...findAll(json, 'toggleButtonRenderer'), ...findAll(json, 'toggleMenuServiceItemRenderer')];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const saved = toggles.some((toggle: any) => toggle?.isToggled === true);
    console.log(`[YTM][browse] saved(${browseId}): ${saved}`);
    return { saved };
};

export const YTM_BROWSE_OPERATIONS = [
    'playlist', 'public_playlist', 'user_playlists', 'user_albums',
    'album', 'artist', 'explore', 'mix',
    'song_like', 'playlist_edit', 'list_saved', 'list_save',
] as const;
export const isYtmBrowseOperation = (operation: string): boolean => (
    (YTM_BROWSE_OPERATIONS as readonly string[]).includes(operation)
);

/** 一个账号/浏览类的操作。返回的形状与桌面版 `window.electron.ytmRequest` 的 data 一致。 */
export const runYtmBrowseOperation = async (
    operation: string,
    params: Record<string, string | undefined> = {},
): Promise<unknown> => {
    const id = String(params.id ?? '').trim();
    switch (operation) {
        case 'playlist':
            if (!id) throw new Error('YouTube Music playlist has no id');
            return readPlaylistPage(id, params.continuation, false);
        case 'public_playlist':
            if (!id) throw new Error('YouTube Music playlist has no id');
            return readPlaylistPage(id, params.continuation, true);
        case 'user_playlists':
            return readLibraryPage('FEmusic_liked_playlists', 'playlist', params.continuation);
        case 'user_albums':
            return readLibraryPage('FEmusic_liked_albums', 'album', params.continuation);
        case 'album':
            if (!id) throw new Error('YouTube Music album has no id');
            return readAlbum(id);
        case 'artist':
            if (!id) throw new Error('YouTube Music artist has no id');
            return readArtist(id);
        case 'explore':
            return readExplore(params.continuation);
        case 'mix':
            if (!id) throw new Error('YouTube Music mix has no id');
            return readMix(id, params.videoId);
        case 'song_like':
            if (!id) throw new Error('YouTube Music song has no id');
            return rateSong(id, params.liked === 'true');
        case 'playlist_edit':
            return editPlaylist(params);
        case 'list_saved':
            return readSaved(id, params.albumId);
        case 'list_save': {
            // 收藏/取消收藏要回放页头那个按钮自己的导航端点（每个版本都不一样），这一版先不做。
            const error = new Error('手机版暂不支持收藏/取消收藏到音乐库');
            (error as Error & { ytmCode?: string }).ytmCode = 'unsupported';
            throw error;
        }
        default:
            throw new Error(`YouTube Music operation is not available on this build: ${operation}`);
    }
};
