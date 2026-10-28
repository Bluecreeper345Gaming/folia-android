import { create } from 'zustand';

// src/stores/useSearchHistoryStore.ts
// 在线搜索的最近搜索记录：就是几次搜索的词，按时间从近到远排，重复的只留最近一次。
// 只存词，不存结果的来源（本地/网易云/QQ…）：同一次搜索换个平台照样能用，界面上也只有一行词。

const STORAGE_KEY = 'folia_search_history';
const MAX_ENTRIES = 12;

const storage = (): Storage | null => {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
        return null;
    }
};

const readEntries = (): string[] => {
    const store = storage();
    if (!store) return [];
    try {
        const parsed = JSON.parse(store.getItem(STORAGE_KEY) ?? '[]');
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
            .slice(0, MAX_ENTRIES);
    } catch {
        return [];
    }
};

const writeEntries = (entries: string[]): void => {
    const store = storage();
    if (!store) return;
    try {
        store.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
        // 存不进去（配额满、隐私模式）不影响这一次搜索，只是下次打开没有记录。
    }
};

interface SearchHistoryState {
    entries: string[];
    /** 记一次搜索：同一个词（不分大小写）只留最近的那一次，排在第一个。 */
    record: (query: string) => void;
    remove: (query: string) => void;
    clear: () => void;
}

export const useSearchHistoryStore = create<SearchHistoryState>((set, get) => ({
    entries: readEntries(),
    record: (query) => {
        const trimmed = query.trim();
        if (!trimmed) return;
        const lower = trimmed.toLowerCase();
        const next = [trimmed, ...get().entries.filter(entry => entry.toLowerCase() !== lower)].slice(0, MAX_ENTRIES);
        writeEntries(next);
        set({ entries: next });
    },
    remove: (query) => {
        const next = get().entries.filter(entry => entry !== query);
        writeEntries(next);
        set({ entries: next });
    },
    clear: () => {
        writeEntries([]);
        set({ entries: [] });
    },
}));
