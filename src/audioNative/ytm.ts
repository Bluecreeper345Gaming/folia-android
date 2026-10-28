// src/audioNative/ytm.ts
// Android 上的 YouTube Music：youtubei.js 的浏览器包直接在 WebView 里跑（node_modules 里本来就有，
// 这里把 bundle 收进 vendor/，避免依赖那个缺 package.json 的包目录解析）。
//
// 桌面版走 Electron 主进程（electron/ytm/*.cjs，里面有 poToken、沙箱、自建 folia-ytm:// 协议）。
// 手机上没有主进程，但 youtubei.js 在浏览器里同样能用：
//   - 搜索：yt.music.search(query, { type: 'song' })
//   - 单曲：yt.music.getInfo(id)
//   - 播放地址：yt.getInfo(id, { client: 'IOS' }) —— WEB/ANDROID 客户端给不出可解密的格式，
//     IOS 客户端可以，实测能拿到 *.googlevideo.com 的直链
//   - 歌词：yt.music.getLyrics(id)
//
// 账号部分（歌单、喜欢、专辑、歌手、探索页、电台）在 ytmBrowse.ts：登录会话由 ytmLogin.ts
// 存在 localStorage 里，请求带上 Cookie 与 SAPISIDHASH 授权头（见 ytmHttp.ts），直接打
// music.youtube.com 的 InnerTube（browse / next / like / browse/edit_playlist）。

type YtmParams = Record<string, string | undefined>;

import { clearYtmSession, hasYtmSessionCookie, openYtmLogin, readYtmCookie } from './ytmLogin';
import { ytmFetch, ytmLastSearchAnswer, innertubeContext, ensureVisitorData, YTM_CLIENT_NAME, YTM_CLIENT_VERSION } from './ytmHttp';
import { isYtmBrowseOperation, readYtmAccount, runYtmBrowseOperation } from './ytmBrowse';
import { noteYtmAudioProblem } from '../services/onlineMusic/ytm/ytmAudioProblem';

// 与 services/onlineMusic/ytm/ytmTransport 的 wire 形状一致。
type WireSong = {
    id: string;
    name: string;
    artists: Array<{ id: string; name: string }>;
    album: { id: string; name: string; coverUrl: string };
    durationMs: number;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InnertubeClient = any;

/**
 * 直连 YouTube 的 InnerTube 搜索（不经过 youtubei.js）。
 *
 * 为什么要有这一条：youtubei 要先建会话、拿 visitor data、按自己的客户端类型发请求，任何一环在
 * WebView 里不成立都会变成"0 条结果"。这条请求体是死的、只用 WEB_REMIX 的最小上下文，
 * 在本机用 curl 原样重放过：HTTP 200、musicShelfRenderer 在场、20 条歌曲。
 */
const INNERTUBE_SEARCH_URL = 'https://www.youtube.com/youtubei/v1/search?prettyPrint=false&alt=json';
const INNERTUBE_PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false&alt=json';
const INNERTUBE_SIGNATURE_TIMESTAMP = 20745;

/*
 * 换客户端是绕开「WEB_REMIX 被判 bot」的唯一手段：同一个 IP、同一首歌，
 * 不同 client 的风控档位不一样。IOS / ANDROID_VR / TVHTML5 下发的常常是直链，
 * 不需要 poToken；WEB_REMIX 才要求 pot，而且现在干脆不认。
 */
type PlayerProfile = 'web' | 'visionos' | 'ios' | 'androidVr' | 'androidTestsuite' | 'tv';
// AirBeats 的首选客户端就是 VISIONOS（clientId 101）：它下发的是**直链**，不带 cipher、不要 pot，
// 是被风控的 IP 上最常能直接播的那个。版本号与 UA 照它的 YouTubeClient.kt 抄。
const VISIONOS_VERSION = '0.1';
const VISIONOS_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const ANDROID_TESTSUITE_VERSION = '1.9';
const ANDROID_TESTSUITE_UA = `com.google.android.youtube/1.9 (Linux; U; Android 15; en_US; Pixel 9 Pro; Build/AP4A.250205.002) gzip`;
const IOS_CLIENT_VERSION = '20.10.4';
const ANDROID_VR_VERSION = '1.60.19';
const ANDROID_VR_UA = `com.google.android.apps.youtube.vr.oculus/${ANDROID_VR_VERSION} (Linux; U; Android 12; en_US; Quest 3 Build/SQ3A.220605.009.A1) gzip`;
const TV_CLIENT_VERSION = '7.20250219.16.00';
const TV_UA = 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.lts.1.0-qa (unlike Gecko) Starboard/13';

const PLAYER_CLIENTS: Record<PlayerProfile, (visitor: string) => {
    name: string; version: string; userAgent?: string;
    context: Record<string, unknown>;
}> = {
    web: visitor => ({
        name: YTM_CLIENT_NAME,
        version: YTM_CLIENT_VERSION,
        context: { ...innertubeContext().client, ...(visitor ? { visitorData: visitor } : {}) },
    }),
    visionos: visitor => ({
        name: '101',
        version: VISIONOS_VERSION,
        userAgent: VISIONOS_UA,
        context: {
            hl: 'zh-CN', gl: 'US', clientName: 'VISIONOS', clientVersion: VISIONOS_VERSION,
            osName: 'visionOS', osVersion: '1.3.21O771',
            deviceMake: 'Apple', deviceModel: 'RealityDevice14,1', userAgent: VISIONOS_UA,
            ...(visitor ? { visitorData: visitor } : {}),
        },
    }),
    androidTestsuite: visitor => ({
        name: '30',
        version: ANDROID_TESTSUITE_VERSION,
        userAgent: ANDROID_TESTSUITE_UA,
        context: {
            hl: 'zh-CN', gl: 'US', clientName: 'ANDROID_TESTSUITE', clientVersion: ANDROID_TESTSUITE_VERSION,
            osName: 'Android', osVersion: '15', deviceMake: 'Google', deviceModel: 'Pixel 9 Pro',
            androidSdkVersion: 35, userAgent: ANDROID_TESTSUITE_UA,
            ...(visitor ? { visitorData: visitor } : {}),
        },
    }),
    ios: visitor => {
        const userAgent = `com.google.ios.youtube/${IOS_CLIENT_VERSION} (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)`;
        return {
            name: '5',
            version: IOS_CLIENT_VERSION,
            userAgent,
            context: {
                hl: 'zh-CN', gl: 'US', clientName: 'IOS', clientVersion: IOS_CLIENT_VERSION,
                deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone',
                osVersion: '18.3.2.22D82', userAgent,
                ...(visitor ? { visitorData: visitor } : {}),
            },
        };
    },
    androidVr: visitor => ({
        name: '28',
        version: ANDROID_VR_VERSION,
        userAgent: ANDROID_VR_UA,
        context: {
            hl: 'zh-CN', gl: 'US', clientName: 'ANDROID_VR', clientVersion: ANDROID_VR_VERSION,
            deviceMake: 'Oculus', deviceModel: 'Quest 3', osName: 'Android', osVersion: '12',
            androidSdkVersion: 32, userAgent: ANDROID_VR_UA,
            ...(visitor ? { visitorData: visitor } : {}),
        },
    }),
    tv: visitor => ({
        name: '7',
        version: TV_CLIENT_VERSION,
        userAgent: TV_UA,
        context: {
            hl: 'zh-CN', gl: 'US', clientName: 'TVHTML5', clientVersion: TV_CLIENT_VERSION,
            osName: 'Tizen', osVersion: '7.0', platform: 'TV', userAgent: TV_UA,
            ...(visitor ? { visitorData: visitor } : {}),
        },
    }),
};
const INNERTUBE_CLIENT_VERSION = '1.20250219.01.00';
/** 「只搜歌曲」的 params（youtubei 里同样是这个常量）。 */
const INNERTUBE_SONGS_PARAMS = 'EgWKAQIIAQ%3D%3D';

const innerTubeContext = () => ({
    client: {
        hl: 'zh-CN',
        gl: 'US',
        clientName: 'WEB_REMIX',
        clientVersion: INNERTUBE_CLIENT_VERSION,
        osName: 'Android',
        osVersion: '16',
        userAgent: typeof navigator !== 'undefined' && navigator.userAgent
            ? navigator.userAgent
            : 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runsText = (runs: any): string => (
    Array.isArray(runs) ? runs.map((run: { text?: string }) => String(run?.text ?? '')).join('') : ''
);

const parseDurationMs = (text: string): number => {
    const parts = String(text || '').trim().split(':').map(part => Number(part));
    if (parts.length < 2 || parts.some(part => !Number.isFinite(part))) return 0;
    return Math.max(0, Math.round(parts.reduce((total, part) => total * 60 + part, 0) * 1000));
};

type InnerTubeShelf = { items: WireSong[]; continuation?: string };

const parseInnerTubeShelf = (json: unknown): InnerTubeShelf => {
    const items: WireSong[] = [];
    let continuation = '';
    const seen = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (node: any): void => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
            node.forEach(walk);
            return;
        }
        const row = node.musicResponsiveListItemRenderer;
        if (row) {
            const columns = Array.isArray(row.flexColumns) ? row.flexColumns : [];
            const title = runsText(columns[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs);
            const subtitle = runsText(columns[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs);
            const videoId = String(
                row.overlay?.playButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId
                ?? row.playlistItemData?.videoId
                ?? '',
            );
            const thumbs = row.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ?? [];
            const coverUrl = Array.isArray(thumbs) && thumbs.length > 0 ? String(thumbs[thumbs.length - 1]?.url ?? '') : '';
            // "周杰倫 • 葉惠美 • 4:30"：最后一段是时长，前面依次是歌手与专辑。
            const parts = subtitle.split('•').map(part => part.trim()).filter(Boolean);
            const last = parts[parts.length - 1] ?? '';
            const hasDuration = /^\d+(?::\d{1,2})+$/.test(last);
            const durationText = hasDuration ? last : '';
            const meta = hasDuration ? parts.slice(0, -1) : parts;
            const artistText = meta[0] ?? '';
            const albumText = meta[1] ?? '';
            if (videoId && title && !seen.has(videoId)) {
                seen.add(videoId);
                items.push({
                    id: videoId,
                    name: title,
                    artists: artistText
                        ? artistText.split(/[、,&/]/).map(name => ({ id: '', name: name.trim() })).filter(artist => artist.name)
                        : [],
                    album: { id: '', name: albumText, coverUrl },
                    durationMs: parseDurationMs(durationText),
                });
            }
            return;
        }
        const token = node.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
        if (typeof token === 'string' && token && !continuation) continuation = token;
        for (const key of Object.keys(node)) walk(node[key]);
    };
    walk(json);
    return { items, ...(continuation ? { continuation } : {}) };
};

/**
 * 直连 YouTube 的 InnerTube 取播放地址（不经过 youtubei.js）。
 *
 * 用 IOS 客户端：它的回应里音频格式带的是**直链**（itag 139/140，没有 signatureCipher，
 * 也没有需要解释的 n 参数），所以既不用下载 player JS、也不用解释签名 —— 这两步正是
 * WebView 里最容易失败的地方。这条请求在本机用 curl 原样重放过：HTTP 200、playability OK、
 * 两条音频格式都带 url。
 */
/**
 * WEB_REMIX（YTMUSIC）客户端签出来的音频地址，配浏览器 UA。
 * 取地址这条路已经换成 youtubei.js 的 YTMUSIC 客户端（见 resolveAudioViaInnerTube），
 * 它走的是网页播放器那一套，所以下载时也用 WebView 自己的 Chrome UA，别再带 iOS 客户端的 UA。
 */
const INNERTUBE_WEB_UA = (): string => (
    typeof navigator !== 'undefined' && navigator.userAgent
        ? navigator.userAgent
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
);
/** IOS 客户端要求的播放签名时间戳；过期了也不要紧——那时会退回到 youtubei 那条链。 */

type InnerTubeAudio = { url: string; itag?: number; bitrate?: number };

/**
 * 把音频整段取回来，交一个 blob: 地址给播放器。
 *
 * 为什么不全交给 <audio> 直连：googlevideo 的地址带 Range 才回 206（不带直接 403），
 * 而 WebView 的媒体栈在这台机器上对它报 MEDIA_ERR_SRC_NOT_SUPPORTED。原生桥（OkHttp）
 * 走的是和 curl 同一条网络，把字节取回来再播，就绕开了 WebView 那一层。
 * 代价是点歌后要先下完（4 分钟的歌约 4 MB），换的是"能放"。
 */
const MAX_BLOB_BYTES = 16 * 1024 * 1024;

const fetchAudioBlobUrl = async (url: string): Promise<string | null> => {
    const { isNativeBridgeAvailable, bridgeRequest } = await import('./core');
    const toBlobUrl = (bytes: Uint8Array, type: string): string => URL.createObjectURL(new Blob([bytes], { type }));
    const CHUNK_BYTES = 1024 * 1024;
    try {
        if (isNativeBridgeAvailable()) {
            // 分片取：一次 4 MB 的 base64 过桥容易失败，取 1 MB 一片，取到短于一片为止。
            const parts: Uint8Array[] = [];
            let offset = 0;
            let contentType = 'audio/mp4';
            let first = true;
            for (let round = 0; round < 20; round += 1) {
                const end = offset + CHUNK_BYTES - 1;
                const answer = await bridgeRequest({
                    url,
                    method: 'GET',
                    headers: {
                        Range: `bytes=${offset}-${end}`,
                        'User-Agent': INNERTUBE_WEB_UA(),
                        Accept: '*/*',
                    },
                    binary: true,
                    followRedirects: true,
                    timeoutMs: 60_000,
                });
                const headerType = Object.entries(answer.headers ?? {})
                    .find(([key]) => key.toLowerCase() === 'content-type')?.[1];
                if (typeof headerType === 'string' && headerType) contentType = headerType.split(';')[0]!.trim() || contentType;
                if (answer.status >= 400 || !answer.bodyBase64) {
                    const host = (() => { try { return new URL(url).host; } catch { return 'invalid'; } })();
                    console.warn('[YTM][audio] blob chunk failed', { round, status: answer.status, offset, host });
                    if (answer.status === 403) {
                        // googlevideo 的地址是按「取地址那一刻的出口 IP」签发的（ip 在 sparams 里，
                        // 删掉就签名失效）。下载走的是另一个出口时，除开头被 CDN 缓存的一小段，
                        // 其余一律 403 —— 这就是"只有第一片能拿、后面全被拒"的由来。
                        let mintedIp = '';
                        try { mintedIp = new URL(url).searchParams.get('ip') ?? ''; } catch { /* 忽略 */ }
                        const error = new Error(
                            `下载音频被 googlevideo 拒绝（403，第 ${round + 1} 片，偏移 ${offset} 字节）。`
                            + `这条地址签给出口 IP ${mintedIp || '（未取到）'}；`
                            + '请让代理把 youtube.com 与 googlevideo.com 指到同一个节点（或切全局模式，关掉自动选择/负载均衡）。'
                        );
                        (error as Error & { ytmBlocked?: boolean }).ytmBlocked = true;
                        throw error;
                    }
                    return null;
                }
                const binary = atob(answer.bodyBase64);
                if (binary.length === 0) break;
                const bytes = new Uint8Array(binary.length);
                for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
                if (first) {
                    first = false;
                    // MP4 的第 5–8 字节是 'ftyp'：不是的话拿回来的不是音频（多半是错误页）。
                    const head = String.fromCharCode(bytes[4] ?? 0, bytes[5] ?? 0, bytes[6] ?? 0, bytes[7] ?? 0);
                    console.info('[YTM][audio] first chunk', { bytes: bytes.length, head, contentType, status: answer.status });
                    if (head !== 'ftyp') return null;
                }
                parts.push(bytes);
                offset += bytes.length;
                if (offset > MAX_BLOB_BYTES) {
                    console.warn('[YTM][audio] audio too large', { offset });
                    return null;
                }
                if (bytes.length < CHUNK_BYTES) break;
            }
            if (parts.length === 0) return null;
            const merged = new Uint8Array(offset);
            let cursor = 0;
            for (const part of parts) {
                merged.set(part, cursor);
                cursor += part.length;
            }
            console.info('[YTM][audio] blob ready', { bytes: merged.length, contentType });
            return toBlobUrl(merged, contentType);
        }
        const response = await fetch(url, { headers: { Range: 'bytes=0-', 'User-Agent': INNERTUBE_WEB_UA() } });
        console.info('[YTM][audio] web fetch', response.status);
        if (!response.ok) return null;
        const buffer = new Uint8Array(await response.arrayBuffer());
        if (buffer.byteLength === 0 || buffer.byteLength > MAX_BLOB_BYTES) return null;
        return toBlobUrl(buffer, response.headers.get('content-type') || 'audio/mp4');
    } catch (error) {
        console.warn('[YTM][audio] blob failed:', error instanceof Error ? error.message : String(error));
        return null;
    }
};

/**
 * 把整首交给原生：它用**一条连接**把音频下到磁盘，再经 127.0.0.1 的本地服务按 Range 喂给 <audio>。
 *
 * 为什么非要绕到原生：googlevideo 的直链按「取地址那一刻的出口 IP」签发，WebView/桥这边分片去取时
 * 代理会在连接之间换节点，第一片命中缓存能过，第二片起一律 403（日志里那句"签给出口 IP x.x.x.x"）。
 * 单条连接整段下来就没有换节点的空子；下完以后本地文件可随机读，拖进度条也不用再走网络。
 * 返回空串表示这个构建没有这个原生方法（桌面/浏览器里预览时），调用方退回 blob 那条老路。
 */
const registerNativeAudioStream = async (url: string, headers: Record<string, string>): Promise<string> => {
    const capacitor = (window as unknown as {
        Capacitor?: {
            isNativePlatform?: () => boolean;
            Plugins?: {
                FoliaNative?: {
                    registerDownloadedAudio?: (options: { url: string; headers: Record<string, string> }) => Promise<{ url?: string }>;
                };
            };
        };
    }).Capacitor;
    if (!capacitor?.isNativePlatform?.()) return '';
    const plugin = capacitor.Plugins?.FoliaNative;
    if (!plugin?.registerDownloadedAudio) return '';
    const answer = await plugin.registerDownloadedAudio({ url, headers });
    return String(answer?.url ?? '');
};

/**
 * 取一次地址 + 下一次整首，失败（多半是出口 IP 对不上）就重新取地址再来。
 * 重新取地址会让 YouTube 按新的出口 IP 重新签发，命中同一个节点的概率比死磕旧地址高得多。
 */
const resolveAudioStreamViaNative = async (id: string): Promise<{
    url: string; route: string; itag?: number; bitrate?: number;
}> => {
    let lastError: unknown = null;
    /*
     * 下音频的请求头必须和**签这条地址的客户端**一致。
     * AirBeats 的 validateStatus 就是按 URL 里的 c=<client> 取对应 UA 再探测的；
     * 用 WEB 的 UA 去拉 VISIONOS / IOS 签的地址，googlevideo 会当成串用而 403。
     */
    const download = async (url: string, profile: PlayerProfile): Promise<string> => registerNativeAudioStream(url, {
        'User-Agent': PLAYER_CLIENTS[profile]('').userAgent ?? INNERTUBE_WEB_UA(),
        Origin: 'https://music.youtube.com',
        Referer: 'https://music.youtube.com/',
    });
    const potOf = (url: string): string => { try { return String(new URL(url).searchParams.get('pot') ?? ''); } catch { return ''; } };
    /*
     * 每个候选 = 一个客户端（+ 可选的 poToken）。风控是**按客户端**判的：
     * WEB_REMIX 现在必被拦，IOS/ANDROID_VR/TVHTML5 常常直接给直链。
     * 轮一遍，第一个能整首下下来的就结束，后面的不再试。
     */
    const candidates: Array<{ profile: PlayerProfile; pot: () => Promise<string>; label: string }> = [
        { profile: 'visionos', pot: async () => '', label: 'visionos' },
        { profile: 'ios', pot: async () => '', label: 'ios' },
        { profile: 'androidTestsuite', pot: async () => '', label: 'android-testsuite' },
        { profile: 'androidVr', pot: async () => '', label: 'android-vr' },
        { profile: 'tv', pot: async () => '', label: 'tv' },
        { profile: 'web', pot: async () => '', label: 'web' },
    ];
    for (const candidate of candidates) {
        let pot = '';
        try {
            pot = await candidate.pot();
        } catch (error) {
            console.warn(`[YTM][audio] ${candidate.label} 铸 token 失败：`, error instanceof Error ? error.message : String(error));
        }
        let direct: InnerTubeAudio;
        try {
            direct = await resolveAudioViaInnerTube(id, pot, candidate.profile);
        } catch (error) {
            console.warn(`[YTM][audio] ${candidate.label} 取址失败：`, error instanceof Error ? error.message : String(error));
            lastError = error;
            continue;
        }
        console.info('[YTM][audio] player answer', {
            id,
            route: candidate.label,
            itag: direct.itag,
            cipherSigned: !!direct.url,
            signedPot: potOf(direct.url).length,
            sentPot: pot.length,
        });
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            try {
                const local = await download(direct.url, candidate.profile);
                if (!local) return { url: '', route: '' };
                return {
                    url: local,
                    route: 'native-stream',
                    ...(direct.itag === undefined ? {} : { itag: direct.itag }),
                    ...(direct.bitrate === undefined ? {} : { bitrate: direct.bitrate }),
                };
            } catch (error) {
                lastError = error;
                console.warn(`[YTM][audio] download attempt ${attempt} failed:`, error instanceof Error ? error.message : String(error));
                if (attempt === 2) break;
                // 出口 IP 每次连接都可能换，重取一次地址再试。
                direct = await resolveAudioViaInnerTube(id, pot, candidate.profile);
            }
        }
    }
    throw lastError instanceof Error ? lastError : new Error('音频下载失败');
};

/*
 * 同一首歌会被界面重复请求（加载/重试/预取各来一次），日志里一首歌能出现 4 次取址，
 * 每次 3~4 秒，串起来就是「点了歌要等十秒」。这里做单飞 + 短期缓存：
 * 并发只跑一次，成功后 10 分钟内直接复用本地地址。
 */
type NativeStream = { url: string; route: string; itag?: number; bitrate?: number };
const nativeStreamCache = new Map<string, { at: number; value: NativeStream }>();
const nativeStreamInflight = new Map<string, Promise<NativeStream>>();
const NATIVE_STREAM_TTL_MS = 10 * 60 * 1000;

const resolveAudioStreamCached = async (id: string): Promise<NativeStream> => {
    const hit = nativeStreamCache.get(id);
    if (hit && Date.now() - hit.at < NATIVE_STREAM_TTL_MS) return hit.value;
    const running = nativeStreamInflight.get(id);
    if (running) return running;
    const job = resolveAudioStreamViaNative(id)
        .then(value => {
            nativeStreamCache.set(id, { at: Date.now(), value });
            return value;
        })
        .finally(() => nativeStreamInflight.delete(id));
    nativeStreamInflight.set(id, job);
    return job;
};

/**
 * 取一次地址：WEB_REMIX 客户端 + po_token + 解签（桌面版 planAs 同款路子）。
 *
 * 为什么是手搓请求而不是 youtubei.js 的 getBasicInfo：
 * - youtubei.js 的 YTMUSIC 客户端把 context.client.clientName 写成字符串 "YTMUSIC"，
 *   InnerTube 只认 "WEB_REMIX"/数字 67，一律回 400 "Invalid value ... client_name"（实测）；
 * - 它的 Web.js 又不支持 po_token（只有 Music/Kids 有）。
 * 而这里用的 innerTubeContext() 是搜索那条已经能用的 WEB_REMIX 配置。
 *
 * WEB_REMIX 不带 po_token 时只给 signatureCipher（SABR），带上了才给直链；
 * 给了 cipher 就按 player 脚本解签，这一步桌面版同样要做。
 */
const resolveAudioViaInnerTube = async (videoId: string, poToken = '', profile: PlayerProfile = 'web'): Promise<InnerTubeAudio> => {
    const signatureTimestamp = await currentSignatureTimestamp();
    const visitor = await ensureVisitorData();
    const client = PLAYER_CLIENTS[profile](visitor);
    const body = {
        videoId,
        racyCheckOk: true,
        contentCheckOk: true,
        ...(poToken ? { serviceIntegrityDimensions: { poToken } } : {}),
        playbackContext: {
            contentPlaybackContext: { vis: 0, splay: false, lactMilliseconds: '-1', signatureTimestamp },
        },
        context: { client: client.context },
    };
    const response = await ytmFetch(INNERTUBE_PLAYER_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-YouTube-Client-Name': client.name,
            'X-YouTube-Client-Version': client.version,
            ...(client.userAgent ? { 'User-Agent': client.userAgent } : {}),
            ...(visitor ? { 'X-Goog-Visitor-Id': visitor } : {}),
        },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        throw new Error(`YouTube 取播放地址失败：HTTP ${response.status}`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await response.json();
    const status = json?.playability_status ?? json?.playabilityStatus;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const formats: any[] = [
        ...(json?.streamingData?.adaptiveFormats ?? json?.streaming_data?.adaptive_formats ?? []),
        ...(json?.streamingData?.formats ?? json?.streaming_data?.formats ?? []),
    ];
    // 直链优先于 cipher（AirBeats 的 preferHigher 就是先比 `url != null`）：
    // cipher 要解签、还容易缺 pot，同一首歌只要有直链格式就先拿直链。
    const audio = formats
        .filter(format => String(format?.mimeType ?? format?.mime_type ?? '').startsWith('audio'))
        .sort((a, b) => {
            const directA = typeof a?.url === 'string' && a.url ? 1 : 0;
            const directB = typeof b?.url === 'string' && b.url ? 1 : 0;
            return directB - directA || Number(b?.bitrate ?? 0) - Number(a?.bitrate ?? 0);
        })[0];
    if (!audio) {
        const word = status?.status ? `（playability: ${String(status.status)}${status.reason ? ` / ${String(status.reason).slice(0, 60)}` : ''}）` : '';
        throw new Error(`YouTube 没有给这条音频地址${word}`);
    }
    /*
     * 取到的地址必须过一遍 player 脚本里的解签，**哪怕它本身就是一条直链**。
     *
     * 直链里带的 `n` 参数是没解过的（YouTube 从不在服务端代解）；不解它，googlevideo
     * 只会发开头约 1 MB（命中 CDN 缓存的那一段），从第二段 Range 起一律 403。
     * 表现就是「能读出时长、点播放第一个字节有声、随即静音报 Format error」。
     * decipher 同时处理 signatureCipher 的 sig 和直链里的 n，所以两条路都走它。
     */
    let url = typeof audio.url === 'string' ? audio.url : '';
    const cipherText = String(audio.signatureCipher ?? audio.signature_cipher ?? audio.cipher ?? '');
    // cipher 里的 url 参数是解签前的原始地址，比较它和结果的 n 才能看出变换到底跑没跑。
    const rawUrl = url || (() => { try { return new URLSearchParams(cipherText).get('url') ?? ''; } catch { return ''; } })();
    const nOf = (value: string): string => { try { return String(new URL(value).searchParams.get('n') ?? ''); } catch { return ''; } };
    const rawN = nOf(rawUrl);
    try {
        await installYoutubeJsEvaluator();
        const player = (await getClient()).session?.player;
        if (!player) throw new Error('player 脚本还没就绪，解不了签名');
        const cipherSig = (() => { try { return String(new URLSearchParams(cipherText).get('s') ?? ''); } catch { return ''; } })();
        url = String(await player.decipher(
            typeof audio.url === 'string' ? audio.url : '',
            cipherText,
            String(audio.cipher ?? ''),
        )) || url;
        const signed = new URL(url);
        const sparams = signed.searchParams;
        console.info('[YTM][audio] n-sig', {
            hasPlayerData: !!player.data,
            cipher: !audio.url,
            sigLen: cipherSig.length,
            rawLen: rawN.length,
            signedLen: String(sparams.get('n') ?? '').length,
            sameN: rawN === String(sparams.get('n') ?? ''),
            sabr: sparams.get('sabr'),
            sparams: sparams.get('sparams'),
            potLen: String(sparams.get('pot') ?? '').length,
            visitorLen: visitor.length,
            host: signed.host,
            sts: player.signature_timestamp,
        });
    } catch (error) {
        // 解签失败时退回原始直链（只能播出开头一段，但总比整条放不出来好）。
        if (!url) throw error;
        console.warn('[YTM][audio] n 解签失败，退回原始直链：', error instanceof Error ? error.message : String(error));
    }
    if (!url) throw new Error('YouTube 没有给这条音频地址');
    /*
     * 不要手动往地址上补 pot。
     * googlevideo 只认 YouTube 自己签进 URL 并把名字写进 sparams 的那个 pot；
     * 手动 set 的未签名 pot 不在 sparams 里，反而会让整条地址被拒。
     */
    return {
        url,
        ...(audio.itag === undefined ? {} : { itag: Number(audio.itag) }),
        ...(audio.bitrate === undefined ? {} : { bitrate: Number(audio.bitrate) }),
    };
};

const searchViaInnerTube = async (query: string, continuation?: string): Promise<InnerTubeShelf> => {
    const body: Record<string, unknown> = continuation
        ? { context: innerTubeContext(), continuation }
        : { context: innerTubeContext(), query, params: INNERTUBE_SONGS_PARAMS };
    const response = await ytmFetch(INNERTUBE_SEARCH_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-YouTube-Client-Name': '67',
            'X-YouTube-Client-Version': INNERTUBE_CLIENT_VERSION,
        },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        throw new Error(`YouTube 搜索请求失败：HTTP ${response.status}`);
    }
    return parseInnerTubeShelf(await response.json());
};

/**
 * youtubei.js 在浏览器里解签必须自备 JS 求值器（Node/Electron 用它自带的 vm）。
 * 不装它，player.decipher 一律抛
 * "To decipher URLs, you must provide your own JavaScript evaluator"（v4 的日志就是这个）。
 *
 * data.output 是 player 脚本后面接一段 process(...) 调用（见 youtubei.js 的 getNsigProcessorFn），
 * 末尾就是 `return { sig, n }`，所以 new Function 整段跑一遍即可。
 * 实测：178KB 的 player 脚本解析 5ms、执行 4ms，WebView 里毫无压力。
 */
let youtubeJsEvaluatorInstalled = false;
const installYoutubeJsEvaluator = async (): Promise<void> => {
    if (youtubeJsEvaluatorInstalled) return;
    const mod = await import('./vendor/youtubei.browser.js');
    const Platform = (mod as any).Platform;
    if (!Platform?.shim) return;
    Platform.shim.eval = async (data: { output?: string }) => {
        const source = String(data?.output ?? '');
        if (!source) throw new Error('player script is empty');
        const run = new Function(source) as () => { sig?: string; n?: string };
        return run();
    };
    youtubeJsEvaluatorInstalled = true;
};

let clientPromise: Promise<InnertubeClient> | null = null;

const createClient = async (): Promise<InnertubeClient> => {
    const mod = await import('./vendor/youtubei.browser.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Innertube = (mod as any).Innertube;
    if (typeof Innertube?.create !== 'function') {
        throw new Error('youtubei.js bundle did not expose Innertube');
    }
    return await Innertube.create({ generate_session_locally: true, fetch: ytmFetch });
};

let musicClientPromise: Promise<InnertubeClient> | null = null;

/** 备用客户端：客户端类型声明成 YTMUSIC。WEB 客户端偶尔给一段空 shelf，这个常常还回条目。 */
const getMusicClient = (): Promise<InnertubeClient> => {
    if (!musicClientPromise) {
        musicClientPromise = (async () => {
            const mod = await import('./vendor/youtubei.browser.js');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const Innertube = (mod as any).Innertube;
            return await Innertube.create({
                generate_session_locally: true,
                client_type: 'YTMUSIC',
                fetch: ytmFetch,
            });
        })().catch(error => {
            musicClientPromise = null;
            throw error;
        });
    }
    return musicClientPromise;
};

const getClient = (): Promise<InnertubeClient> => {
    if (!clientPromise) {
        clientPromise = createClient().catch(error => {
            clientPromise = null;
            throw error;
        });
    }
    return clientPromise;
};

/**
 * sts（signatureTimestamp）会随 YouTube 换 player 脚本一起变。
 * 写成死值会让服务端判断「播放器太旧」，只肯给 signatureCipher、不给带 pot 的直链。
 * player 脚本解析出来的才是当前值；拿不到才退回常量。
 */
const currentSignatureTimestamp = async (): Promise<number> => {
    try {
        await installYoutubeJsEvaluator();
        const player = (await getClient()).session?.player;
        const sts = Number(player?.signature_timestamp ?? 0);
        if (sts > 0) return sts;
    } catch (error) {
        console.warn('[YTM][audio] sts 读取失败：', error instanceof Error ? error.message : String(error));
    }
    return INNERTUBE_SIGNATURE_TIMESTAMP;
};

const textOf = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string') {
        return String((value as { text: string }).text);
    }
    return '';
};

const coverOf = (item: { id?: string; thumbnails?: Array<{ url?: string }> }): string => {
    const thumbs = Array.isArray(item?.thumbnails) ? item.thumbnails : [];
    const last = thumbs.length > 0 ? String(thumbs[thumbs.length - 1]?.url ?? '') : '';
    return last || (item?.id ? `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg` : '');
};

/** "4:30" / "1:02:03" → 毫秒；拿不到就是 0。普通搜索（视频）只给文本时长。 */
const parseDurationText = (text: string): number => {
    const parts = String(text || '').split(':').map(part => Number(part));
    if (parts.length < 2 || parts.some(part => !Number.isFinite(part))) return 0;
    const seconds = parts.reduce((total, part) => total * 60 + part, 0);
    return Math.max(0, Math.round(seconds * 1000));
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toWireSong = (item: any): WireSong => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawArtists: any[] = Array.isArray(item?.artists)
        ? item.artists
        // 普通搜索的结果是"视频"：作者挂在 author 上，没有 artists 数组。
        : item?.author ? [item.author] : [];
    const durationMs = item?.duration?.seconds !== undefined
        ? Math.max(0, Number(item.duration.seconds) * 1000)
        : item?.duration_ms !== undefined
            ? Math.max(0, Number(item.duration_ms))
            : parseDurationText(textOf(item?.duration));
    return {
        id: String(item?.id ?? item?.video_id ?? ''),
        name: textOf(item?.title) || textOf(item?.name),
        artists: rawArtists
            .map((artist: { name?: string; channel_id?: string; id?: string } | string) => ({
                id: typeof artist === 'string' ? '' : String(artist?.channel_id ?? artist?.id ?? ''),
                name: typeof artist === 'string' ? artist : String(artist?.name ?? ''),
            }))
            .filter(artist => artist.name),
        album: {
            id: String(item?.album?.id ?? ''),
            name: String(item?.album?.name ?? ''),
            coverUrl: coverOf(item),
        },
        durationMs: Number.isFinite(durationMs) ? durationMs : 0,
    };
};

const levelOf = (bitrate: number): 'standard' | 'high' | 'ultra' => {
    if (bitrate >= 200_000) return 'ultra';
    if (bitrate >= 120_000) return 'high';
    return 'standard';
};

/**
 * 一个操作的实现。返回的形状与桌面版 `window.electron.ytmRequest` 的 data 一致；
 * 失败抛错，调用方（ytmTransport）会把它变成 OnlineProviderError。
 */
export const handleYtmOperation = async (operation: string, params: YtmParams = {}): Promise<unknown> => {
    // 注意：这里不预先建 youtubei 客户端。直连 InnerTube 的搜索与取址都不需要它，
    // 而它一旦建不起来（会话/配置请求失败），整条链路都会跟着失败。
    switch (operation) {
        case 'search_songs': {
            const query = String(params.query ?? '').trim();
            const continuation = params.continuation;
            if (!query && !continuation) return { items: [] };
            // 先走直连 InnerTube：请求体固定、不依赖会话，失败也容易说清楚。
            try {
                const direct = await searchViaInnerTube(query, continuation);
                if (direct.items.length > 0 || direct.continuation) return direct;
                console.info('[YTM] direct InnerTube search returned 0 items');
            } catch (error) {
                console.warn('[YTM] direct InnerTube search failed:', error instanceof Error ? error.message : String(error));
                if (!continuation) {
                    // 连不上/被拒时不再往下试：youtubei 走的是同一个网络，只会给出同样含糊的空结果。
                    throw error;
                }
            }
            const yt = await getClient();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const result: any = await yt.music.search(query, {
                type: 'song',
                ...(continuation ? { continuation } : {}),
            });
            const section = result?.songs;
            if (!section) {
                // 静默返回空列表会显示成"搜不到"，但真正的原因通常在上游回答的形状里。
                throw new Error(
                    `YouTube Music search answered without a songs section (keys: ${Object.keys(result ?? {}).join(',') || 'none'})`
                );
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const contents: any[] = Array.isArray(section?.contents) ? section.contents : [];
            const items = contents
                .filter(item => (item?.item_type ?? 'song') === 'song')
                .map(toWireSong)
                .filter(song => song.id);
            if (items.length > 0 || continuation) {
                return {
                    items,
                    ...(section?.continuation ? { continuation: String(section.continuation) } : {}),
                };
            }
            // 音乐搜索这一段空了（上游换版式、或给了一段空 shelf）：再走一次普通的站内搜索，
            // 这一段要用 youtubei，按需建客户端。
            // 把视频结果当歌曲用。总比把"有结果"显示成"未找到相关结果"强。
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const fallback: any = await (await getClient()).search(query, { type: 'video' });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const fallbackItems: any[] = Array.isArray(fallback?.videos) ? fallback.videos : [];
            const songs = fallbackItems
                .map(toWireSong)
                .filter(song => song.id);
            console.info('[YTM] music search empty, plain search returned', songs.length);
            if (songs.length === 0) {
                // 最后再问一次 YTMUSIC 客户端：同样的词，客户端类型不同，上游给的东西可能不同。
                try {
                    const musicClient = await getMusicClient();
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const retry: any = await musicClient.music.search(query, { type: 'song' });
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const retryContents: any[] = Array.isArray(retry?.songs?.contents) ? retry.songs.contents : [];
                    const retrySongs = retryContents
                        .filter(item => (item?.item_type ?? 'song') === 'song')
                        .map(toWireSong)
                        .filter(song => song.id);
                    if (retrySongs.length > 0) {
                        console.info('[YTM] YTMUSIC client returned', retrySongs.length);
                        return { items: retrySongs };
                    }
                } catch (error) {
                    console.warn('[YTM] YTMUSIC client search failed:', error instanceof Error ? error.message : String(error));
                }
                const seen = ytmLastSearchAnswer();
                const detail = seen
                    ? `HTTP ${seen.status} · ${seen.length} 字节 · ${seen.html ? '返回的是网页' : 'JSON'} · musicShelf=${seen.hasMusicShelf ? '有' : '无'}`
                    : '没有记录到搜索请求';
                throw new Error(`YouTube 搜索没有结果（${detail}）`);
            }
            return { items: songs };
        }
        case 'song_detail':
        case 'song_detail_en':
        case 'song_detail_zh': {
            const id = String(params.id ?? '').trim();
            if (!id) return null;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const info: any = await (await getClient()).music.getInfo(id);
            const basic = info?.basic_info ?? {};
            if (!basic?.title) return null;
            return {
                id,
                name: String(basic.title),
                artists: [{ id: '', name: String(basic.author ?? '') }].filter(artist => artist.name),
                album: { id: '', name: '', coverUrl: coverOf({ id, thumbnails: basic.thumbnail }) },
                durationMs: Math.max(0, Number(basic.duration ?? 0) * 1000),
            } satisfies WireSong;
        }
        case 'audio': {
            const id = String(params.id ?? '').trim();
            if (!id) throw new Error('YouTube Music song has no id');
            // 手机版优先走原生整段下载 + 本地流：分片过桥取 googlevideo 会从第二片起 403。
            let nativeFailure = '';
            try {
                const streamed = await resolveAudioStreamCached(id);
                if (streamed.url) {
                    console.info('[YTM][audio] native stream ready', { id, route: streamed.route, itag: streamed.itag });
                    return {
                        url: streamed.url,
                        route: streamed.route,
                        ...(streamed.itag === undefined ? {} : { itag: streamed.itag }),
                        ...(streamed.bitrate === undefined ? {} : { bitrate: streamed.bitrate }),
                        level: levelOf(Number(streamed.bitrate ?? 0)),
                    };
                }
            } catch (error) {
                nativeFailure = error instanceof Error ? error.message : String(error);
                console.warn('[YTM][audio] native stream failed, falling back to the bridge:', nativeFailure);
            }
            // 先直连 InnerTube 取直链：不依赖 youtubei 的会话，也不用下载 player JS。
            try {
                // 兜底这条路也改走 VISIONOS：它给直链，不用 BotGuard 铸 token（那条路已证实不被接受）。
                const direct = await resolveAudioViaInnerTube(id, '', 'visionos');
                console.info('[YTM][audio] direct url', {
                    id,
                    itag: direct.itag,
                    bitrate: direct.bitrate,
                    host: (() => { try { return new URL(direct.url).host; } catch { return 'invalid'; } })(),
                    length: direct.url.length,
                });
                // 先试着整段取回来给一个 blob：WebView 直接播 googlevideo 会失败（见上面那段说明）。
                const blobUrl = await fetchAudioBlobUrl(direct.url);
                if (!blobUrl) {
                    // 两条路都没拿到字节：九成是代理把 youtube.com 与 googlevideo.com 走了不同出口
                    // （直链是按取地址那一刻的出口 IP 签发的）。把原因交给界面，别让播放器静默失败。
                    noteYtmAudioProblem('音频直链取不到字节：地址是按取地址时的出口 IP 签发的。'
                        + '请让代理把 youtube.com 与 googlevideo.com 指到同一个节点（或切全局模式）。'
                        + (nativeFailure ? `（原生下载：${nativeFailure}）` : ''));
                }
                return {
                    url: blobUrl || direct.url,
                    route: blobUrl ? 'innertube-blob' : 'innertube-ios',
                    ...(direct.itag === undefined ? {} : { itag: direct.itag }),
                    ...(direct.bitrate === undefined ? {} : { bitrate: direct.bitrate }),
                    level: levelOf(Number(direct.bitrate ?? 0)),
                };
            } catch (error) {
                // 403 那一种是网络出口造成的，换 youtubei 也一样，直接把原因交给界面。
                if ((error as { ytmBlocked?: unknown } | null)?.ytmBlocked === true) {
                    noteYtmAudioProblem(error instanceof Error ? error.message : String(error));
                    throw error;
                }
                console.warn('[YTM] direct player failed:', error instanceof Error ? error.message : String(error));
            }
            // IOS 客户端是这里最先能给出直链的：WEB / ANDROID 的回答里常常没有可解密的格式。
            const yt = await getClient();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const info: any = await yt.getInfo(id, { client: 'IOS' })
                // 换客户端再试一次：某次 YouTube 只给其中一个客户端发地址。
                .catch(async () => await yt.getInfo(id, { client: 'ANDROID' }));
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const formats: any[] = [
                ...(info?.streaming_data?.adaptive_formats ?? []),
                ...(info?.streaming_data?.formats ?? []),
            ];
            const audio = formats
                .filter(format => format?.has_audio && !format?.has_video)
                .sort((a, b) => Number(b?.bitrate ?? 0) - Number(a?.bitrate ?? 0))[0];
            if (!audio) {
                // 换 youtubei 自己的取址助手再要一次（它会自己挑格式、必要时解释签名）。
                try {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const stream: any = await yt.getStreamingData(id, { type: 'audio', quality: 'best' });
                    if (stream?.url) {
                        return {
                            url: String(stream.url),
                            route: 'streaming-data',
                            ...(stream.itag === undefined ? {} : { itag: Number(stream.itag) }),
                            ...(stream.bitrate === undefined ? {} : { bitrate: Number(stream.bitrate) }),
                            level: levelOf(Number(stream.bitrate ?? 0)),
                        };
                    }
                } catch (error) {
                    console.warn('[YTM] getStreamingData failed:', error instanceof Error ? error.message : String(error));
                }
                const status = info?.playability_status;
                throw new Error(
                    `YouTube Music offered no audio format for this track`
                    + (status ? `（playability: ${String(status.status)}${status.reason ? ` / ${String(status.reason).slice(0, 60)}` : ''}）` : '')
                );
            }
            // IOS 客户端的音频格式带的是**直链**（实测 itag 140 有 url、没有 signatureCipher、也没有需要
            // 变换的 n 参数）。以前一律走 decipher，那要先下载 player JS 再解释，WebView 里最容易在这一步失败。
            let url = typeof audio.url === 'string' ? audio.url : '';
            if (!url) {
                url = String(await audio.decipher(yt.session.player));
            }
            return {
                url,
                route: 'ios',
                ...(audio.itag === undefined ? {} : { itag: Number(audio.itag) }),
                ...(audio.bitrate === undefined ? {} : { bitrate: Number(audio.bitrate) }),
                level: levelOf(Number(audio.bitrate ?? 0)),
            };
        }
        case 'lyrics': {
            const id = String(params.id ?? '').trim();
            if (!id) return null;
            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const lyrics: any = await (await getClient()).music.getLyrics(id);
                const body = textOf(lyrics?.description) || String(lyrics?.description?.text ?? '');
                return body ? { mainText: body } : null;
            } catch {
                return null;
            }
        }
        case 'login_status': {
            const cookie = await readYtmCookie();
            if (!hasYtmSessionCookie(cookie)) return null;
            // 读真实的账号名与头像（换了账号一切都不一样，界面得看得出是哪个账号）。
            return await readYtmAccount().catch(error => {
                console.warn('[YTM] account info could not be read:', error instanceof Error ? error.message : String(error));
                // 读不到也不影响播放/歌单：给一个能显示的名字。
                return { id: 'ytm-account', nickname: 'YouTube Music', avatarUrl: '' };
            });
        }
        case 'web_login_start': {
            const cookie = await openYtmLogin();
            if (hasYtmSessionCookie(cookie)) return {};
            throw Object.assign(new Error('登录窗口关掉了，没有拿到会话'), { ytmCode: 'exited' });
        }
        case 'web_login_open':
        case 'web_login_cancel':
            return {};
        case 'web_login_check': {
            const cookie = await readYtmCookie();
            if (!hasYtmSessionCookie(cookie)) return { state: 'waiting' };
            const account = await readYtmAccount()
                .catch(() => ({ id: 'ytm-account', nickname: 'YouTube Music', avatarUrl: '' }));
            return { state: 'confirmed', account };
        }
        case 'logout':
            await clearYtmSession();
            return {};
        default: {
            // 歌单、喜欢、专辑、歌手、探索页、电台（mix）与收藏：InnerTube 的 browse/next
            // 直连，解析见 ytmBrowse.ts。
            if (isYtmBrowseOperation(operation)) {
                return runYtmBrowseOperation(operation, params);
            }
            // 其余（手机版没实现的其它写入）明确回一个带标记的错，传输层据此给界面一个
            // "暂不支持"的说法，而不是误报成网络故障。
            const error = new Error(`YouTube Music operation is not available on this build: ${operation}`);
            (error as Error & { ytmCode?: string }).ytmCode = 'unsupported';
            throw error;
        }
    }
};
