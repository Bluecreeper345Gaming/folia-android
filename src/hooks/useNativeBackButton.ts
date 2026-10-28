import { useEffect } from 'react';

type NativeBackPlugin = {
    addListener: (
        eventName: string,
        listener: () => void,
    ) => Promise<{ remove: () => Promise<void> }> | { remove: () => Promise<void> };
    exitApp: () => Promise<unknown>;
    recordRuntimeDiagnostic?: (payload: {
        source: string;
        thread: string;
        type: string;
        message: string;
        stack: string;
    }) => Promise<unknown>;
};

const getPlugin = (): NativeBackPlugin | null => {
    if (typeof window === 'undefined') return null;
    const capacitor = (window as unknown as {
        Capacitor?: {
            getPlatform?: () => string;
            Plugins?: { FoliaNative?: NativeBackPlugin };
        };
    }).Capacitor;
    if (capacitor?.getPlatform?.() !== 'android') return null;
    const plugin = capacitor.Plugins?.FoliaNative;
    return plugin && typeof plugin.addListener === 'function' && typeof plugin.exitApp === 'function'
        ? plugin
        : null;
};

/** 应用历史里的第几条（useAppNavigation 写进 history.state）；0 就是最早的那一条，也就是主界面。 */
const appHistoryIndex = (): number => {
    const state = window.history.state as { appHistoryIndex?: unknown } | null;
    const index = state?.appHistoryIndex;
    return typeof index === 'number' && Number.isFinite(index) && index > 0 ? index : 0;
};

/**
 * 把 Android 的返回（全面屏手势、三键导航、外接键盘）当成一次 Escape 派发给页面。
 * 弹窗、命令面板、播放页、搜索面板都已经在 Escape 上挂了自己的「关掉 / 返回上一层」。
 */
const dispatchEscape = (): boolean => {
    const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
        cancelable: true,
    });
    return !window.dispatchEvent(event) || event.defaultPrevented;
};

const report = (plugin: NativeBackPlugin, type: string, message: string): void => {
    void plugin.recordRuntimeDiagnostic?.({
        source: 'activity-lifecycle',
        thread: 'webview',
        type,
        message,
        stack: '',
    }).catch(() => undefined);
};

/**
 * 硬件返回 / 全面屏手势返回的三级顺序：
 *   1. 有层认了 Escape（弹窗、命令面板、搜索、播放页……）→ 它已经关掉或返回上一层；
 *   2. 应用历史里还有更早的一条 → 退回去（popstate 会把视图、搜索、集合栈一起恢复）；
 *   3. 已经在主界面 → 退出程序。
 */
export const useNativeBackButton = (): void => {
    useEffect(() => {
        const plugin = getPlugin();
        if (!plugin) return;

        let disposed = false;
        let listenerHandle: { remove: () => Promise<void> } | { remove: () => void } | null = null;
        const registered = plugin.addListener('backButton', () => {
            if (disposed) return;
            if (dispatchEscape()) {
                report(plugin, 'back-handled', 'A layer handled Escape');
                return;
            }
            if (appHistoryIndex() > 0) {
                report(plugin, 'back-history', 'Navigating back through app history');
                window.history.back();
                return;
            }
            report(plugin, 'back-unhandled', 'At the root view; requesting app exit');
            void plugin.exitApp().catch(() => undefined);
        });

        Promise.resolve(registered)
            .then(handle => {
                if (disposed) {
                    void handle.remove();
                    return;
                }
                listenerHandle = handle;
            })
            .catch(() => undefined);

        return () => {
            disposed = true;
            if (listenerHandle) void listenerHandle.remove();
        };
    }, []);
};
