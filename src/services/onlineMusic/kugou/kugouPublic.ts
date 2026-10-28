import md5 from 'blueimp-md5';
import { OnlineProviderError } from '../../../types/onlineMusic';

// src/services/onlineMusic/kugou/kugouPublic.ts
// 酷狗的公开端点（不需要登录、不需要签名、不需要自建后端）。Android 上没有 KuGouMusicApi 那个后端，
// 扩展层那条签名网关的路又时好时坏，这里两条都是酷狗自己的公开接口：
//
//   搜索：mobilecdn.kugou.com/api/v3/search/song —— 老的 complexsearch 现在要签名，匿名一律回
//         20006 err signature，条目数为 0，界面上就是"搜不出来"。
//   取链接：trackercdn.kugou.com/i/v2/ —— key 是 md5(hash + 'kgcloudv2')，免费曲目直接给地址
//         （128k / hq / sq 都有），会员曲目回 status: 2。
//
// 会员曲目仍然要账号权益，这里救不了；它至少让"搜得到、免费的能放"成立，并且把
// "要会员"这个原因如实带回去。

const KUGOU_PUBLIC_UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36';
const KUGOU_PUBLIC_REFERER = 'https://www.kugou.com/';
const KUGOU_TRACKER_KEY_SALT = 'kgcloudv2';

export type KugouPublicSearchAnswer = {
    status?: number;
    errcode?: number;
    error?: string;
    data?: { total?: number; info?: unknown[] };
};

export type KugouPublicPlayAnswer = {
    url: string;
    status: number;
    bitRate?: number;
    extName?: string;
};

/** 匿名搜索。返回酷狗原始回答（`data.info` 就是条目数组，normalizeKugouSearchSongs 认这个形状）。 */
export const searchKugouPublic = async (
    keyword: string,
    page: number,
    pagesize: number,
): Promise<KugouPublicSearchAnswer> => {
    const target = new URL('http://mobilecdn.kugou.com/api/v3/search/song');
    target.searchParams.set('format', 'json');
    target.searchParams.set('keyword', keyword);
    target.searchParams.set('page', String(page));
    target.searchParams.set('pagesize', String(pagesize));
    target.searchParams.set('showtype', '1');
    const response = await fetch(target.toString(), {
        method: 'GET',
        credentials: 'omit',
        headers: {
            'User-Agent': KUGOU_PUBLIC_UA,
            Referer: KUGOU_PUBLIC_REFERER,
            Accept: 'application/json, text/plain, */*',
        },
    });
    if (!response.ok) {
        throw new OnlineProviderError('network', `KuGou public search failed: ${response.status}`, 'kugou');
    }
    return await response.json() as KugouPublicSearchAnswer;
};

/**
 * 公开取链接。`br`：'128'（默认）/ 'hq'（320）/ 'sq'（无损）。
 * 会员曲目回 status 2、没有地址 —— 这不是我们的错，调用方据此说"需要会员"。
 */
export const resolveKugouPublicPlayUrl = async (
    hash: string,
    br: '128' | 'hq' | 'sq',
): Promise<KugouPublicPlayAnswer> => {
    const normalizedHash = String(hash || '').trim().toLowerCase();
    if (!normalizedHash) return { url: '', status: 0 };
    const target = new URL('http://trackercdn.kugou.com/i/v2/');
    target.searchParams.set('key', md5(`${normalizedHash}${KUGOU_TRACKER_KEY_SALT}`));
    target.searchParams.set('hash', normalizedHash);
    target.searchParams.set('br', br);
    target.searchParams.set('appid', '1005');
    target.searchParams.set('pid', '2');
    target.searchParams.set('cmd', '25');
    target.searchParams.set('behavior', 'play');
    const response = await fetch(target.toString(), {
        method: 'GET',
        credentials: 'omit',
        headers: {
            'User-Agent': KUGOU_PUBLIC_UA,
            Referer: KUGOU_PUBLIC_REFERER,
            Accept: 'application/json, text/plain, */*',
        },
    });
    if (!response.ok) {
        throw new OnlineProviderError('network', `KuGou public play URL failed: ${response.status}`, 'kugou');
    }
    const body = await response.json() as {
        status?: number;
        url?: string | string[];
        bitRate?: number;
        extName?: string;
        error?: string;
    };
    const rawUrl = Array.isArray(body.url) ? body.url[0] : body.url;
    const url = typeof rawUrl === 'string' && /^https?:\/\//i.test(rawUrl) ? rawUrl.split(',')[0]!.trim() : '';
    return {
        url,
        status: Number(body.status) || 0,
        ...(Number.isFinite(body.bitRate) ? { bitRate: Number(body.bitRate) } : {}),
        ...(typeof body.extName === 'string' ? { extName: body.extName } : {}),
    };
};
