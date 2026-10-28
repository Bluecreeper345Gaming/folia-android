import { readProviderSessionValue, removeProviderSessionValue, writeProviderSessionValue } from '../services/onlineMusic/providerStorage';

// src/audioNative/ytmLogin.ts
// 手机上的 YouTube Music 登录：原生插件开一个**应用自己的 WebView** 加载 Google 登录页。
// 因为用的是本应用的 WebView，Cookie 落在同一个 CookieManager 里 —— 原生桥的 OkHttp 与它共用，
// 所以拿到会话之后，搜索/取址/歌单都能直接带上它（桌面版是靠 Electron 开窗口抓 Cookie，网页版没有这条路）。

type NativeCookie = { name?: string; value?: string };
type NativeLoginPlugin = {
    openWebLogin?: (options: { url?: string; successHost?: string }) => Promise<{ cookie?: string | null }>;
    cookiesGetAll?: (options: { url: string }) => Promise<{ cookies?: NativeCookie[] }>;
    cookiesRemoveBatch?: (options: { entries: Array<{ url: string; name: string; domain?: string; path?: string }> }) => Promise<{ removed?: number }>;
};

// 桌面版是在 music.youtube.com 上点"登录"走 Google 的：这样会先出账号选择器。
// 直接甩 accounts.google.com/ServiceLogin?continue=… 时，WebView 里已有的那个 Google 会话会被
// 默认选中、不弹选择器 —— 表现就是"登进去的是另一个账号"。
const LOGIN_URL = 'https://music.youtube.com/';
const SUCCESS_HOST = 'music.youtube.com';
const COOKIE_KEY = 'cookie';
// 退出登录后到此为止：CookieManager 里哪怕还留着 Google 的 cookie，也不拿它当登录态，
// 否则"退出→再登录"会原样回到同一个账号，换不了号。
const SIGNED_OUT_KEY = 'signed-out';

// 退出登录时要清的那几个源。删 cookie 时 domain 要跟着写：SAPISID 这种是 `.youtube.com`
// 上的域 cookie，只按 host 删删不掉。
const SIGN_OUT_HOSTS = [
    { url: 'https://music.youtube.com/', domains: ['.youtube.com', 'music.youtube.com'] },
    { url: 'https://www.youtube.com/', domains: ['.youtube.com', 'www.youtube.com'] },
    { url: 'https://accounts.google.com/', domains: ['.google.com', 'accounts.google.com'] },
    { url: 'https://www.google.com/', domains: ['.google.com', 'www.google.com'] },
];

const getPlugin = (): NativeLoginPlugin | null => {
    if (typeof window === 'undefined') return null;
    const capacitor = (window as unknown as {
        Capacitor?: { isNativePlatform?: () => boolean; Plugins?: { FoliaNative?: NativeLoginPlugin } };
    }).Capacitor;
    if (!capacitor?.isNativePlatform?.()) return null;
    return capacitor.Plugins?.FoliaNative ?? null;
};

/** 有没有真的登录态：Google 的会话以 SAPISID / __Secure-3PAPISID 为准。 */
export const hasYtmSessionCookie = (cookie: string): boolean => (
    /(?:^|;\s*)SAPISID=[^;]+/.test(cookie) || /(?:^|;\s*)__Secure-3PAPISID=[^;]+/.test(cookie)
);

const isSignedOut = (): boolean => readProviderSessionValue('ytm', SIGNED_OUT_KEY) === '1';

/** 当前会话（先读存下来的，再问系统 CookieManager）。没有就是空串。 */
export const readYtmCookie = async (): Promise<string> => {
    if (isSignedOut()) return '';
    const stored = readProviderSessionValue('ytm', COOKIE_KEY) ?? '';
    if (hasYtmSessionCookie(stored)) return stored;
    const plugin = getPlugin();
    if (!plugin?.cookiesGetAll) return stored;
    try {
        const answer = await plugin.cookiesGetAll({ url: `https://${SUCCESS_HOST}/` });
        const cookie = (answer?.cookies ?? [])
            .filter(item => item?.name)
            .map(item => `${item.name}=${item.value ?? ''}`)
            .join('; ');
        if (cookie) writeProviderSessionValue('ytm', COOKIE_KEY, cookie);
        return cookie || stored;
    } catch {
        return stored;
    }
};

/** 打开应用内登录页；用户登录完成后返回整串 Cookie，关掉窗口返回空串。 */
export const openYtmLogin = async (): Promise<string> => {
    const plugin = getPlugin();
    if (!plugin?.openWebLogin) {
        throw Object.assign(new Error('这个构建没有内置登录窗口'), { ytmCode: 'unsupported' });
    }
    // 这一次登录要能换号：先解掉"已退出"的锁。
    removeProviderSessionValue('ytm', SIGNED_OUT_KEY);
    const answer = await plugin.openWebLogin({ url: LOGIN_URL, successHost: SUCCESS_HOST });
    const cookie = String(answer?.cookie ?? '');
    if (cookie) writeProviderSessionValue('ytm', COOKIE_KEY, cookie);
    return cookie;
};

/**
 * 退出登录：本地存的会话、CookieManager 里的 YouTube/Google cookie，全部清掉。
 *
 * 只清 localStorage 是不够的：readYtmCookie 会回落到 CookieManager，一读又读回同一个账号，
 * 于是"退出登录"看起来点了没反应、换号也换不了。
 */
export const clearYtmSession = async (): Promise<void> => {
    writeProviderSessionValue('ytm', SIGNED_OUT_KEY, '1');
    removeProviderSessionValue('ytm', COOKIE_KEY);
    const plugin = getPlugin();
    if (!plugin?.cookiesGetAll || !plugin.cookiesRemoveBatch) return;
    const entries: Array<{ url: string; name: string; domain?: string; path?: string }> = [];
    for (const host of SIGN_OUT_HOSTS) {
        let cookies: NativeCookie[] = [];
        try {
            const answer = await plugin.cookiesGetAll({ url: host.url });
            cookies = answer?.cookies ?? [];
        } catch {
            cookies = [];
        }
        for (const cookie of cookies) {
            if (!cookie?.name) continue;
            // 先按 host 删一条，再按可能的域删：域 cookie 不带 domain 删不掉。
            entries.push({ url: host.url, name: cookie.name, path: '/' });
            for (const domain of host.domains) entries.push({ url: host.url, name: cookie.name, domain, path: '/' });
        }
    }
    if (entries.length === 0) return;
    try {
        const result = await plugin.cookiesRemoveBatch({ entries });
        console.log(`[Ytm] Sign-out: ${result?.removed ?? entries.length} cookie entries cleared`);
    } catch (error) {
        console.warn('[Ytm] Sign-out: cookies could not be cleared:', error instanceof Error ? error.message : String(error));
    }
};
