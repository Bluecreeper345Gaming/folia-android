// src/services/onlineMusic/qishui/qishuiTransport.ts
// 汽水音乐（字节跳动车机 Luna 开放平台）的渲染进程边界。
// 桌面版经 Electron 主进程的 qishui-music-api；手机版没有主进程，同一个协议在 WebView 里
// （src/audioNative/qishui.ts）直接执行，请求经 FoliaBridge（OkHttp）发出。

import { OnlineProviderError } from '../../../types/onlineMusic';
import type { ProviderErrorCode } from '../../../types/onlineMusic';

export type QishuiOperation =
    | 'login_status' | 'logout' | 'login_qr_key' | 'login_qr_create' | 'login_qr_check' | 'login_qr_cancel'
    | 'search' | 'search_playlists' | 'song_detail' | 'media_details' | 'audio' | 'lyrics'
    | 'user_playlists' | 'playlist_detail' | 'playlist_tracks'
    | 'artist_detail' | 'artist_songs'
    | 'liked_songs' | 'like_song' | 'playlist_add_tracks' | 'playlist_remove_tracks'
    | 'recent_played' | 'check_tracks' | 'dislike_song'
    | 'feed' | 'feed_modes';

export type QishuiParams = Record<string, unknown>;

export const QISHUI_NEEDS_DESKTOP = 'Qishui requires the desktop app';
export const QISHUI_BRIDGE_FAILED = 'Qishui desktop request failed';
export const QISHUI_NEEDS_BRIDGE = 'Qishui requires the Android build';

const STAGES = ['access-code', 'ticket', 'account'] as const;
export type QishuiLoginStage = typeof STAGES[number];

let lastFailure: { stage: QishuiLoginStage | null; code: ProviderErrorCode; upstreamCode?: string } | null = null;
export const getQishuiLastFailure = () => lastFailure;
const isLoginOperation = (operation: QishuiOperation) => operation.startsWith('login_');

export class QishuiRequestError extends OnlineProviderError {
    constructor(
        code: ProviderErrorCode,
        message: string,
        public readonly stage: QishuiLoginStage | null,
        public readonly upstreamCode?: string,
    ) {
        super(code, message, 'qishui');
    }
}

const electronBridge = (): { qishuiRequest?: (operation: string, params: QishuiParams) => Promise<any> } | null => {
    if (typeof window === 'undefined') return null;
    return (window as unknown as { electron?: { qishuiRequest?: (operation: string, params: QishuiParams) => Promise<any> } }).electron ?? null;
};

const isNativeBridge = (): boolean => (
    typeof window !== 'undefined'
    && Boolean((window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.())
);

export const getQishuiAvailability = () => {
    if (typeof window === 'undefined') return { configured: false, reason: 'runtime-unavailable' as const };
    if (typeof electronBridge()?.qishuiRequest === 'function' || isNativeBridge()) return { configured: true } as const;
    return { configured: false, reason: 'runtime-unavailable' as const };
};

const PROVIDER_CODES: ReadonlySet<string> = new Set([
    'auth-required', 'unsupported', 'unavailable', 'not-playable', 'network', 'invalid-response',
]);

const describeNativeFailure = (error: unknown): QishuiRequestError => {
    const raw = error as { code?: string; message?: string; upstreamCode?: string; stage?: string; cause?: unknown };
    const stage = STAGES.find(value => value === raw?.stage) ?? null;
    const upstreamCode = typeof raw?.upstreamCode === 'string' && /^\d{1,12}$/.test(raw.upstreamCode) ? raw.upstreamCode : undefined;
    const code: ProviderErrorCode = raw?.code && PROVIDER_CODES.has(raw.code) ? raw.code as ProviderErrorCode : 'invalid-response';
    return new QishuiRequestError(code, raw?.message || 'Qishui operation failed', stage, upstreamCode);
};

// 一个操作：Electron 主进程（桌面）或 WebView 内的原生桥（手机）。
export async function requestQishui<T = unknown>(operation: QishuiOperation, params: QishuiParams = {}): Promise<T> {
    if (operation === 'login_qr_key') lastFailure = null;

    const electron = electronBridge();
    if (typeof electron?.qishuiRequest === 'function') {
        let result: any;
        try {
            result = await electron.qishuiRequest(operation, params);
        } catch (error) {
            throw new OnlineProviderError('network', QISHUI_BRIDGE_FAILED, 'qishui', error);
        }
        if (!result?.ok) {
            const failure = result?.error ?? {};
            const stage = STAGES.find(value => value === failure.stage) ?? null;
            const upstreamCode = typeof failure.upstreamCode === 'string' && /^\d{1,12}$/.test(failure.upstreamCode)
                ? failure.upstreamCode : undefined;
            if (isLoginOperation(operation)) lastFailure = { stage, code: failure.code, upstreamCode };
            throw new QishuiRequestError(failure.code ?? 'invalid-response', failure.message ?? 'Qishui operation failed', stage, upstreamCode);
        }
        return result.data as T;
    }

    if (!isNativeBridge()) throw new OnlineProviderError('unavailable', QISHUI_NEEDS_DESKTOP, 'qishui');

    let data: unknown;
    try {
        const { qishuiRequest } = await import('../../../audioNative');
        data = await qishuiRequest(operation, params);
    } catch (error) {
        const described = describeNativeFailure(error);
        if (isLoginOperation(operation)) {
            lastFailure = { stage: described.stage, code: described.code, upstreamCode: described.upstreamCode };
        }
        throw described;
    }
    return data as T;
}
