// src/svc/nativeLyricBridge.ts
// 把歌词时间轴交给原生侧，让 ColorOS 锁屏 / 通知栏 / 厂商「灵动岛」能显示歌词。
//
// 协议来源：ColorOS-Live-Lyrics-Bridge 4.x 的 PLAYER_INTEGRATION（播放器自发接入）。
// 关键点是它**不要**数组结构，要的是 LRC 文本：
//
//   MediaMetadata["lyricInfo"] = JSON.stringify({
//     songName, artist, songId, lyricType: 0,
//     lyric:            "[00:10.000]第一行\n[00:14.500]第二行\n",   ← 逐行，必填
//     rawLyric:         "[00:10.000]<00:10.000>逐 <00:10.700>字",     ← 逐字，可选
//     translationLyric: "[00:10.000]译文",                           ← 翻译，可选
//     noLyric: false,
//   })
//
// 三条 lane 都是**绝对毫秒**时间戳；逐字是绝对时间点，不是相对行首的偏移。
// 原始歌词没有逐字就别编一个 —— 协议明确要求不要伪造卡拉OK扫光。
//
// 为什么只在换歌 / 换词时推一次：SystemUI 从 PlaybackState 的时钟推进歌词，
// 每秒重写 metadata 会重建通知、被系统限流、还费电（协议第 6 节明确禁止）。

import type { LyricData, Line } from '../types';
import { getPlaybackSongKey } from '../utils/appPlaybackGuards';
import { selectDisplayLyrics, selectDisplaySong, usePlaybackStore } from '../stores/usePlaybackStore';

type ColorOsLyricsPlugin = {
  isSupported: () => Promise<{ supported: boolean; colorOsMajor: number; detail: string }>;
  publish: (options: { lyricInfo: string; hasTranslation: boolean; songKey: string }) => Promise<{ ok: boolean }>;
  clear: () => Promise<unknown>;
};

/** 协议第 7 节：提交前量体积，参考实现拒绝 512 KiB 以上；超出会产生 Binder 事务失败。 */
const MAX_LYRIC_INFO_BYTES = 512 * 1024;

/** 秒 → LRC 的 `mm:ss.mmm`。 */
const toLrcTime = (seconds: number): string => {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const minutes = Math.floor(ms / 60000);
  const rest = ms % 60000;
  const wholeSeconds = Math.floor(rest / 1000);
  const millis = rest % 1000;
  return `${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
};

/** 一行文本：去掉换行，免得撑破 LRC 的行结构。 */
const lineText = (line: Line): string => (line.fullText ?? '').replace(/[\r\n]+/g, ' ').trim();

/** 真正能上锁屏的行：跳过纯空白（间奏占位），否则翻译对不齐、系统那行也空着。 */
const usableLines = (lyrics: LyricData | null): Line[] => (
  (lyrics?.lines ?? []).filter(line => lineText(line).length > 0)
);

const byStart = (a: Line, b: Line) => a.startTime - b.startTime;

/** 逐行 lane。协议要求行首时间非递减，所以先排一遍（有的歌词源是乱序）。 */
const buildLrc = (lines: Line[]): string => (
  [...lines].sort(byStart).map(line => `[${toLrcTime(line.startTime)}]${lineText(line)}`).join('\n')
);

/**
 * 逐字 lane：`[行首]<字1开始>字1<字2开始>字2<终止>`。
 *
 * 只在歌词真的带词级时间轴时才生成；行级歌词不编逐字（协议 4.2 第 5 条）。
 * 末尾补终止标签，标出最后一个字的视觉结束位置。
 */
const buildRawLrc = (lines: Line[]): string => {
  const rows: string[] = [];
  for (const line of [...lines].sort(byStart)) {
    if (!line.words?.length) continue;
    const words = line.words
      .filter(word => (word.text ?? '').length > 0 || (word.startTime ?? 0) > 0)
      .sort((a, b) => a.startTime - b.startTime);
    if (!words.length) continue;
    let row = `[${toLrcTime(line.startTime)}]`;
    for (const word of words) {
      row += `<${toLrcTime(word.startTime)}>${(word.text ?? '').replace(/[\r\n]+/g, ' ')}`;
    }
    const lastWord = words[words.length - 1];
    const tail = line.endTime > lastWord.endTime ? line.endTime : lastWord.endTime;
    row += `<${toLrcTime(tail)}>`;
    rows.push(row);
  }
  return rows.join('\n');
};

/**
 * 翻译 lane：与主行**同一个起始时间**。
 *
 * 协议第 4.3 节：一条翻译只配一条主行；罗马音/音译不算翻译、不能进这条 lane。
 * 没有真翻译就整个字段不给，而不是复制原文。
 */
const buildTranslationLrc = (lines: Line[]): string => (
  [...lines]
    .sort(byStart)
    .filter(line => Boolean(line.translation && line.translation.trim()))
    .map(line => `[${toLrcTime(line.startTime)}]${line.translation.replace(/[\r\n]+/g, ' ').trim()}`)
    .join('\n')
);

export type LyricIdentity = {
  songName: string;
  artist: string;
  songId: string;
  trackKey: string;
};

/**
 * 把一份歌词拼成协议要求的 `lyricInfo` JSON。空歌词返回 null，调用方据此走 clear。
 */
export const buildLyricInfo = (lyrics: LyricData | null, identity: LyricIdentity): string | null => {
  const lines = usableLines(lyrics);
  if (!lines.length) return null;
  const lyric = buildLrc(lines);
  if (!lyric) return null;

  const payload: Record<string, unknown> = {
    songName: identity.songName,
    artist: identity.artist,
    songId: identity.songId,
    // 0 = 标准时间轴歌词
    lyricType: 0,
    lyric,
    provider: 'ti.folia.ming',
    source: 'ti.folia.ming-v1',
    trackKey: identity.trackKey,
    noLyric: false,
  };
  const rawLyric = buildRawLrc(lines);
  if (rawLyric) payload.rawLyric = rawLyric;
  const translationLyric = buildTranslationLrc(lines);
  if (translationLyric) payload.translationLyric = translationLyric;

  const json = JSON.stringify(payload);
  if (json.length > MAX_LYRIC_INFO_BYTES) {
    console.log(`[NativeLyric] 歌词 ${json.length} 字节超过 ${MAX_LYRIC_INFO_BYTES}，不推`);
    return null;
  }
  return json;
};

let installed = false;
let lastPushed = '';
let supportedCache: boolean | null = null;

const getPlugin = (): ColorOsLyricsPlugin | null => {
  const plugin = (window as any).Capacitor?.Plugins?.FoliaColorOsLyrics as ColorOsLyricsPlugin | undefined;
  return plugin ?? null;
};

/** 问一次原生走不走这条通道；判定要读 ROM 属性，所以在原生做，这里只缓存。 */
const isSupported = async (plugin: ColorOsLyricsPlugin): Promise<boolean> => {
  if (supportedCache !== null) return supportedCache;
  try {
    const answer = await plugin.isSupported();
    supportedCache = Boolean(answer?.supported);
    console.log(`[NativeLyric] ColorOS 歌词通道${supportedCache ? '可用' : '不可用'}（major=${answer?.colorOsMajor ?? 0}，${answer?.detail ?? ''}）`);
    return supportedCache;
  } catch (error) {
    supportedCache = false;
    console.log(`[NativeLyric] 通道探测失败：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
};

const readIdentity = (song: unknown): LyricIdentity => {
  const value = song as { name?: string; artists?: Array<{ name?: string }>; album?: { name?: string } };
  const songName = (value?.name ?? '').trim() || 'Unknown';
  const artist = (value?.artists ?? []).map(item => item?.name ?? '').filter(Boolean).join(' / ');
  const songId = getPlaybackSongKey(song as never);
  return { songName, artist, songId, trackKey: songId };
};

/**
 * 把当前这首歌的歌词推给原生。换了歌 / 换了词 / 换了身份才真的发。
 *
 * 歌词可能比播放状态先到（用户还没按播放），所以这里不检查「是否在播」，
 * 只检查「有没有歌」—— 没歌就 clear。
 */
export const syncNativeLyrics = async (lyrics: LyricData | null): Promise<void> => {
  const plugin = getPlugin();
  if (!plugin) return;
  if (!(await isSupported(plugin))) return;

  const song = selectDisplaySong(usePlaybackStore.getState());
  if (!song) {
    if (lastPushed) {
      lastPushed = '';
      void plugin.clear().catch(() => undefined);
      console.log('[NativeLyric] 没有在播的歌，撤掉歌词');
    }
    return;
  }

  const identity = readIdentity(song);
  const lyricInfo = buildLyricInfo(lyrics, identity);
  const dedupe = `${identity.trackKey}\u0000${lyricInfo ?? ''}`;
  if (dedupe === lastPushed) return;
  lastPushed = dedupe;

  if (!lyricInfo) {
    void plugin.clear().catch(() => undefined);
    console.log(`[NativeLyric] ${identity.trackKey} 没有可用歌词，不推`);
    return;
  }

  const lineCount = usableLines(lyrics).length;
  try {
    const answer = await plugin.publish({
      lyricInfo,
      hasTranslation: Boolean(lyrics?.lines?.some(line => (line.translation ?? '').trim())),
      songKey: identity.trackKey,
    });
    console.log(`[NativeLyric] 推送 ${identity.trackKey}：${lineCount} 行，${lyricInfo.length} 字节，ok=${answer?.ok ?? false}`);
  } catch (error) {
    console.log(`[NativeLyric] 推送失败：${error instanceof Error ? error.message : String(error)}`);
  }
};

/**
 * 挂到播放 store 上：歌词一变就推。
 *
 * 订阅整份 store，靠上面的 dedupe 去重 —— 播放进度那种每秒写入不会变成每秒推送。
 * 歌词取 `selectDisplayLyrics`：转场中与通知栏是同一份，两边不会各说各话。
 */
export const installNativeLyricBridge = (): void => {
  if (installed) return;
  installed = true;
  usePlaybackStore.subscribe(() => {
    void syncNativeLyrics(selectDisplayLyrics(usePlaybackStore.getState()));
  });
  void syncNativeLyrics(selectDisplayLyrics(usePlaybackStore.getState()));
};
