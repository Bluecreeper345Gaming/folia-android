// src/services/onlineMusic/qishui/qishuiFailure.ts
// 取一首歌的音频、读一个集合的歌曲失败时交给共用规则的事实。

import { OnlineProviderError } from '../../../types/onlineMusic';
import type { OnlineFailureDetail, OnlineFailureOperation } from '../../../types/onlineMusic';
import {
    QISHUI_BRIDGE_FAILED,
    QISHUI_NEEDS_BRIDGE,
    QISHUI_NEEDS_DESKTOP,
    QishuiRequestError,
} from './qishuiTransport';

// 包里自己的原话（qishui-music-api@0.2.2）：
// src/playback.cjs：平台只给了加密音频，Folia 不做解密。
const PROTECTED_ONLY = 'Qishui returned protected audio only; decryption is disabled';
// src/client.cjs：没有任何会话时发起的账号请求。
const SIGNED_OUT = 'Sign in to Qishui first';

export const describeQishuiFailure = (_operation: OnlineFailureOperation, error: unknown): OnlineFailureDetail | null => {
    if (!(error instanceof OnlineProviderError) || error.providerId !== 'qishui') return null;
    // 这个页面没有可用的通道（浏览器版）：汽水在这里根本用不了。
    if (error.message === QISHUI_NEEDS_DESKTOP || error.message === QISHUI_NEEDS_BRIDGE) return { case: 'not-configured' };
    // 原生桥自己失败：问题在本机，不在网络上。
    if (error.message === QISHUI_BRIDGE_FAILED) return { case: 'local-service-stopped' };
    // 没人登录：说「登录后才能播放」，不要说「登录过期了」。
    if (error.code === 'auth-required' && error.message === SIGNED_OUT) return { signedOut: true };
    if (error.code === 'unsupported' && error.message === PROTECTED_ONLY) return { case: 'no-audio' };
    const status = /^Qishui HTTP (\d{3})$/.exec(error.message)?.[1];
    if (status) return { httpStatus: Number(status) };
    if (error instanceof QishuiRequestError && error.upstreamCode) return { code: error.upstreamCode };
    return null;
};
