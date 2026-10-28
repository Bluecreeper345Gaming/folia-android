import type { SongResult, UnifiedSong } from '../../../types';
import type { ProviderSongReplacement } from '../../../types/onlineMusic';
import { listOnlineMusicProviders } from '../providerRegistry';
import { isSongUnavailable } from '../songAvailability';
import { matchScore } from './spotifyMatch';

// src/services/onlineMusic/spotify/spotifyReplacement.ts
// A free Spotify account is given no audio files at all (Spotify hands those to paying accounts only:
// docs/spotify-capture/README.md), so a Spotify song is played here by finding the same song on a
// platform that will play it. Spotify stays the catalogue — the playlists, the search, the covers —
// and the sound comes from somewhere else.
//
// This is what Mineradio does with its `playbackMode: 'recommend-match'`: `/api/spotify/song/url`
// answers `playable: false, action: 'switch_source'` and the app switches source.

// Platforms to ask, in the order their answers are trusted. Spotify itself is never asked: it is the
// one that has no audio.
const ORDER = ['netease', 'qq', 'kugou', 'bodian', 'ytm'];
// How many rows of each platform's search to look at.
const ROWS = 8;
// 一次换源最多打扰几个平台：第一个命中最要紧，问到第三个还没有就不再让用户等。
const MAX_PLATFORMS = 3;
// A match this good is offered; below it, nothing is (a wrong song is worse than a message).
const MIN_SCORE = 100;

/** The same song on another platform, or null where none of them seems to have it. */
export const findPlayableReplacement = async (song: SongResult): Promise<ProviderSongReplacement | null> => {
    const title = String(song.name ?? '').trim();
    if (!title) return null;
    const artists = (song.artists ?? []).map(artist => String(artist?.name ?? '')).filter(Boolean);
    const text = [title, artists[0] ?? ''].join(' ').trim();

    const platforms = listOnlineMusicProviders()
        .filter(provider => provider.id !== 'spotify')
        .filter(provider => provider.capabilities.search && provider.search)
        .sort((left, right) => {
            const leftAt = ORDER.indexOf(String(left.id));
            const rightAt = ORDER.indexOf(String(right.id));
            return (leftAt < 0 ? ORDER.length : leftAt) - (rightAt < 0 ? ORDER.length : rightAt);
        });

    let best: { song: UnifiedSong; score: number; provider: string } | null = null;
    let asked = 0;
    for (const provider of platforms) {
        if (asked >= MAX_PLATFORMS) break;
        // 平台没配好（没有服务地址、没装原生桥）就不问，失败也不打断别的平台，也不占那三次机会。
        try {
            if (provider.getAvailability && !provider.getAvailability().configured) continue;
        } catch {
            continue;
        }
        asked += 1;
        const search = provider.search;
        if (!search) continue;
        let rows: UnifiedSong[] = [];
        try {
            rows = (await search.searchSongs(text, ROWS, 0)).items;
        } catch (error) {
            console.warn(`[Spotify] 换源：${provider.displayName} 没答上来（${error instanceof Error ? error.message : String(error)}）`);
            continue;
        }
        for (const row of rows) {
            const score = matchScore(song, row);
            if (score < MIN_SCORE) continue;
            if (isSongUnavailable(row)) continue;
            if (!best || score > best.score) best = { song: row, score, provider: String(provider.id) };
        }
        // 网易云命中就够了：先问它、它给了就不再打扰别的平台。
        if (best && best.provider === 'netease') break;
    }

    if (!best) return null;
    const platform = platforms.find(provider => String(provider.id) === best!.provider);
    console.log(`[Spotify] 换源：「${song.name}」→ ${platform?.displayName ?? best.provider}「${best.song.name}」（分 ${best.score}）`);
    return { song: best.song, label: `${platform?.displayName ?? best.provider} 同曲` };
};
