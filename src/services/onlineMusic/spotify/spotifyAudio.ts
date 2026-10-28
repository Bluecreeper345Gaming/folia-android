import { bridgeRequest, isNativeBridgeAvailable } from '../../../audioNative/core';
import { OnlineProviderError } from '../../../types/onlineMusic';

// src/services/onlineMusic/spotify/spotifyAudio.ts
// 手机版的播放：桌面版靠原生模块 node-librespot 连上 Spotify，问它"这首歌的文件在哪、用什么钥匙开"
// （electron/spotify/audio.cjs），网页里没有那个模块，所以这里自己走一遍：
//   metadata/4/track → 文件 id 与格式；storage-resolve → CDN 地址；playplay → AES 钥匙。
//
// 关于钥匙：librespot 的钥匙不是走 HTTPS 拿的，是走 Spotify 私有的 AP 连接收的 AesKey 包
// （core/src/audio_key.rs 的 PacketType::AesKey，握手要 DH + Shannon 流加密）。playplay 是一条
// 老工具用过的 HTTPS 近路，能不能用要以实测为准：这条近路走不通时，这里的日志会写明卡在 playplay，
// 那时才需要把 AP 协议搬过来（或交叉编译 librespot 成 Android 的 .so）。
// 文件按桌面版同样的方式打开：AES-128 计数器模式，计数器从 72e067fb… 起，解出来的前 0xa7 字节
// 是 Spotify 自己加的一页，丢掉，剩下的就是 Ogg Vorbis，交给 <audio>。
//
// 只有付费账号才拿得到文件：Spotify 对免费账号的 metadata 答复里 `file` 是空的（2026-10-22 实测，
// 见 docs/spotify-capture/README.md），这时报 `subscription-required`，与桌面版一致。

const METADATA_URL = 'https://spclient.wg.spotify.com/metadata/4/track/';
// librespot 的写法（core/src/spclient.rs 的 get_audio_storage）：无 v2，文件 id 用十六进制。
const STORAGE_URL = 'https://spclient.wg.spotify.com/storage-resolve/files/audio/interactive/';
const KEY_URL = 'https://spclient.wg.spotify.com/playplay/v1/key/';
// 每个 Spotify 音频文件都从这个计数器加密（桌面版 audio.cjs 的 AUDIO_IV）。
const AUDIO_IV = '72e067fbddcbcf77ebe8bc643f630d93';
// Spotify 在 Ogg 流前面放了自己的一页，播放器不读它。
const OGG_LEAD_BYTES = 0xa7;
const MAX_TRACK_BYTES = 256 * 1024 * 1024;
const REQUEST_LIMIT_MS = 30_000;
// 解开的歌留在页面里给 <audio> 读：留最近几首，太早的放掉。
const MAX_OPENED = 3;

export type SpotifyAudioQuality = 'standard' | 'high';

export interface SpotifyAudioFile {
    /** 这首歌能播的地址：一个 blob: URL，页面里解好的 Ogg。 */
    url: string;
    /** Spotify 给这份文件起的格式名，例如 "OGG_VORBIS_320"。 */
    format: string;
    /** 文件有多少字节（去掉前导那一页之后）。 */
    bytes: number;
}

/** 一次播放要用的东西，都由 spotifyAndroid.ts 给出，这个文件不碰会话。 */
export interface SpotifyAudioContext {
    /** 账号的 access token。 */
    token(): Promise<string>;
    /** 账号所在的市场，storage-resolve 要它；读不到时用 from_token。 */
    market(): Promise<string>;
    log(...args: unknown[]): void;
}

interface MetadataFile { file_id?: string; format?: string; audio_quality?: string }
interface MetadataTrack { name?: string; file?: MetadataFile[] }

const b62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** 22 位的 track id 换成 metadata 接口要的 16 字节 gid（十六进制）。 */
export const spotifyGid = (id: string): string => {
    let value = 0n;
    for (const char of id) {
        const digit = b62.indexOf(char);
        if (digit < 0) throw new OnlineProviderError('invalid-response', `Spotify id 里有不认识的字符：${char}`, 'spotify');
        value = value * 62n + BigInt(digit);
    }
    return value.toString(16).padStart(32, '0');
};

const hexBytes = (hex: string): Uint8Array => {
    if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) throw new Error(`不是十六进制：${hex.slice(0, 32)}`);
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    return bytes;
};

const base64Bytes = (text: string): Uint8Array => {
    const clean = text.replace(/[\r\n\s]/g, '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = clean + '==='.slice(0, (4 - (clean.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
};

// 文件格式按质量挑：高优先 320，标准优先 160；同一档位里 Ogg 比 MP3 稳。
const FORMAT_PREFERENCE: Record<SpotifyAudioQuality, string[]> = {
    high: ['OGG_VORBIS_320', 'MP3_320', 'OGG_VORBIS_160', 'MP3_160', 'OGG_VORBIS_96', 'MP3_96'],
    standard: ['OGG_VORBIS_160', 'MP3_160', 'OGG_VORBIS_96', 'MP3_96', 'OGG_VORBIS_320', 'MP3_320'],
};

const pickFile = (files: MetadataFile[], quality: SpotifyAudioQuality): MetadataFile | null => {
    const usable = files.filter(file => typeof file?.file_id === 'string' && file.file_id);
    for (const format of FORMAT_PREFERENCE[quality]) {
        const hit = usable.find(file => String(file.format ?? '').toUpperCase() === format);
        if (hit) return hit;
    }
    return usable[0] ?? null;
};

// 桌面版只认 Ogg 和 MP3 两种；别的格式解开也放不了。
const shapeOf = (format: string): { mimeType: string; skip: number } | null => {
    if (/^OGG_VORBIS/i.test(format)) return { mimeType: 'audio/ogg', skip: OGG_LEAD_BYTES };
    if (/^MP3/i.test(format)) return { mimeType: 'audio/mpeg', skip: 0 };
    return null;
};

const readJson = async (context: SpotifyAudioContext, url: string, what: string): Promise<unknown> => {
    const answer = await bridgeRequest({
        url, method: 'GET', timeoutMs: REQUEST_LIMIT_MS, followRedirects: true,
        headers: { Authorization: `Bearer ${await context.token()}`, Accept: 'application/json', 'app-platform': 'WebPlayer' },
    });
    if (answer.status >= 400) {
        context.log(`[Spotify] ${what} -> HTTP ${answer.status} ${String(answer.body ?? '').slice(0, 160).replace(/\s+/g, ' ')}`);
        throw new OnlineProviderError('unavailable', `Spotify 没有给出${what}（HTTP ${answer.status}）`, 'spotify');
    }
    try { return JSON.parse(String(answer.body ?? '')); } catch {
        throw new OnlineProviderError('invalid-response', `Spotify 的${what}读不懂`, 'spotify');
    }
};

/**
 * playplay 的答复是二进制的：在 librespot 里它是一个只有 `key` 一个字段的 protobuf
 * （0x0a 0x10 之后 16 字节）。这里把三种可能都试一遍，并把这个答复的形状写进日志，
 * 换账号或 Spotify 改协议时一眼能看出卡在哪一步。
 */
const readKey = async (context: SpotifyAudioContext, fileId: string): Promise<Uint8Array> => {
    const answer = await bridgeRequest({
        url: KEY_URL + fileId, method: 'GET', timeoutMs: REQUEST_LIMIT_MS, followRedirects: true, binary: true,
        headers: { Authorization: `Bearer ${await context.token()}`, 'app-platform': 'WebPlayer' },
    });
    const base64 = String(answer.bodyBase64 ?? '');
    const text = String(answer.body ?? '');
    const bytes = base64 ? base64Bytes(base64) : new Uint8Array();
    context.log(`[Spotify] playplay ${fileId.slice(0, 8)}… -> HTTP ${answer.status}, ${bytes.length || text.length} 字节, 头 ${bytes.slice(0, 4).length ? [...bytes.slice(0, 4)].map(b => b.toString(16)).join(' ') : text.slice(0, 40)}`);
    if (answer.status >= 400) {
        throw new OnlineProviderError(answer.status === 401 || answer.status === 403 ? 'subscription-required' : 'unavailable',
            `Spotify 没有给出这首歌的钥匙（HTTP ${answer.status}）`, 'spotify', `playplay ${answer.status}`);
    }
    // 1) protobuf：0x0a 0x10 + 16 字节
    if (bytes.length >= 18 && bytes[0] === 0x0a && bytes[1] === 0x10) return bytes.slice(2, 18);
    // 2) 裸的 16 字节
    if (bytes.length === 16) return bytes;
    // 3) 文本形式的 base64 / 十六进制
    const trimmed = text.trim().replace(/^"|"$/g, '');
    if (/^[0-9a-f]{32}$/i.test(trimmed)) return hexBytes(trimmed);
    if (trimmed) {
        try { const decoded = base64Bytes(trimmed); if (decoded.length === 16) return decoded; } catch { /* 继续报错 */ }
    }
    throw new OnlineProviderError('invalid-response', 'Spotify 的钥匙读不懂', 'spotify', `playplay 回包 ${bytes.length} 字节`);
};

const opened = new Map<string, { url: string; at: number }>();

const pageUrl = (id: string, quality: SpotifyAudioQuality, bytes: Uint8Array, mimeType: string): string => {
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const previous = opened.get(`${id}:${quality}`);
    if (previous) URL.revokeObjectURL(previous.url);
    opened.delete(`${id}:${quality}`);
    opened.set(`${id}:${quality}`, { url, at: Date.now() });
    while (opened.size > MAX_OPENED) {
        const [oldestKey, oldest] = opened.entries().next().value as [string, { url: string; at: number }];
        opened.delete(oldestKey);
        try { URL.revokeObjectURL(oldest.url); } catch { /* 已经放掉 */ }
    }
    return url;
};

/** 把一首歌的文件取回来、解开，交出一个页面里能直接播的地址。 */
export const openSpotifyAudio = async (
    context: SpotifyAudioContext, id: string, quality: SpotifyAudioQuality,
): Promise<SpotifyAudioFile> => {
    if (!isNativeBridgeAvailable()) throw new OnlineProviderError('network', 'Spotify 需要原生网络桥', 'spotify');
    const startedAt = Date.now();
    const gid = spotifyGid(id);

    const track = await readJson(context, `${METADATA_URL}${gid}?market=from_token`, '这首歌的元数据') as MetadataTrack;
    const files = Array.isArray(track?.file) ? track.file : [];
    if (files.length === 0) {
        // 免费账号走的就是这里：Spotify 只给付费账号发音频文件。
        throw new OnlineProviderError('subscription-required', 'Spotify 只给付费账号放歌', 'spotify', 'no-audio-files');
    }
    const file = pickFile(files, quality);
    const format = String(file?.format ?? '');
    const shape = shapeOf(format);
    if (!file?.file_id || !shape) {
        throw new OnlineProviderError('unavailable', `Spotify 给的格式放不了（${format || '未知'}）`, 'spotify', `format ${format}`);
    }
    context.log(`[Spotify] ${id} 的文件：${format} ${file.file_id}`);

    const market = await context.market().catch(() => 'from_token');
    const salt = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(byte => byte.toString(16).padStart(2, '0')).join('');
    const resolved = await readJson(context, `${STORAGE_URL}${file.file_id}?product=0&country=${encodeURIComponent(market)}&salt=${salt}`, '文件地址') as
        { cdnurl?: string[] | string; result?: string };
    const cdnUrl = Array.isArray(resolved?.cdnurl) ? resolved.cdnurl[0] : typeof resolved?.cdnurl === 'string' ? resolved.cdnurl : resolved?.result;
    if (typeof cdnUrl !== 'string' || !/^https?:/i.test(cdnUrl)) {
        throw new OnlineProviderError('invalid-response', 'Spotify 给的文件地址读不懂', 'spotify', JSON.stringify(resolved).slice(0, 120));
    }

    const key = await readKey(context, file.file_id);
    const audio = await bridgeRequest({
        url: cdnUrl, method: 'GET', timeoutMs: REQUEST_LIMIT_MS, followRedirects: true, binary: true,
        headers: { Authorization: `Bearer ${await context.token()}` },
    });
    if (audio.status >= 400) {
        throw new OnlineProviderError('unavailable', `Spotify 的 CDN 没有给出这首（HTTP ${audio.status}）`, 'spotify');
    }
    const encrypted = base64Bytes(String(audio.bodyBase64 ?? ''));
    if (encrypted.length === 0 || encrypted.length > MAX_TRACK_BYTES) {
        throw new OnlineProviderError('invalid-response', 'Spotify 的音频长度不对', 'spotify', `${encrypted.length} bytes`);
    }

    // AES-128 计数器模式，整段一次解开（16 字节一块，计数器从固定值起）。
    const keyHandle = await crypto.subtle.importKey('raw', key, { name: 'AES-CTR' }, false, ['decrypt']);
    const decrypted = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-CTR', counter: hexBytes(AUDIO_IV), length: 128 }, keyHandle, encrypted,
    ));
    if (decrypted.length <= shape.skip) {
        throw new OnlineProviderError('invalid-response', 'Spotify 的音频解出来是空的', 'spotify');
    }
    if (shape.skip) {
        // 解出来的第一页之后才是 Ogg 流；不是的话说明钥匙或格式对不上，别把噪声当歌放。
        const head = String.fromCharCode(...decrypted.slice(shape.skip, shape.skip + 4));
        if (head !== 'OggS') {
            throw new OnlineProviderError('invalid-response', 'Spotify 的音频没解开', 'spotify', `lead "${head}"`);
        }
    }

    const bytes = decrypted.slice(shape.skip);
    const url = pageUrl(id, quality, bytes, shape.mimeType);
    context.log(`[Spotify] ${id} 可播：${format}，${(bytes.length / 1024 / 1024).toFixed(1)} MB，用了 ${Date.now() - startedAt}ms`);
    return { url, format, bytes: bytes.length };
};

/** 换账号或退出时把解开的歌放掉。 */
export const releaseSpotifyAudio = (): void => {
    for (const { url } of opened.values()) {
        try { URL.revokeObjectURL(url); } catch { /* 已经放掉 */ }
    }
    opened.clear();
};
