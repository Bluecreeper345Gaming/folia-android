// src/services/onlineMusic/qishui/qishuiProvider.ts
// 汽水音乐车机平台适配器：账号与目录都走 Omni 既有的入口。
// 一次登录属于这些东西：播放可用性检查。账号变化（确认、退出、登录过期）时一起丢掉。

import type { OnlineMusicProvider, ProviderPage, LoginState } from '../../../types/onlineMusic';
import { OnlineProviderError } from '../../../types/onlineMusic';
import { createProviderSongMetadata } from '../../../utils/songMetadata';
import { requestQishui, getQishuiAvailability, getQishuiLastFailure, QishuiRequestError } from './qishuiTransport';
import { normalizeQishuiSong, normalizeQishuiUser, normalizeQishuiCollection } from './qishuiNormalize';
import { qishuiCatalog, qishuiLibrary } from './qishuiCatalog';
import { parseQishuiLyrics } from './qishuiLyrics';
import { diagnosticLine } from '../login/loginDiagnosticReport';
import { qishuiMutations, qishuiSongId as songId } from './qishuiMutations';
import { qishuiPlayback, clearQishuiPlayback, readQishuiSongs } from './qishuiPlayback';
import { describeQishuiFailure } from './qishuiFailure';
import { qishuiExplore, clearQishuiExplore } from './qishuiExplore';
import { qishuiRecommendations, clearQishuiRecommendations } from './qishuiRecommendations';

function clearAccountState() {
    clearQishuiPlayback();
    clearQishuiExplore();
    clearQishuiRecommendations();
}

export const qishuiProvider: OnlineMusicProvider = {
    id: 'qishui',
    displayName: '汽水音乐',
    shortName: '汽水',
    mark: { letter: '汽', color: '#19a58c' },
    getAvailability: getQishuiAvailability,
    capabilities: {
        search: true,
        playback: true,
        lyrics: true,
        wordByWordLyrics: true,
        auth: true,
        userLibrary: true,
        playlists: true,
        albums: false,
        artists: true,
        recommendations: true,
        explore: true,
        mutations: true,
        likes: true,
        playlistTrackMutations: true,
    },
    normalizeSong: normalizeQishuiSong,
    normalizeUser: normalizeQishuiUser,
    normalizeCollection: normalizeQishuiCollection,
    songMetadata: { getSongMetadata: createProviderSongMetadata },
    describeFailure: describeQishuiFailure,
    getSongPageUrl: song => `https://music.douyin.com/qishui/share/track?track_id=${encodeURIComponent(songId(song))}`,
    search: {
        async searchSongs(query, limit, offset) {
            if (!query.trim()) return { items: [], hasMore: false, nextOffset: offset };
            const page = await requestQishui<ProviderPage<unknown>>('search', { query, limit, offset });
            return { ...page, items: await readQishuiSongs(page.items) };
        },
    },
    playback: qishuiPlayback,
    lyrics: { getLyrics: async song => parseQishuiLyrics(await requestQishui('lyrics', { id: songId(song) })) },
    auth: {
        describeLoginFailure(_step, error) {
            if (error instanceof OnlineProviderError && error.code === 'network') return { case: 'unreachable' };
            if (!(error instanceof QishuiRequestError)) return null;
            return {
                ...(error.stage === 'account' ? { case: 'account-not-read' as const } : {}),
                ...(error.upstreamCode ? { code: error.upstreamCode } : {}),
                mainCode: error.stage || undefined,
            };
        },
        async getLoginDiagnostics() {
            const failure = getQishuiLastFailure();
            return failure
                ? [diagnosticLine`stage=${failure.stage} code=${failure.code} upstreamCode=${failure.upstreamCode}`]
                : [];
        },
        getLoginTexts: () => ({ title: 'home.loginTitleQishui', note: 'home.loginNoteQishui' }),
        signInRanOut: clearAccountState,
        async getLoginStatus() {
            try {
                const user = await requestQishui('login_status');
                return user ? normalizeQishuiUser(user) : null;
            } catch (error) {
                // 没登录就是没登录：不把「请先登录」当成读账号失败。
                if (error instanceof OnlineProviderError) {
                    console.warn('[Qishui] Account read failed', { code: error.code, message: error.message });
                    if (error.code === 'auth-required') return null;
                }
                throw error;
            }
        },
        async startLogin() {
            const result = await requestQishui<{ key: string }>('login_qr_key');
            if (!result?.key) throw new OnlineProviderError('invalid-response', 'Qishui gave no QR key', 'qishui');
            return result.key;
        },
        async createQr(key) {
            const result = await requestQishui<{ imageUrl: string }>('login_qr_create', { key });
            if (!result?.imageUrl) throw new OnlineProviderError('invalid-response', 'Qishui gave no QR image', 'qishui');
            return result.imageUrl;
        },
        async checkLogin(key) {
            try {
                const result = await requestQishui<LoginState>('login_qr_check', { key });
                if (result.state === 'confirmed') clearAccountState();
                return result;
            } catch (error) {
                if (error instanceof OnlineProviderError && error.code === 'network') {
                    return { state: 'error', transient: true, failure: { case: 'unreachable' } };
                }
                throw error;
            }
        },
        async cancelLogin(key) {
            await requestQishui('login_qr_cancel', { key });
        },
        getLoginTtlMs: () => 300000,
        async logout() {
            clearAccountState();
            await requestQishui('logout');
        },
    },
    catalog: qishuiCatalog,
    library: qishuiLibrary,
    explore: qishuiExplore,
    recommendations: qishuiRecommendations,
    mutations: qishuiMutations,
};
