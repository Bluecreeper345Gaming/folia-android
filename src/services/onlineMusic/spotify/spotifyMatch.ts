import type { SongResult, UnifiedSong } from '../../../types';

// src/services/onlineMusic/spotify/spotifyMatch.ts
// 判断"另一家平台的这条结果是不是同一首歌"。只做纯文本判断，不碰网络，好测。

/** 比对前把两家的写法抹平：括号里的版本说明、标点、空白都不算。 */
export const normalize = (text: string): string => String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    // （(Live)、(Remastered 2011)、（伴奏）这类版本说明两家写得不一样，不参与比对。
    .replace(/[（(\[【][^）)\]】]*[）)\]】]/g, '')
    .replace(/[\s\-_·.,!?;:'"“”‘’、，。！？；：]/g, '');

export const artistNames = (song: { artists?: Array<{ name?: string }> }): string[] => (
    (song.artists ?? []).map(artist => normalize(String(artist?.name ?? ''))).filter(Boolean)
);

/**
 * 这条结果与这首歌像不像同一首，0 表示不是。
 * 歌名必须对得上（完全相同 100，一个包含另一个 60）；两边都写了艺人却没有一个对得上的，判为翻唱或同名歌。
 */
export const matchScore = (song: SongResult, candidate: UnifiedSong): number => {
    const want = normalize(song.name);
    const got = normalize(candidate.name);
    if (!want || !got) return 0;
    let title = 0;
    if (want === got) title = 100;
    else if (want.includes(got) || got.includes(want)) title = 60;
    if (!title) return 0;

    const wantArtists = artistNames(song);
    const gotArtists = artistNames(candidate as unknown as { artists?: Array<{ name?: string }> });
    const shared = wantArtists.filter(name => gotArtists.some(other => other.includes(name) || name.includes(other)));
    if (wantArtists.length && gotArtists.length && shared.length === 0) return 0;
    return title + (shared.length ? 40 + Math.min(20, shared.length * 10) : 0);
};
