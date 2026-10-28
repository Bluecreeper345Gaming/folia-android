// src/services/onlineMusic/spotify/spotifyAndroid.ts
// Spotify 在手机上的实现：桌面版把这一层放在 Electron 主进程（electron/spotify/*.cjs），
// 手机上改成在 WebView 里做同一套事——
//   - 登录：OAuth 2.0 授权码 + PKCE。桌面版起一个 127.0.0.1:5588 的本地服务等浏览器跳回来；
//     手机上由原生开一个 WebView 登录窗，拦截跳回 127.0.0.1:5588/login 的那一次导航，
//     把整条 URL 交回来（不真的起服务，也不出应用）。
//   - 取数据：Spotify 自家的 pathfinder（GraphQL，persisted query 哈希）+ spclient，
//     请求走原生桥（FoliaBridge），不受页面同源限制。
//   - 会话：token / 账号存在 providerStorage（localStorage）里。
// 操作名与形状与桌面版 spotifyApiBridge.cjs 一致，spotifyTransport.ts 在原生平台上转到这里。
import { bridgeRequest, isNativeBridgeAvailable } from '../../../audioNative/core';
import { readProviderSessionValue, removeProviderSessionValue, writeProviderSessionValue } from '../providerStorage';
import { OnlineProviderError } from '../../../types/onlineMusic';
import { openSpotifyAudio, releaseSpotifyAudio } from './spotifyAudio';
import type { SpotifyAudioQuality } from './spotifyAudio';
import i18n from '../../../i18n/config';

// 与桌面版同一个 Spotify 客户端（开源播放器共用的那个）。
const CLIENT_ID = '65b708073fc0480ea92a077233ca87bd';
const REDIRECT_URI = 'http://127.0.0.1:5588/login';
const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const QUERY_URL = 'https://api-partner.spotify.com/pathfinder/v2/query';
const SPCLIENT_URL = 'https://spclient.wg.spotify.com';
const ATTEMPT_MS = 10 * 60 * 1000;
const REQUEST_LIMIT_MS = 30_000;
const RENEW_AHEAD_MS = 60 * 1000;
const ACCOUNT_MAX_AGE_MS = 10 * 60 * 1000;
const MAX_SONGS_A_CHANGE = 100;
const SCOPES = [
    'app-remote-control', 'playlist-modify', 'playlist-modify-private', 'playlist-modify-public', 'playlist-read',
    'playlist-read-collaborative', 'playlist-read-private', 'streaming', 'ugc-image-upload', 'user-follow-modify',
    'user-follow-read', 'user-library-modify', 'user-library-read', 'user-modify', 'user-modify-playback-state',
    'user-modify-private', 'user-personalized', 'user-read-birthdate', 'user-read-currently-playing', 'user-read-email',
    'user-read-play-history', 'user-read-playback-position', 'user-read-playback-state', 'user-read-private',
    'user-read-recently-played', 'user-top-read',
].join(' ');

// 查询与改动各自的 persisted query 哈希，2026-10-22 从网页播放器 bundle（web-player.15cdd331.js
// 与它的 89 个路由 chunk）里读的，并在真账号上逐个实测过；来源和读法见 docs/spotify-capture/README.md。
// 同一份哈希被几个名字共用是常态：真正决定取哪份文档的是哈希，`operationName` 近乎装饰。
const QUERIES: Record<string, string> = {
    home: '5fb7da7a03ee2776c0670856609cb85a189a3cecc36cc160b91cde79063b9cf1',
    homeSection: '5fb7da7a03ee2776c0670856609cb85a189a3cecc36cc160b91cde79063b9cf1',
    browsePage: 'f5c4e6d668f5716464a231c1cc8b22c1cbf6ad68b09929fd7de813a30581298b',
    queryWhatsNewFeed: 'd889c8c936ab192af8ced595427f5ba2acdf63478fdc0a181c8d477f8322630e',
    profileAttributes: '08ffb4730af3746e04a8301396f20875dbbce10c75243803091a9274eacc8ac0',
    libraryV3: '390c78e5b951029bad359785e69b07b536a509c581cbcd0aded5e5067f187455',
    fetchLibraryTracks: '087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240',
    fetchPlaylist: '21ea11a6ac75a5f3e01fd365d29c18e0a4a8b7dc09f89bbb5d73910190c6acaf',
    getAlbum: '0b6ce3511e1b02e4a40fa95440f992acbe85080eb308af9194322d708fc1914f',
    queryArtistOverview: '9f8134ef565e78621f1e1793555bd6633c5ac144ae0f89604ed3ae3f80b3c8e6',
    queryArtistDiscographyAll: '5e07d323febb57b4a56a42abbf781490e58764aa45feb6e3dc0591564fc56599',
    searchTracks: 'b02683192a98dde7966b5e6655a79eeb62713eab703eda9902c932818dd52751',
    getTrack: 'fe16b8083eec2305854db612ca75589bcb71e009dc7a4d014f29bd534a4c01f5',
    areEntitiesInLibrary: '134337999233cc6fdd6b1e6dbf94841409f04a946c5c7b744b09ba0dfe5a85ed',
};
const CHANGES: Record<string, string> = {
    addToLibrary: '896ebcb47815681340860d121cb5d494e157e2a78d3950385cd54e0393c67148',
    removeFromLibrary: '896ebcb47815681340860d121cb5d494e157e2a78d3950385cd54e0393c67148',
    // 这两个名字在当前 bundle 里找不到了（收藏歌单现在可能也走 addToLibrary 的 libraryItemUris），
    // 旧哈希先留着，没有实测过。
    addItemsToRootlist: 'bd9c5cae1ee80ebca05d7ed12fd394216f49a20ce72d9dc762868df0f14522ea',
    removeItemsFromRootlist: '3422f1866532820a1d8d0560f88542dbdbd35d0377ee5ecd49593590f5f1e86b',
    addToPlaylist: 'b907ad6b088d5bf7680fa81198996d58398c2d55dfcdf59fcc959e0be98a418a',
    removeFromPlaylist: 'b907ad6b088d5bf7680fa81198996d58398c2d55dfcdf59fcc959e0be98a418a',
};
// 渲染端不让它读 profileAttributes（账号名不进界面）。
const RENDERER_QUERIES = Object.keys(QUERIES).filter(name => name !== 'profileAttributes');
const LIBRARY_URI = /^spotify:(track|album|playlist):[0-9A-Za-z]{22}$/;
const TRACK_ID = /^[0-9A-Za-z]{22}$/;
const PAGE_LANGUAGES: Record<string, string> = { 'zh-CN': 'zh-CN', en: 'en', in: 'id' };

const TOKEN_KEY = 'tokens';
const USER_KEY = 'user';
const DEVICE_KEY = 'device';

interface Credentials { access_token: string; refresh_token: string; expires_at: number }
interface AccountUser { id: string; nickname: string; avatarUrl: string; premium: boolean }

const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const randomBytes = (size: number): Uint8Array => {
    const bytes = new Uint8Array(size);
    crypto.getRandomValues(bytes);
    return bytes;
};

const sha256Base64url = async (text: string): Promise<string> => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return base64url(new Uint8Array(digest));
};

/** 账号在界面上的 id：Spotify 的用户名只在这里做一个摘要，不原样露出去。 */
const publicAccountId = async (username: string): Promise<string> => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`folia-spotify:${username}`));
    return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 24);
};

const readJson = <T>(key: string): T | null => {
    const raw = readProviderSessionValue('spotify', key);
    if (!raw) return null;
    try { return JSON.parse(raw) as T; } catch { return null; }
};
const writeJson = (key: string, value: unknown): void => writeProviderSessionValue('spotify', key, JSON.stringify(value));

const credentials = (): Credentials | null => {
    const value = readJson<Credentials>(TOKEN_KEY);
    return value && typeof value.access_token === 'string' && typeof value.refresh_token === 'string'
        && Number.isFinite(value.expires_at) ? value : null;
};
const user = (): AccountUser | null => {
    const value = readJson<AccountUser>(USER_KEY);
    return value && typeof value.id === 'string' && typeof value.nickname === 'string' ? value : null;
};

const fail = (code: 'network' | 'unavailable' | 'auth-required' | 'unsupported' | 'invalid-response' | 'subscription-required', message: string, reason?: string): never => {
    throw new OnlineProviderError(code, message, 'spotify', reason);
};

// ---------------------------------------------------------------------------
// 网络
// ---------------------------------------------------------------------------

const httpText = async (
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; text: string }> => {
    if (!isNativeBridgeAvailable()) fail('network', 'Spotify 需要原生网络桥');
    const answer = await bridgeRequest({
        url,
        method: (init.method ?? 'GET').toUpperCase(),
        headers: init.headers ?? {},
        ...(init.body === undefined ? {} : { body: init.body }),
        followRedirects: true,
        timeoutMs: REQUEST_LIMIT_MS,
    });
    const text = String(answer.body ?? '');
    if (answer.status >= 400) {
        // 失败时把状态和回包开头记下来：Spotify 的错因基本都写在这两处里。
        console.warn(`[Spotify] ${(init.method ?? 'GET').toUpperCase()} ${url.split('?')[0]} -> HTTP ${answer.status} ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
    }
    return { status: answer.status, text };
};

// ---------------------------------------------------------------------------
// 会话与 token
// ---------------------------------------------------------------------------

const language = (): string => PAGE_LANGUAGES[String(i18n.language ?? 'zh-CN')] ?? 'en';


let renewing: { refresh: string; answer: Promise<string> } | null = null;

const renew = (refreshToken: string): Promise<string> => {
    if (renewing?.refresh === refreshToken) return renewing.answer;
    const answer = (async () => {
        const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID }).toString();
        const { status, text } = await httpText(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        let parsed: { access_token?: string; refresh_token?: string; expires_in?: number; error?: string } | null = null;
        try { parsed = JSON.parse(text); } catch { /* 下面报 */ }
        if (parsed?.error === 'invalid_grant') {
            removeProviderSessionValue('spotify', TOKEN_KEY);
            removeProviderSessionValue('spotify', USER_KEY);
            throw new OnlineProviderError('auth-required', 'Spotify 不再接受这个登录了，请重新登录', 'spotify', 'invalid_grant');
        }
        if (status >= 400 || typeof parsed?.access_token !== 'string') {
            throw new OnlineProviderError('unavailable', `Spotify 没有发新 token（HTTP ${status}）`, 'spotify');
        }
        const updated: Credentials = {
            access_token: parsed.access_token,
            refresh_token: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : refreshToken,
            expires_at: Date.now() + Math.max(60, Number(parsed.expires_in) || 3600) * 1000,
        };
        writeJson(TOKEN_KEY, updated);
        console.log(`[Spotify] Token renewed, good for ${Math.round((updated.expires_at - Date.now()) / 1000)}s`);
        return updated.access_token;
    })().finally(() => { if (renewing?.answer === answer) renewing = null; });
    renewing = { refresh: refreshToken, answer };
    return answer;
};

const accessToken = async (fresh = false): Promise<string> => {
    const saved = credentials();
    if (!saved) fail('auth-required', 'Spotify 还没有登录');
    if (!fresh && saved.expires_at - Date.now() > RENEW_AHEAD_MS) return saved.access_token;
    return renew(saved.refresh_token);
};

// ---------------------------------------------------------------------------
// 查询与改动
// ---------------------------------------------------------------------------

const call = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}, token?: string) => {
    const bearer = token ?? await accessToken();
    // 2026-10-22 实测：pathfinder 和 spclient 都只认 Authorization；网页播放器早就不发 `client-token` 了，
    // 带不带 `app-platform` / `origin` 结果一样（docs/spotify-capture/README.md）。
    const headers = {
        Accept: 'application/json',
        'Accept-Language': language(),
        ...(init.headers ?? {}),
        Authorization: `Bearer ${bearer}`,
        // 不要加 app-platform/spotify-app-version：那是"我是网页播放器"的声明，
        // 一旦声明了，Spotify 就要求同时带 client-token，否则回 403 "Client/request not allowed"。
        // 桌面版只带 Authorization，这里与它保持一致。
    };
    let response = await httpText(url, { ...init, headers });
    if (response.status === 401 && !token) {
        response = await httpText(url, { ...init, headers: { ...headers, Authorization: `Bearer ${await accessToken(true)}` } });
    }
    if (response.status >= 400) {
        throw new OnlineProviderError('unavailable', `Spotify 拒绝了请求（HTTP ${response.status}）`, 'spotify');
    }
    try { return JSON.parse(response.text) as Record<string, unknown>; } catch { return null; }
};

const ask = async (name: string, hash: string, variables: Record<string, unknown>, token?: string) => {
    const answer = await call(QUERY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variables, operationName: name, extensions: { persistedQuery: { version: 1, sha256Hash: hash } } }),
    }, token) as { data?: unknown; errors?: Array<{ message?: string }> } | null;
    const said = Array.isArray(answer?.errors) ? answer.errors.map(error => error?.message).filter(Boolean).join(' | ').slice(0, 160) : '';
    return { data: answer?.data, said, refused: Array.isArray(answer?.errors) && answer.errors.length > 0 };
};

const query = async (name: string, variables: Record<string, unknown> = {}, token?: string) => {
    const { data, said } = await ask(name, QUERIES[name], variables, token);
    if (!data) throw new OnlineProviderError('invalid-response', `Spotify 没有回答 ${name}`, 'spotify', said);
    if (said) console.warn(`[Spotify] ${name} answered in part: ${said}`);
    return data as Record<string, unknown>;
};

const change = async (name: string, variables: Record<string, unknown>) => {
    const { data, said, refused } = await ask(name, CHANGES[name], variables);
    const results = data && typeof data === 'object' ? Object.values(data) : [];
    if (refused || results.length === 0 || results.some(result => result === null)) {
        fail('unavailable', `Spotify 拒绝了这次改动（${name}）`, said || 'no result');
    }
};

// ---------------------------------------------------------------------------
// 账号
// ---------------------------------------------------------------------------

// 账号在哪个市场、是不是付费：storage-resolve 要国家码，界面要 VIP 标记。隔一阵子重读一次。
let planRead: { at: number; country: string; premium: boolean } | null = null;
const planOf = async (token?: string): Promise<{ country: string; premium: boolean }> => {
    if (planRead && Date.now() - planRead.at < ACCOUNT_MAX_AGE_MS) return planRead;
    const state = await call(`${SPCLIENT_URL}/melody/v1/product_state?market=from_token`, {}, token) as
        { country?: string; catalogue?: string; product?: string } | null;
    planRead = {
        at: Date.now(),
        country: String(state?.country || 'from_token'),
        premium: state?.catalogue === 'premium' || state?.product === 'premium',
    };
    return planRead;
};

const readAccount = async (token: string): Promise<AccountUser & { premiumKnown: boolean }> => {
    const profile = await query('profileAttributes', {}, token) as {
        me?: { profile?: { username?: string; name?: string; avatar?: { sources?: Array<{ url?: string; width?: number }> } } };
    };
    let premium = false;
    let premiumKnown = false;
    try {
        const plan = await planOf(token);
        premium = plan.premium;
        premiumKnown = true;
    } catch (error) {
        console.warn('[Spotify] The plan could not be read:', error instanceof Error ? error.message : String(error));
    }
    const me = profile?.me?.profile;
    if (typeof me?.username !== 'string' || !me.username) fail('invalid-response', 'Spotify 没有说登录的是谁');
    const sources = Array.isArray(me?.avatar?.sources) ? me.avatar.sources : [];
    const largest = sources.reduce((best: { url?: string; width?: number } | null, picture) => (
        (picture?.width ?? 0) > (best?.width ?? -1) ? picture : best
    ), null as { url?: string; width?: number } | null);
    return {
        id: await publicAccountId(me.username),
        nickname: String(me.name || me.username),
        avatarUrl: typeof largest?.url === 'string' ? largest.url : '',
        premium,
        premiumKnown,
    };
};

let accountReadAt = 0;
let accountReading: Promise<void> | null = null;

/** 账号的名字/套餐隔一阵子重读一次；读失败不影响已存的东西。 */
const refreshAccount = (maxAgeMs = ACCOUNT_MAX_AGE_MS): Promise<void> => {
    if (!credentials() || !user()) return Promise.resolve();
    if (accountReading) return accountReading;
    if (Date.now() - accountReadAt < maxAgeMs) return Promise.resolve();
    accountReadAt = Date.now();
    const reading: Promise<void> = (async () => {
        const read = await readAccount(await accessToken());
        writeJson(USER_KEY, { id: read.id, nickname: read.nickname, avatarUrl: read.avatarUrl, premium: read.premium });
    })().catch(error => {
        console.warn('[Spotify] The account could not be read again:', error instanceof Error ? error.message : String(error));
    }).finally(() => {
        if (accountReading === reading) accountReading = null;
    });
    accountReading = reading;
    return reading;
};

// ---------------------------------------------------------------------------
// 登录（PKCE + 原生 WebView 拦截回跳）
// ---------------------------------------------------------------------------

type NativeLogin = {
    /** 应用内登录窗（某些 OEM 上不显示，留作退路）。 */
    openWebRedirect?: (options: { url: string; redirectPrefix: string }) => Promise<{ url?: string }>;
    /** 本机起服务等浏览器跳回，再用系统浏览器打开授权页（与桌面版同一条路）。 */
    openSpotifyLogin?: (options: { url: string; redirectPrefix: string }) => Promise<{ url?: string }>;
};

const getPlugin = (): NativeLogin | null => {
    if (typeof window === 'undefined') return null;
    const capacitor = (window as unknown as {
        Capacitor?: { isNativePlatform?: () => boolean; Plugins?: { FoliaNative?: NativeLogin } };
    }).Capacitor;
    if (!capacitor?.isNativePlatform?.()) return null;
    return capacitor.Plugins?.FoliaNative ?? null;
};

type PendingLogin = {
    key: string;
    state: string;
    verifier: string;
    page: string;
    expiresAt: number;
    opened: boolean;
    outcome: null | { state: 'waiting' } | { state: 'confirmed' } | { state: 'error'; message: string };
    running: Promise<void> | null;
};

let pending: PendingLogin | null = null;

const dropPending = (): void => { pending = null; };

const finishPending = async (attempt: PendingLogin, redirect: string): Promise<void> => {
    let url: URL;
    try { url = new URL(redirect); } catch {
        attempt.outcome = { state: 'error', message: 'sign-in-failed' };
        return;
    }
    const code = url.searchParams.get('code');
    const said = url.searchParams.get('error');
    if (!code) {
        attempt.outcome = { state: 'error', message: said ?? 'sign-in-failed' };
        return;
    }
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: attempt.verifier,
        client_id: CLIENT_ID,
    }).toString();
    const { status, text } = await httpText(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });
    let parsed: { access_token?: string; refresh_token?: string; expires_in?: number; error?: string } | null = null;
    try { parsed = JSON.parse(text); } catch { /* 下面报 */ }
    if (status >= 400 || typeof parsed?.access_token !== 'string' || typeof parsed?.refresh_token !== 'string') {
        console.warn(`[Spotify] The code was not exchanged: HTTP ${status} ${parsed?.error ?? ''}`);
        attempt.outcome = { state: 'error', message: parsed?.error ?? 'sign-in-failed' };
        return;
    }
    const tokens: Credentials = {
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token,
        expires_at: Date.now() + Math.max(60, Number(parsed.expires_in) || 3600) * 1000,
    };
    writeJson(TOKEN_KEY, tokens);
    try {
        const read = await readAccount(tokens.access_token);
        writeJson(USER_KEY, { id: read.id, nickname: read.nickname, avatarUrl: read.avatarUrl, premium: read.premium });
        accountReadAt = Date.now();
        console.log(`[Spotify] Signed in as ${read.nickname} (Premium: ${read.premiumKnown ? (read.premium ? 'yes' : 'no') : 'not known'})`);
        attempt.outcome = { state: 'confirmed' };
    } catch (error) {
        // Spotify 已经批准了，只是账号资料没读出来：登录照样算成功（token 已在手上），
        // 名字先放一个占位，等下次读成功再换掉——否则界面会停在"读取账号失败"，一条歌都看不到。
        console.warn('[Spotify] The account could not be read after sign-in:', error instanceof Error ? error.message : String(error));
        if (!user()) {
            writeJson(USER_KEY, { id: 'spotify-account', nickname: 'Spotify', avatarUrl: '', premium: false });
        }
        attempt.outcome = { state: 'confirmed' };
    }
};

const beginLogin = async (): Promise<{ key: string; expiresInMs: number }> => {
    const plugin = getPlugin();
    if (!plugin?.openSpotifyLogin && !plugin?.openWebRedirect) {
        fail('unsupported', '这个构建没有内置登录窗口', 'mobile-no-login');
    }
    const verifier = base64url(randomBytes(64));
    const challenge = await sha256Base64url(verifier);
    const state = base64url(randomBytes(16));
    const page = `${AUTHORIZE_URL}?${new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: SCOPES,
        code_challenge_method: 'S256',
        code_challenge: challenge,
        state,
    })}`;
    pending = {
        key: Array.from(randomBytes(16)).map(byte => byte.toString(16).padStart(2, '0')).join(''),
        state, verifier, page, expiresAt: Date.now() + ATTEMPT_MS, opened: false, outcome: null, running: null,
    };
    console.log('[Spotify] Sign-in begun, waiting for the native window');
    return { key: pending.key, expiresInMs: ATTEMPT_MS };
};

const openLogin = async (key: string): Promise<boolean> => {
    const attempt = pending;
    if (!attempt || attempt.key !== key || attempt.outcome) return false;
    const plugin = getPlugin();
    if (!plugin?.openSpotifyLogin && !plugin?.openWebRedirect) {
        fail('unsupported', '这个构建没有内置登录窗口', 'mobile-no-login');
    }
    attempt.opened = true;
    attempt.running = (async () => {
        try {
            // 优先用应用内登录窗（不外跳浏览器）；没有这个方法时才退回"本机服务 + 系统浏览器"。
            const answer = plugin.openWebRedirect
                ? await plugin.openWebRedirect({ url: attempt.page, redirectPrefix: REDIRECT_URI })
                : await plugin.openSpotifyLogin!({ url: attempt.page, redirectPrefix: REDIRECT_URI });
            const redirect = String(answer?.url ?? '');
            if (!redirect) {
                attempt.outcome = { state: 'error', message: 'sign-in-failed' };
                return;
            }
            await finishPending(attempt, redirect);
        } catch (error) {
            attempt.outcome = { state: 'error', message: error instanceof Error ? error.message : 'sign-in-failed' };
        }
    })();
    return true;
};

// ---------------------------------------------------------------------------
// 对外：与桌面版同名同形状的操作
// ---------------------------------------------------------------------------

let availabilityLogged = false;
/**
 * 登录态存在时，启动后探一次 pathfinder：把状态码和回包开头写进日志。
 * 这样"登录了但搜索/歌单都空"不用靠界面猜——日志里直接有 Spotify 的原话。
 */
let probed = false;
const probeOnce = async (): Promise<void> => {
    if (probed || !credentials()) return;
    probed = true;
    try {
        const token = await accessToken();
        const authorization = `Bearer ${token}`;
        // 1) 这个 token 在普通 Web API 上认不认
        const me = await httpText('https://api.spotify.com/v1/me', { headers: { Authorization: authorization } });
        console.log(`[Spotify] probe /v1/me -> HTTP ${me.status} ${me.text.slice(0, 120).replace(/\s+/g, ' ')}`);

        // 2) pathfinder：逐个试常见的头组合，看哪一种被接受
        const body = JSON.stringify({
            variables: {},
            operationName: 'profileAttributes',
            extensions: { persistedQuery: { version: 1, sha256Hash: QUERIES.profileAttributes } },
        });
        const variants: Array<[string, Record<string, string>]> = [
            ['plain', { Authorization: authorization }],
            ['+app-platform', { Authorization: authorization, 'app-platform': 'WebPlayer', 'spotify-app-version': '1.2.63.394.g126b0d89' }],
            ['+origin', { Authorization: authorization, Origin: 'https://open.spotify.com', Referer: 'https://open.spotify.com/' }],
            ['+all', {
                Authorization: authorization, 'app-platform': 'WebPlayer', 'spotify-app-version': '1.2.63.394.g126b0d89',
                Origin: 'https://open.spotify.com', Referer: 'https://open.spotify.com/',
            }],
        ];
        for (const [label, headers] of variants) {
            const answer = await httpText(QUERY_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Language': language(), ...headers },
                body,
            });
            console.log(`[Spotify] probe pathfinder ${label} -> HTTP ${answer.status} ${answer.text.slice(0, 140).replace(/\s+/g, ' ')}`);
        }
    } catch (error) {
        console.warn('[Spotify] probe failed:', error instanceof Error ? error.message : String(error));
    }
};

// 已经登录过的话，模块一加载就探一次（不必等界面去查登录态），日志里就能看到 Spotify 的原话。
if (typeof window !== 'undefined' && credentials()) {
    setTimeout(() => { void probeOnce(); }, 6000);
}

export const spotifyAndroidAvailable = (): boolean => {
    const plugin = getPlugin();
    const available = isNativeBridgeAvailable() && Boolean(plugin?.openSpotifyLogin || plugin?.openWebRedirect);
    if (!availabilityLogged) {
        availabilityLogged = true;
        console.log(`[Spotify] Mobile bridge: ${available ? 'ready' : 'unavailable'}`);
    }
    return available;
};

export const runSpotifyAndroidOperation = async (operation: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    switch (operation) {
        case 'login_start':
            return beginLogin();
        case 'login_open':
            return openLogin(String(params.key ?? ''));
        case 'login_cancel':
            if (pending && (!params.key || pending.key === params.key)) dropPending();
            return true;
        case 'login_check': {
            const attempt = pending;
            if (!attempt || attempt.key !== String(params.key ?? '')) return { state: 'expired' };
            if (attempt.outcome) {
                const outcome = attempt.outcome;
                if (outcome.state === 'confirmed') {
                    dropPending();
                    return { state: 'confirmed' };
                }
                if (outcome.state === 'error') {
                    dropPending();
                    return { state: 'error', message: outcome.message };
                }
            }
            if (Date.now() >= attempt.expiresAt) {
                dropPending();
                return { state: 'expired' };
            }
            return { state: 'waiting' };
        }
        case 'login_status': {
            const account = user();
            if (!account) return null;
            void refreshAccount();
            void probeOnce();
            return { id: account.id, nickname: account.nickname, avatarUrl: account.avatarUrl, vipType: account.premium ? 1 : 0 };
        }
        case 'logout':
            dropPending();
            releaseSpotifyAudio();
            planRead = null;
            removeProviderSessionValue('spotify', TOKEN_KEY);
            removeProviderSessionValue('spotify', USER_KEY);
            console.log('[Spotify] Signed out');
            return true;
        case 'query': {
            const name = String(params.name ?? '');
            if (!RENDERER_QUERIES.includes(name)) fail('unsupported', 'Unsupported Spotify query');
            const variables = (params.variables ?? {}) as Record<string, unknown>;
            return query(name, variables);
        }
        case 'radio': {
            const id = String(params.id ?? '');
            if (!TRACK_ID.test(id)) fail('invalid-response', 'Invalid Spotify track');
            const answer = await call(`${SPCLIENT_URL}/inspiredby-mix/v2/seed_to_playlist/spotify:track:${id}?response-format=json`) as
                { mediaItems?: Array<{ uri?: string }> } | null;
            const uri = answer?.mediaItems?.[0]?.uri;
            return typeof uri === 'string' && uri.startsWith('spotify:playlist:') ? { uri } : null;
        }
        case 'library': {
            const match = LIBRARY_URI.exec(String(params.uri ?? ''));
            const kind = match?.[1];
            if (!kind || typeof params.saved !== 'boolean') fail('invalid-response', 'Invalid Spotify library change');
            if (kind === 'playlist') {
                const list = (await query('fetchPlaylist', {
                    uri: params.uri, offset: 0, limit: 1, enableWatchFeedEntrypoint: false,
                })) as { playlistV2?: { ownerV2?: { data?: { username?: string } } } };
                const owner = list?.playlistV2?.ownerV2?.data?.username;
                if (typeof owner === 'string' && owner && (await publicAccountId(owner)) === user()?.id) {
                    fail('unsupported', 'The playlist is the account\'s own');
                }
                await change(params.saved ? 'addItemsToRootlist' : 'removeItemsFromRootlist', { uris: [params.uri] });
            } else {
                await change(params.saved ? 'addToLibrary' : 'removeFromLibrary', { libraryItemUris: [params.uri] });
            }
            return true;
        }
        case 'playlist_create':
            // 新建歌单用的是 Spotify 另一个（未固定的）操作，这一版先不做。
            fail('unsupported', '手机版暂时不支持新建歌单', 'mobile-no-create');
        case 'playlist_edit': {
            const uri = `spotify:playlist:${String(params.id ?? '')}`;
            const uris = (Array.isArray(params.uris) ? params.uris : []).map(String).slice(0, MAX_SONGS_A_CHANGE);
            if (uris.length === 0) return true;
            await change(params.action === 'add' ? 'addToPlaylist' : 'removeFromPlaylist', { playlistUri: uri, uris });
            return true;
        }
        case 'audio': {
            const id = String(params.id ?? '');
            if (!TRACK_ID.test(id)) fail('invalid-response', 'Invalid Spotify track');
            const quality: SpotifyAudioQuality = params.quality === 'high' ? 'high' : 'standard';
            const plan = await planOf().catch(() => null);
            if (plan && !plan.premium) {
                // 不拦：Spotify 给不给文件以 metadata 的答复为准，这里只是把原因写进日志。
                console.warn('[Spotify] 这个账号不是付费版（product=free）；Spotify 通常只给付费账号发音频文件，拿不到就是 subscription-required');
            }
            return openSpotifyAudio({
                token: () => accessToken(),
                market: async () => (await planOf().catch(() => null))?.country ?? 'from_token',
                log: (...args: unknown[]) => console.log(...args),
            }, id, quality);
        }
        // 手机版没有按 URL 落盘的音频缓存（解开的歌在页面里，退出就没了），缓存这一层直说"没存"。
        case 'audio_keep':
        case 'audio_kept':
            return false;
        default:
            fail('unsupported', `Spotify 操作在手机版还没实现：${operation}`);
    }
};
