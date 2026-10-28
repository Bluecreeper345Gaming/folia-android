import { useEffect, useRef } from 'react';
import { compareVersions, fetchRemoteVersion } from '../utils/system/appVersionCheck';
import { offerRemoteVersion } from '../stores/useAppUpdatePromptStore';

// src/hooks/useSiteUpdateCheck.ts
// 启动时问一次站点：有没有比本机新的版本。有了就交给 useAppUpdatePromptStore，
// 由它按「跳过到第二天」的规则决定要不要提。
//
// 不等首屏：请求一挂载就发出去，AsyncFunction 在后台跑，界面照常渲染。
// 用 ref 记住「问过了」，不经过 state：这个标记不该让 App 重渲染一次。
// 读不到、没网、本机不比站点旧，都静默结束，不打扰用户。

/** 让出一帧再发请求：首屏的渲染与图片解码先走，这一个请求不必插在前面。 */
const DEFER_MS = 300;

export const useSiteUpdateCheck = (): void => {
    const askedRef = useRef(false);

    useEffect(() => {
        if (askedRef.current) return;
        const appVersion = typeof __APP_VERSION__ === 'undefined' ? null : __APP_VERSION__;
        if (!appVersion) return;
        askedRef.current = true;
        const timer = window.setTimeout(() => {
            console.log(`[SiteUpdate] 开始检查，本机版本 ${appVersion}`);
            void fetchRemoteVersion().then((remote) => {
                if (!remote) {
                    console.log('[SiteUpdate] 没读到站点版本，这次不提示');
                    return;
                }
                const diff = compareVersions(String(appVersion), remote.version);
                console.log(`[SiteUpdate] 本机 ${appVersion} vs 站点 ${remote.version}，比较结果 ${diff}`);
                // 站点上一个不比本机新的版本不该提，等于也不提。
                if (diff >= 0) {
                    console.log('[SiteUpdate] 本机不比站点旧，不提示');
                    return;
                }
                offerRemoteVersion(remote);
            }).catch((error) => {
                // 兜底：这一步不该抛，抛了也要留下痕迹。
                console.log(`[SiteUpdate] 检查出错：${error instanceof Error ? error.message : String(error)}`);
            });
        }, DEFER_MS);
        return () => window.clearTimeout(timer);
    }, []);
};
