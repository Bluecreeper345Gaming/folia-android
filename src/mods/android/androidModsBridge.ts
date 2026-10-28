import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { unzipSync } from 'fflate';
import type {
    ModClearCacheResult,
    ModFfmpegStatus,
    ModLogEntry,
    ModRpcMessage,
    ModRuntimeInfo,
    ModRuntimeSnapshot,
    ModSecretChange,
    ModSecretsState,
    ModSetEnabledResult,
    ModStorageUsageResult,
    ModsListPayload,
    ModMainCallStats,
} from '../types';

// src/mods/android/androidModsBridge.ts
// The mod system's main-process half, reimplemented for the Android build.
//
// The desktop app keeps mods in an Electron main process: it installs them, guards their Node entry,
// serves `folia-mod://` and answers every call in src/mods/ipc.ts. Android has neither Node nor that
// process, so this module answers the same calls from the WebView with the browser's own tools:
//
//  - mods live under the app's private data directory, `mods/<mod id>/mod.json` with its entries
//    (the folder is shown in the manager's 「打开目录」 notice; `adb push` or a file manager with
//    access to the app's files can fill it);
//  - a mod's `client` entry runs in this window, imported from a blob: URL of its source, which is
//    what the desktop's `folia-mod://` URL is for;
//  - a mod's `main` entry cannot run (no Node). Calls that only the main entry could answer
//    (`rpc`, the Node-side storage file) answer 'no-main-entry' instead of failing the mod.
//  - storage and secret settings are kept in localStorage, which is not encrypted: the settings form
//    says so (ModSecretsState.persistent = false).
//
// Nothing here is imported unless the app runs natively: on the web the desktop bridge is absent and
// the manager keeps its desktop-only notice.

// src/stores/useDesktopSettingsStore.ts keeps the master switch under this key.
const MOD_SYSTEM_ENABLED_KEY = 'mod_system_enabled';
const MODS_DIRECTORY = 'mods';
// Two places a user can fill: the app's private data directory, and the app's external files
// directory (`Android/data/<package>/files/mods`), which a file manager on the phone can write to.
const MODS_ROOTS: ReadonlyArray<{ directory: Directory; label: string }> = [
    { directory: Directory.Data, label: 'app data' },
    { directory: Directory.External, label: 'external files' },
];
const ENABLED_KEY_PREFIX = 'android_mod_enabled:';
const STORAGE_KEY_PREFIX = 'android_mod_storage:';
const SECRET_KEY_PREFIX = 'android_mod_secret:';

export type AndroidModsBridge = NonNullable<NonNullable<typeof window.electron>['mods']>;

const isNative = (): boolean => {
    try {
        return Capacitor.isNativePlatform();
    } catch {
        return false;
    }
};

export const isAndroidModsAvailable = (): boolean => isNative();

/** Whether mods load at all: the master switch, stored by the settings store. */
const modSystemEnabled = (): boolean => {
    try {
        return localStorage.getItem(MOD_SYSTEM_ENABLED_KEY) === 'true';
    } catch {
        return false;
    }
};

const readJson = <T,>(key: string, fallback: T): T => {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) as T : fallback;
    } catch {
        return fallback;
    }
};

const writeJson = (key: string, value: unknown): void => {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // Storage full or unavailable: this session keeps the value in the mod's own memory only.
    }
};

const isEnabled = (modId: string): boolean => {
    try {
        return localStorage.getItem(ENABLED_KEY_PREFIX + modId) === 'true';
    } catch {
        return false;
    }
};

const setEnabledFlag = (modId: string, enabled: boolean): void => {
    try {
        localStorage.setItem(ENABLED_KEY_PREFIX + modId, String(enabled));
    } catch {
        // Nothing to do: the mod is loaded for this session either way.
    }
};

/** A cheap content digest, so an edited client is a different module (as the desktop's URL hash is). */
const digestOf = (text: string): string => {
    let hash = 5381;
    for (let index = 0; index < text.length; index += 1) {
        hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
    }
    return (hash >>> 0).toString(36);
};

// One blob: URL per module content. Kept for the session: a mod that is disabled and enabled again
// re-imports the same module, which the browser already has.
const clientUrls = new Map<string, string>();
const clientUrlOf = (modId: string, code: string): string => {
    const key = `${modId}:${digestOf(code)}`;
    const known = clientUrls.get(key);
    if (known) return known;
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    clientUrls.set(key, url);
    return url;
};

/** `base` is a directory (ends with '/'); joins `specifier`, then walks back one level per `..`. */
const resolveRelativePath = (base: string, specifier: string): string | null => {
    const parts = `${base}${specifier}`.split('/');
    const out: string[] = [];
    for (const part of parts) {
        if (!part || part === '.') continue;
        if (part === '..') {
            if (out.length === 0) return null;
            out.pop();
            continue;
        }
        out.push(part);
    }
    return out.join('/');
};

const directoryOf = (file: string): string => (file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '');

// Every specifier a module imports, in the forms JavaScript writes them: static imports and
// re-exports (from), bare imports (import 'x'), and dynamic ones (import('x')).
const SPECIFIER_PATTERN = /\b(?:from|import)\s*(?:\(\s*)?['"]([^'"]+)['"]\s*\)?/g;

const specifiersOf = (code: string): string[] => {
    const found = new Set<string>();
    for (const match of code.matchAll(SPECIFIER_PATTERN)) found.add(match[1]);
    return [...found];
};

const replaceSpecifier = (code: string, from: string, to: string): string => (
    code.split(`'${from}'`).join(`'${to}'`).split(`"${from}"`).join(`"${to}"`)
);

/**
 * A mod's `client` entry, with its own relative imports turned into blob: URLs.
 *
 * The desktop serves a mod from `folia-mod://<id>/`, so `import './stage.mjs'` resolves beside the
 * entry. A blob: URL has no directory to resolve against, so each relative specifier is resolved
 * here, the module it names built the same way, and the text rewritten to point at its blob: URL.
 * Bare specifiers are left alone (the desktop resolves them the same way, from the page's own
 * module graph).
 */
const buildClientModuleUrl = async (
    modFolder: string,
    directory: Directory,
    entry: string,
): Promise<string | null> => {
    const built = new Map<string, string>();
    const visiting = new Set<string>();

    const build = async (file: string): Promise<string | null> => {
        const known = built.get(file);
        if (known) return known;
        // A cycle (a.mjs <-> b.mjs) cannot be made of blob: URLs; the second side is skipped and the
        // module sees an unresolved specifier, which is what it would have done without those files.
        if (visiting.has(file)) return built.get(file) ?? null;
        const code = await readTextFile(`${MODS_DIRECTORY}/${modFolder}/${file}`, directory);
        if (!code) return null;
        visiting.add(file);
        let rewritten = code;
        for (const specifier of specifiersOf(code)) {
            if (!specifier.startsWith('.')) continue;
            const resolved = resolveRelativePath(directoryOf(file), specifier);
            if (!resolved) continue;
            const candidates = [resolved, `${resolved}.mjs`, `${resolved}.js`, `${resolved}/index.mjs`, `${resolved}/index.js`];
            let url: string | null = null;
            for (const candidate of candidates) {
                url = await build(candidate);
                if (url) break;
            }
            if (url) rewritten = replaceSpecifier(rewritten, specifier, url);
        }
        visiting.delete(file);
        const url = clientUrlOf(`${modFolder}/${file}`, rewritten);
        built.set(file, url);
        return url;
    };

    return build(entry);
};

interface AndroidModManifest {
    id?: unknown;
    name?: unknown;
    version?: unknown;
    author?: unknown;
    description?: unknown;
    permissions?: unknown;
    experimental?: unknown;
    embedOrigins?: unknown;
    folia?: unknown;
    main?: unknown;
    client?: unknown;
}

const stringList = (value: unknown): string[] => (
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
);

const textOf = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

const readTextFile = async (path: string, directory: Directory): Promise<string | null> => {
    try {
        const result = await Filesystem.readFile({ path, directory, encoding: Encoding.UTF8 });
        return typeof result.data === 'string' ? result.data : null;
    } catch {
        return null;
    }
};

/** One mod folder, from its manifest and files. Null when it holds no readable `mod.json`. */
const readMod = async (folder: string, directory: Directory, loadOrder: number): Promise<ModRuntimeInfo | null> => {
    const manifestText = await readTextFile(`${MODS_DIRECTORY}/${folder}/mod.json`, directory);
    if (!manifestText) return null;
    let manifest: AndroidModManifest;
    try {
        manifest = JSON.parse(manifestText) as AndroidModManifest;
    } catch {
        return null;
    }
    const modId = textOf(manifest.id) ?? folder;
    const clientEntry = textOf(manifest.client);
    const enabled = isEnabled(modId);
    let clientUrl: string | null = null;
    if (clientEntry) {
        clientUrl = await buildClientModuleUrl(folder, directory, clientEntry);
    }
    return {
        id: modId,
        name: textOf(manifest.name) ?? modId,
        version: textOf(manifest.version),
        author: textOf(manifest.author),
        description: textOf(manifest.description),
        permissions: stringList(manifest.permissions),
        status: !enabled ? 'disabled' : clientEntry && !clientUrl ? 'error' : 'loaded',
        error: enabled && clientEntry && !clientUrl ? 'the client entry could not be read' : null,
        enabled,
        trustStale: false,
        signature: { status: 'unsigned', reason: null, keyId: null, keyLabel: null, signedAt: null },
        devSource: false,
        experimental: stringList(manifest.experimental),
        embedOrigins: stringList(manifest.embedOrigins),
        folia: textOf(manifest.folia),
        // A Node entry cannot run here; the field stays true so the panel says the mod has one.
        hasMain: textOf(manifest.main) !== null,
        clientUrl,
        loadOrder,
    };
};

/** Every mod folder found in the places a user can fill, one entry per mod id (app data first). */
const listAndroidMods = async (): Promise<ModRuntimeInfo[]> => {
    const mods = new Map<string, ModRuntimeInfo>();
    let loadOrder = 0;
    for (const root of MODS_ROOTS) {
        let folders: string[] = [];
        try {
            const listing = await Filesystem.readdir({ path: MODS_DIRECTORY, directory: root.directory });
            folders = listing.files.filter(entry => entry.type === 'directory').map(entry => entry.name);
        } catch {
            continue;
        }
        for (const folder of folders) {
            const mod = await readMod(folder, root.directory, loadOrder);
            if (!mod || mods.has(mod.id)) continue;
            mods.set(mod.id, mod);
            loadOrder += 1;
        }
    }
    return [...mods.values()].sort((left, right) => left.name.localeCompare(right.name));
};

const FFMPEG_UNAVAILABLE: ModFfmpegStatus = { available: false, path: null, version: null, candidates: [] };

const listeners = {
    mods: new Set<(mods: ModRuntimeInfo[]) => void>(),
    logs: new Set<(entry: ModLogEntry) => void>(),
    rpc: new Set<(message: ModRpcMessage) => void>(),
    secrets: new Set<(change: ModSecretChange) => void>(),
};

const notifyMods = async (): Promise<ModRuntimeInfo[]> => {
    const mods = await listAndroidMods();
    listeners.mods.forEach(listener => listener(mods));
    return mods;
};

const storageKeyOf = (modId: string): string => STORAGE_KEY_PREFIX + modId;
const secretKeyOf = (modId: string): string => SECRET_KEY_PREFIX + modId;

const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = '';
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
    }
    return btoa(binary);
};

/** An entry name safe to join under the mods folder: no `..`, no absolute path, no drive letter. */
const safeEntryPath = (name: string): string | null => {
    const cleaned = name.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!cleaned || cleaned.startsWith('/') || /^[a-zA-Z]:/.test(cleaned)) return null;
    if (cleaned.split('/').some(part => part === '..')) return null;
    return cleaned;
};

/**
 * Installs a mod from the bytes of a .zip, the Android stand-in for the desktop's
 * `installModFromZip(path)`: the archive is unpacked in the window and written under the app's
 * external `mods/` folder, where the list is read from.
 */
export const installAndroidModFromZipBytes = async (bytes: Uint8Array): Promise<{ ok: boolean; id?: string; error?: string }> => {
    let files: Record<string, Uint8Array>;
    try {
        files = unzipSync(bytes);
    } catch {
        return { ok: false, error: 'install-corrupt-zip' };
    }
    const names = Object.keys(files);
    if (names.length === 0) return { ok: false, error: 'install-empty-zip' };
    const manifestName = names.find(name => /(^|\/)mod\.json$/.test(name));
    if (!manifestName) return { ok: false, error: 'install-no-manifest' };
    const root = manifestName.slice(0, manifestName.length - 'mod.json'.length);
    let manifest: AndroidModManifest;
    try {
        manifest = JSON.parse(new TextDecoder().decode(files[manifestName])) as AndroidModManifest;
    } catch {
        return { ok: false, error: 'install-no-manifest' };
    }
    const folderName = safeEntryPath(root)?.replace(/\/$/, '')?.split('/').pop();
    const modId = textOf(manifest.id) ?? folderName;
    if (!modId || !/^[a-zA-Z0-9._-]+$/.test(modId)) return { ok: false, error: 'install-unsafe-path' };
    for (const name of names) {
        if (!name.startsWith(root)) return { ok: false, error: 'install-unsafe-path' };
        const relative = safeEntryPath(name.slice(root.length));
        if (!relative) return { ok: false, error: 'install-unsafe-path' };
        const payload = bytesToBase64(files[name]);
        let written = false;
        for (const where of MODS_ROOTS) {
            try {
                await Filesystem.writeFile({
                    path: `${MODS_DIRECTORY}/${modId}/${relative}`,
                    directory: where.directory,
                    recursive: true,
                    data: payload,
                });
                written = true;
                break;
            } catch (error) {
                console.warn('[Mods] could not write a mod file', { root: where.label, name, error: String(error) });
            }
        }
        if (!written) return { ok: false, error: 'install-write-failed' };
    }
    console.info('[Mods] installed', { id: modId, files: names.length });
    try {
        await notifyMods();
    } catch (error) {
        console.warn('[Mods] installed, but the list could not be re-read', String(error));
    }
    return { ok: true, id: modId };
};

/** Bytes localStorage holds for one prefix's values, so a mod's usage row is not a bare zero. */
const localStorageBytes = (prefix: string): number => {
    let bytes = 0;
    try {
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (!key || !key.startsWith(prefix)) continue;
            bytes += key.length + (localStorage.getItem(key)?.length ?? 0);
        }
    } catch {
        return 0;
    }
    // UTF-16 characters to bytes, as the desktop reports file sizes.
    return bytes * 2;
};

let runtimeSnapshot: ModRuntimeSnapshot | null = null;

/**
 * The object src/mods/ipc.ts reads instead of `window.electron.mods` when there is no Electron
 * bridge. Every method mirrors the preload's signature; the few that cannot work here say so.
 */
export const createAndroidModsBridge = (): AndroidModsBridge => {
    // The external folder is where a file manager on the phone can put mods; make it before anyone
    // looks for it, so the path in the manager's notice exists.
    void Filesystem.mkdir({ path: MODS_DIRECTORY, directory: Directory.External, recursive: true }).catch(() => {});
    return {
        listMods: async (): Promise<ModsListPayload> => ({
        mods: modSystemEnabled() ? await listAndroidMods() : [],
        ffmpeg: FFMPEG_UNAVAILABLE,
        directories: MODS_ROOTS.map(root => `${MODS_DIRECTORY}/${root.label}`),
        startSkipped: false,
    }),

    getModCallStats: async (): Promise<{ stats: Record<string, ModMainCallStats> }> => ({ stats: {} }),

    reportModsStartSettled: async (): Promise<void> => {},
    reportModsStartAlive: async (): Promise<void> => {},

    setModEnabled: async (modId: string, enabled: boolean): Promise<ModSetEnabledResult> => {
        if (!modSystemEnabled()) return { ok: false, error: 'mod-system-disabled', mods: [] };
        setEnabledFlag(modId, enabled);
        return { ok: true, mods: await notifyMods() };
    },

    reloadMods: async (): Promise<{ mods: ModRuntimeInfo[] }> => ({ mods: await notifyMods() }),

    cancelExport: async (): Promise<void> => {},

    // The main entry owns rpc handlers; without it there is nothing to answer.
    invokeModRpc: async () => ({ ok: false, error: 'no-main-entry' }),

    invokeModStorage: async (
        modId: string,
        operation: 'get' | 'set' | 'has' | 'delete' | 'keys',
        key?: string,
        value?: unknown,
    ) => {
        const data = readJson<Record<string, unknown>>(storageKeyOf(modId), {});
        if (operation === 'keys') return { ok: true, result: Object.keys(data) };
        if (operation === 'set') {
            if (typeof key !== 'string') return { ok: false, error: 'invalid-key' };
            data[key] = value;
            writeJson(storageKeyOf(modId), data);
            return { ok: true };
        }
        if (operation === 'has') return { ok: true, result: typeof key === 'string' && key in data };
        if (operation === 'delete') {
            if (typeof key !== 'string') return { ok: false, error: 'invalid-key' };
            delete data[key];
            writeJson(storageKeyOf(modId), data);
            return { ok: true };
        }
        return { ok: true, result: typeof key === 'string' ? data[key] : data };
    },

    invokeModSecrets: async (
        modId: string,
        operation: 'get' | 'has' | 'set' | 'declare' | 'state',
        key?: string | readonly string[],
        value?: string | null,
    ) => {
        const data = readJson<Record<string, string>>(secretKeyOf(modId), {});
        if (operation === 'state') {
            const state: ModSecretsState = { persistent: false, stored: Object.keys(data) };
            return { ok: true, result: state };
        }
        if (operation === 'declare') {
            // Declared keys are not stored here; the form asks `state` for what holds a value.
            return { ok: true };
        }
        if (typeof key !== 'string') return { ok: false, error: 'invalid-key' };
        if (operation === 'has') return { ok: true, result: key in data };
        if (operation === 'get') return { ok: true, result: data[key] ?? null };
        if (operation === 'set') {
            if (value === null || value === undefined) delete data[key];
            else data[key] = value;
            writeJson(secretKeyOf(modId), data);
            listeners.secrets.forEach(listener => listener({ modId, key }));
            return { ok: true };
        }
        return { ok: true, result: data[key] ?? null };
    },

    // The browser has the network already; the mod layer has checked the permission and the URL.
    invokeModNetFetch: async (_modId: string, url: string, init: unknown) => {
        try {
            const response = await fetch(url, (init ?? undefined) as RequestInit | undefined);
            const body = await response.text();
            return {
                ok: true,
                result: {
                    status: response.status,
                    headers: Object.fromEntries(response.headers.entries()),
                    body,
                },
            };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    },

    // A picker on the page, standing in for the desktop's open dialog; the file comes back as a
    // blob: URL for this session only.
    invokeModPickFile: async (_modId: string, accept: string) => new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.style.display = 'none';
        input.addEventListener('change', () => {
            const file = input.files?.[0];
            input.remove();
            resolve(file
                ? { ok: true, result: { url: URL.createObjectURL(file), name: file.name } }
                : { ok: true, result: null });
        });
        document.body.appendChild(input);
        input.click();
    }),

    invokeModRestoreFile: async () => ({ ok: true, result: null }),
    invokeModReleaseFile: async () => ({ ok: true }),

    pushRuntimeSnapshot: async (snapshot: ModRuntimeSnapshot): Promise<void> => {
        runtimeSnapshot = snapshot;
    },

    getFfmpegStatus: async (): Promise<{ ffmpeg: ModFfmpegStatus }> => ({ ffmpeg: FFMPEG_UNAVAILABLE }),

    openModsDirectory: async () => ({
        ok: false,
        error: 'android-mod-folder',
        // The panel prints this path itself, so the user knows where a file manager puts mods.
        directory: `Android/data/ti.folia.ming/files/${MODS_DIRECTORY}`,
    }),

    // Unpacking a zip needs a native unzip; the panel's drag-and-drop install is desktop-only.
    installModFromZip: async () => ({ ok: false, error: 'android-install-unsupported' }),

    // The phone's install path: the picker hands over the zip's bytes, unpacked here.
    installModFromZipFile: async (file: File) => (
        installAndroidModFromZipBytes(new Uint8Array(await file.arrayBuffer()))
    ),

    getModStorageUsage: async (modId: string): Promise<ModStorageUsageResult> => ({
        ok: true,
        data: localStorageBytes(storageKeyOf(modId)) + localStorageBytes(secretKeyOf(modId)),
        cache: 0,
    }),

    clearModCache: async (): Promise<ModClearCacheResult> => ({ ok: true, cleared: 0 }),

    onModsStateChanged: (callback: (mods: ModRuntimeInfo[]) => void) => {
        listeners.mods.add(callback);
        return () => {
            listeners.mods.delete(callback);
        };
    },
    onExportProgress: () => () => {},
    onModLog: (callback: (entry: ModLogEntry) => void) => {
        listeners.logs.add(callback);
        return () => {
            listeners.logs.delete(callback);
        };
    },
    onModRpcMessage: (callback: (message: ModRpcMessage) => void) => {
        listeners.rpc.add(callback);
        return () => {
            listeners.rpc.delete(callback);
        };
    },
    onModSecretChanged: (callback: (change: ModSecretChange) => void) => {
        listeners.secrets.add(callback);
        return () => {
            listeners.secrets.delete(callback);
        };
    },
    };
};

let installed: AndroidModsBridge | null = null;

/** The bridge this build answers with, or null off the native app (the web keeps its notice). */
export const androidModsBridge = (): AndroidModsBridge | null => {
    if (!isNative()) return null;
    installed ??= createAndroidModsBridge();
    return installed;
};

/** The folder a user fills, for the notice the panel shows. */
export const ANDROID_MODS_DIRECTORY_LABEL = MODS_DIRECTORY;
