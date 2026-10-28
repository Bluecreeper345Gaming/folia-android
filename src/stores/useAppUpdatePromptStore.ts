// src/stores/useAppUpdatePromptStore.ts
// 站点更新提示的本地状态：哪个版本被跳过过、什么时候跳过的。
//
// 规则是「跳过之后第二天才会再弹」。这里只记「对哪个版本、哪一天跳过的」这一件事：
// 关掉提示的当天不再提，跨到第二天（本机日期变了）就重新提同一个版本，
// 而站点又发了更新的版本时立刻提新的那个。
//
// 不记「已经提醒过」：没有跳过的版本不该因为看过一次就永久沉默。

import { create } from 'zustand';
import { getStoredString } from './storagePrimitives';

const SKIPPED_VERSION_KEY = 'folia_site_update_skipped_version';
const SKIPPED_DAY_KEY = 'folia_site_update_skipped_day';

/** 本机日期，按 `YYYY-MM-DD`：跨天就是过了一天。 */
const today = (): string => {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${now.getFullYear()}-${month}-${day}`;
};

const readSkippedVersion = (): string | null => {
    try {
        return getStoredString(SKIPPED_VERSION_KEY, '') || null;
    } catch {
        return null;
    }
};

const readSkippedDay = (): string | null => {
    try {
        return getStoredString(SKIPPED_DAY_KEY, '') || null;
    } catch {
        return null;
    }
};

type AppUpdatePromptState = {
    /** 跳过过的版本，没有就是 null。 */
    skippedVersion: string | null;
    /** 跳过那一天，按 `YYYY-MM-DD`。 */
    skippedDay: string | null;
    /** 站点上找到的、还没被跳过的版本；null 表示不提示。 */
    pendingVersion: string | null;
    pendingNotes: string;
    pendingDownloadUrl: string;
    /** 跳过一个版本：当天安分，第二天才会再提。 */
    skipVersion: (version: string, downloadUrl: string, notes: string) => void;
};

export const useAppUpdatePromptStore = create<AppUpdatePromptState>((set, get) => ({
    skippedVersion: readSkippedVersion(),
    skippedDay: readSkippedDay(),
    pendingVersion: null,
    pendingNotes: '',
    pendingDownloadUrl: '',
    skipVersion: (version, downloadUrl, notes) => {
        const day = today();
        try {
            localStorage.setItem(SKIPPED_VERSION_KEY, version);
            localStorage.setItem(SKIPPED_DAY_KEY, day);
        } catch {
            // 隐私模式读不到存储：这一会话内仍然按已跳过处理。
        }
        set({ skippedVersion: version, skippedDay: day, pendingVersion: null, pendingNotes: '', pendingDownloadUrl: '' });
    },
}));

/**
 * 站点上的版本要不要提。跳过的版本当天不再提，跨天或换了版本才提。
 * 纯函数，便于单测。
 */
export const shouldPromptVersion = (
    remoteVersion: string,
    skippedVersion: string | null,
    skippedDay: string | null,
    todayText: string,
): boolean => (
    skippedVersion !== remoteVersion || skippedDay !== todayText
);

/** 把站点上读到的新版本收进 store，按「跳过规则」决定提不提。 */
export const offerRemoteVersion = (remote: { version: string; downloadUrl: string; notes: string }): void => {
    const { skippedVersion, skippedDay } = useAppUpdatePromptStore.getState();
    const day = today();
    if (!shouldPromptVersion(remote.version, skippedVersion, day)) {
        // 记下理由：这正是「重启后不弹」的第二个可能原因（第一个在 compareVersions）。
        console.log(`[SiteUpdate] 站点版本 ${remote.version} 今天已跳过过（跳过的是 ${skippedVersion}，跳过于 ${skippedDay}），不再提示`);
        return;
    }
    console.log(`[SiteUpdate] 提示站点版本 ${remote.version}（上次跳过 ${skippedVersion ?? '无'} @ ${skippedDay ?? '无'}）`);
    useAppUpdatePromptStore.setState({
        pendingVersion: remote.version,
        pendingDownloadUrl: remote.downloadUrl,
        pendingNotes: remote.notes,
    });
};
