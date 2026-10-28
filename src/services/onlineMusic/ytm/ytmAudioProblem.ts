// src/services/onlineMusic/ytm/ytmAudioProblem.ts
// 手机上取音频失败时记下最后那句话。失败提示（onlineFailureToast）在"媒体元素报错"那种情况下
// 拿不到 provider 的原话，就取这里的最后一条显示出来——否则永远只有一句"音频无法播放"。

let lastProblem: string | null = null;

export const noteYtmAudioProblem = (problem: string | null | undefined): void => {
    lastProblem = problem ? String(problem).slice(0, 400) : null;
};

export const readYtmAudioProblem = (): string | null => lastProblem;
