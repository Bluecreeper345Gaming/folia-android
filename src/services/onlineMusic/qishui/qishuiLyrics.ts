// src/services/onlineMusic/qishui/qishuiLyrics.ts
// 车机 KRC 用 Folia 共用的排版引擎解析，翻译按行时间对齐。

import type { ProviderLyricsResult } from '../../../types/onlineMusic';
import { parseLyricsByFormat } from '../../../utils/lyrics/parserCore';
import { record } from './qishuiNormalize';

export function parseQishuiLyrics(raw: unknown): ProviderLyricsResult {
    const info = record(raw);
    const entity = record(info.lyric_entity);
    const content = typeof entity.content === 'string' ? entity.content.replace(/\u0000/g, '') : '';
    if (!content.trim()) return { lyrics: null, mainText: '', isPureMusic: false };
    const translations = record(info.lang_translations);
    const translated = record(translations['zh-CN'] || translations['ZH-HANS-CN'] || Object.values(translations)[0]);
    const translation = typeof translated.content === 'string' ? translated.content : '';
    const lyrics = parseLyricsByFormat(entity.type === 'krc' ? 'krc' : 'lrc', content);
    if (translation) {
        const lines = parseLyricsByFormat(translated.type === 'krc' ? 'krc' : 'lrc', translation).lines;
        const byTime = new Map(lines.map(line => [line.startTime, line.fullText]));
        for (const line of lyrics.lines) line.translation = byTime.get(line.startTime) || line.translation;
    }
    return {
        lyrics: lyrics.lines.length ? lyrics : null,
        mainText: content,
        wordByWordText: entity.type === 'krc' ? content : null,
        translationText: translation || null,
        isPureMusic: false,
    };
}
