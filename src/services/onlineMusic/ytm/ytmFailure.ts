import { OnlineProviderError } from '../../../types/onlineMusic';
import type { OnlineFailureDetail, OnlineFailureOperation } from '../../../types/onlineMusic';

// src/services/onlineMusic/ytm/ytmFailure.ts
// What a YouTube Music request for a song's audio or a collection's tracks that failed hands to the
// shared rules (services/onlineMusic/failure/). What the desktop side's words for a failure mean is
// said here only (they are made in electron/ytm/). A network that fails and 5xx come as `network`
// and need nothing here.

// electron/ytm/errors.cjs gives YouTube's 429 this sentence, under the code of a network that
// fails. A sign-in that fails on it is told apart by it too (ytmLoginFailure.ts).
export const YTM_ASKED_TO_WAIT = 'YouTube Music asked to wait before trying again';

export const describeYtmFailure = (_operation: OnlineFailureOperation, error: unknown): OnlineFailureDetail | null => {
    if (!(error instanceof OnlineProviderError) || error.providerId !== 'ytm') return null;
    if (error.code === 'network' && error.message === YTM_ASKED_TO_WAIT) return { case: 'retry-later', httpStatus: 429 };
    // electron/ytm/ytmApiBridge.cjs puts YouTube's playability status word in its sentence
    // ("cannot play this track (UNPLAYABLE)"): LOGIN_REQUIRED, AGE_CHECK_REQUIRED and the others are
    // quoted. A track blocked in the listener's country is one of them, on purpose.
    const word = error.code === 'not-playable' ? /\(([A-Z_]{2,40})\)$/.exec(error.message)?.[1] : undefined;
    // YouTube wants a sign-in for the track. The bridge reports this word where nobody is signed
    // in, or where the account's own player said it too (loadPlan).
    if (word === 'LOGIN_REQUIRED') return { case: 'sign-in-needed', code: word };
    if (word) return { code: word };
    // 手机端（audioNative/ytm.ts）抛的错本身就带着原因：没有音频格式时写 playability、
    // 请求失败时写 HTTP 状态。原样交给界面当引文，比只说一句"播放失败"有用。
    if (error.message) return { case: 'no-audio', message: error.message.slice(0, 240) };
    return null;
};
