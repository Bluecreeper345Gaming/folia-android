// src/utils/system/appVersionCheck.ts
// 「网站上的版本比本机新吗」——比较两个版本号，以及从站点取回那个版本号。
//
// 站点是 http 的（OSS 上挂的证书只签 *.aliyuncs.com，域名对不上，https 走不通），
// 而 App 的 WebView 运行在 https://localhost 上，直接 fetch 会被当混合内容拦掉，
// 所以原生端一律走 FoliaBridge（原生 OkHttp，不受同源与混合内容限制）。
// 网页版没有原生桥，才退回到浏览器 fetch。

import { bridgeRequest, isNativeBridgeAvailable } from '../../audioNative/core';

/** 站点根地址。站点只有 http 可用，见文件头的说明。 */
export const FOLIA_SITE_ORIGIN = 'http://buchumingdetiming.top';
/** 版本清单：`{ version, downloadUrl?, notes?, publishedAt? }`。 */
export const FOLIA_SITE_VERSION_URL = `${FOLIA_SITE_ORIGIN}/version.json`;
/** 没有清单时，退回到下载页本身（站点的下载区）。 */
export const FOLIA_SITE_DOWNLOAD_PAGE = `${FOLIA_SITE_ORIGIN}/#download`;

export type RemoteVersion = {
    /** 站点上写的版本号，原样保留。 */
    version: string;
    /** 站点给的下载地址；没有就用下载页。 */
    downloadUrl: string;
    /** 更新说明，可能为空。 */
    notes: string;
};

/** 把 `2.1.0`、`v2.1`、`2.1.0-beta.1` 拆成可比较的几段。 */
const parseVersion = (raw: string): { numbers: number[]; pre: string } | null => {
    const text = raw.trim().replace(/^v/i, '');
    if (!text) return null;
    const [core, pre = ''] = text.split('-', 2);
    const parts = core.split('.');
    if (!parts.length || parts.some(part => !/^\d+$/.test(part))) return null;
    return { numbers: parts.map(part => Number.parseInt(part, 10)), pre };
};

/**
 * 比较两个版本号：本机比站点新返回正数，相同返回 0，比站点旧返回负数。
 * 段数不同时短的补 0（`2.1` 与 `2.1.0` 相等）；正式版比同号预发布版新
 * （`2.1.0` > `2.1.0-beta`）。任一方读不出数字就当相等，宁可不提示也不误报。
 */
export const compareVersions = (a: string, b: string): number => {
    const left = parseVersion(a);
    const right = parseVersion(b);
    if (!left || !right) return 0;
    const length = Math.max(left.numbers.length, right.numbers.length);
    for (let index = 0; index < length; index += 1) {
        const diff = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
        if (diff !== 0) return diff > 0 ? 1 : -1;
    }
    if (left.pre === right.pre) return 0;
    if (!left.pre) return 1;
    if (!right.pre) return -1;
    return left.pre > right.pre ? 1 : -1;
};

/** 从下载页 HTML 里抠出版本号：页面上的 `<em>2.1.0</em>`。 */
export const parseVersionFromPage = (html: string): string | null => {
    // 只认下载卡里那一处 `<em>`，避免撞上页面别处的数字。
    const match = html.match(/folia\s*播放器\s*<em>\s*v?([\d.]+)\s*<\/em>/i)
        ?? html.match(/<h3>\s*folia[^<]*<em>\s*v?([\d.]+)\s*<\/em>/i);
    return match ? match[1].trim() : null;
};

/** 站点上的下载地址：优先清单里的，其次页面上那颗按钮的链接。 */
const parseDownloadUrlFromPage = (html: string): string | null => {
    const block = html.slice(html.search(/folia\s*播放器/i));
    const match = block.match(/href="(https?:\/\/[^"]+)"/i);
    return match ? match[1] : null;
};

/** 版本清单只是几行 JSON：站点两三秒还没答就当打不开，别让用户等。 */
const VERSION_REQUEST_TIMEOUT_MS = 6000;

/** 更新检查的日志前缀：开发者设置里的日志面板按它筛。 */
export const SITE_UPDATE_LOG_SCOPE = 'SiteUpdate';

const log = (message: string) => {
    // 走 console：consoleLogBuffer 会把这一行收进开发者设置的面板，出问题时能直接看到。
    console.log(`[${SITE_UPDATE_LOG_SCOPE}] ${message}`);
};

const requestText = async (url: string): Promise<string | null> => {
    const startedAt = Date.now();
    const viaNative = isNativeBridgeAvailable();
    log(`请求 ${url}（${viaNative ? '原生桥' : '浏览器 fetch'}）`);
    try {
        if (viaNative) {
            const answer = await bridgeRequest({ url, method: 'GET', timeoutMs: VERSION_REQUEST_TIMEOUT_MS });
            const cost = Date.now() - startedAt;
            if (answer.status < 200 || answer.status >= 300) {
                log(`原生桥返回 HTTP ${answer.status}，用时 ${cost}ms`);
                return null;
            }
            const body = answer.body ?? null;
            log(`原生桥返回 HTTP ${answer.status}，${body ? body.length : 0} 字节，用时 ${cost}ms`);
            return body;
        }
        const controller = new AbortController();
        const abort = window.setTimeout(() => controller.abort(), VERSION_REQUEST_TIMEOUT_MS);
        const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
        window.clearTimeout(abort);
        const cost = Date.now() - startedAt;
        if (!response.ok) {
            log(`fetch 返回 HTTP ${response.status}，用时 ${cost}ms`);
            return null;
        }
        const body = await response.text();
        log(`fetch 返回 HTTP ${response.status}，${body.length} 字节，用时 ${cost}ms`);
        return body;
    } catch (error) {
        // 没网、站点挂了、被安全策略拦下：都当作「这次没读到」，不打扰用户。
        // 但原因要写进日志：这正是「为什么没弹」的唯一线索。
        const cost = Date.now() - startedAt;
        const reason = error instanceof Error ? error.message : String(error);
        log(`请求失败，用时 ${cost}ms：${reason}`);
        return null;
    }
};

/**
 * 取回站点上的最新版本。先读 `version.json`，读不到再解析下载页。
 * 全失败返回 null：调用方静默跳过，不起任何提示。
 */
export const fetchRemoteVersion = async (): Promise<RemoteVersion | null> => {
    const manifest = await requestText(FOLIA_SITE_VERSION_URL);
    if (manifest) {
        try {
            const data = JSON.parse(manifest) as { version?: unknown; downloadUrl?: unknown; notes?: unknown };
            if (typeof data.version === 'string' && parseVersion(data.version)) {
                log(`version.json 读到版本 ${data.version}`);
                return {
                    version: data.version.trim().replace(/^v/i, ''),
                    downloadUrl: typeof data.downloadUrl === 'string' && data.downloadUrl
                        ? data.downloadUrl
                        : FOLIA_SITE_DOWNLOAD_PAGE,
                    notes: typeof data.notes === 'string' ? data.notes : '',
                };
            }
        } catch (error) {
            // 清单坏了就当没有，下面还有页面可以试。
            log(`version.json 解析失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }
    log('version.json 读不到，退回解析下载页');
    const page = await requestText(`${FOLIA_SITE_ORIGIN}/`);
    const version = page ? parseVersionFromPage(page) : null;
    if (!page || !version) {
        log('下载页也读不到版本号，这次不提示');
        return null;
    }
    log(`下载页解析到版本 ${version}`);
    return {
        version,
        downloadUrl: parseDownloadUrlFromPage(page) ?? FOLIA_SITE_DOWNLOAD_PAGE,
        notes: '',
    };
};
