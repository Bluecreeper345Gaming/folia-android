// src/services/debug/memorySamples.ts
// The memory curve the monitor window draws, kept in the renderer.
//
// Bounded twice over, because a monitor that leaks is a joke at its own expense:
//
// - Only `HISTORY` points are retained, oldest dropped. At the default two-second sampling that is
//   twenty minutes of curve, which is longer than any question this answers.
// - Only the numbers the chart plots are retained. A full sample carries a row per process, and
//   keeping those for every point would be most of the memory this thing spends. The per-process
//   breakdown is a snapshot question, so only the latest sample keeps one.
//
// The file on disk has all of it. This is the live view, not the record.

/** One plotted point. Whole megabytes; the source is electron/debug/memoryMonitor.cjs. */
export interface MemoryPoint {
    at: number;
    totalWorkingSetMB: number;
    totalPrivateMB: number | null;
    rendererPrivateMB: number | null;
    rendererHeapUsedMB: number | null;
    cpuPercent: number;
    /** Open fd counts, not megabytes - plotted on their own scale. Linux only. */
    rendererFdCount: number | null;
    gpuFdCount: number | null;
}

export interface MemoryHistory {
    points: readonly MemoryPoint[];
    /** The whole most recent sample, per-process rows included, or null before the first one. */
    latest: DebugMemorySample | null;
}

const HISTORY = 600;
const EMPTY: MemoryHistory = { points: [], latest: null };

let history: MemoryHistory = EMPTY;
const listeners = new Set<() => void>();

export const getMemoryHistory = () => history;

export const subscribeToMemoryHistory = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};

export const clearMemoryHistory = () => {
    history = EMPTY;
    listeners.forEach(listener => listener());
};

/** Exported for the test; the app feeds this from the main process - see `installMemorySampleFeed`. */
export const recordMemorySample = (sample: DebugMemorySample) => {
    const point: MemoryPoint = {
        at: Date.parse(sample.at) || Date.now(),
        totalWorkingSetMB: sample.totalWorkingSetMB,
        totalPrivateMB: sample.totalPrivateMB,
        rendererPrivateMB: sample.rendererPrivateMB,
        rendererHeapUsedMB: sample.rendererHeapUsedMB,
        cpuPercent: sample.cpuPercent,
        rendererFdCount: sample.rendererFdCount ?? null,
        gpuFdCount: sample.gpuFdCount ?? null,
    };
    // A new array rather than a push: useSyncExternalStore compares by identity, and a list mutated
    // in place leaves the chart rendering data it believes is current.
    const points = history.points.concat(point);
    history = {
        points: points.length > HISTORY ? points.slice(points.length - HISTORY) : points,
        latest: sample,
    };
    listeners.forEach(listener => listener());
};

/**
 * Tells the main process what this process knows about itself, which is more than the metrics
 * table can see from outside.
 *
 * `app.getAppMetrics()` reports `privateBytes` on Windows only, and has never reported a JS heap at
 * all. Asked directly, a renderer has both on every platform - and this renderer is the biggest
 * process in the app, so it is the one where the gap mattered.
 *
 * Sent in reply to a sample rather than on a timer of its own: the sampling rate is the main
 * process's to decide and this way there is nothing to keep in step. The figures land in the NEXT
 * sample, which on a curve this slow is not visible.
 */
const reportSelf = async () => {
    const bridge = window.electron;
    if (!bridge?.debugRendererMemory || !bridge.debugReportRendererMemory) return;
    try {
        const report = await bridge.debugRendererMemory();
        if (!report) return;
        // Read here rather than in the preload: `performance.memory` is per-context, and the
        // context worth measuring is the one the app actually runs in.
        const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
        bridge.debugReportRendererMemory({
            ...report,
            heapUsedKB: heap ? Math.round(heap.usedJSHeapSize / 1024) : undefined,
        });
    } catch {
        // The window is going away, or the runtime has no such API. Its row keeps its nulls.
    }
};

let stop: (() => void) | null = null;

/**
 * Subscribes to the main process's samples. Idempotent; a no-op in the browser build.
 *
 * The subscription outlives the window that draws it, on purpose: closing the monitor window must
 * not stop the recording - that is what the switch in Settings is for. The cost of staying
 * subscribed while nothing is watching is one bounded array that the monitor stops filling the
 * moment the switch goes off.
 */
export const installMemorySampleFeed = () => {
    if (stop || typeof window === 'undefined') return;
    const electronStop = window.electron?.onDebugMemorySample?.(sample => {
        recordMemorySample(sample);
        void reportSelf();
    });
    // 手机（Android）没有 Electron 主进程，采样由此处自己定时做，见下面的 local sampler。
    stop = electronStop ?? (() => { stopLocalMemorySampling(); });
};

// ---- Android：没有 Electron 主进程时自己采样 --------------------------------------

type AndroidMemoryAnswer = {
    pid: number;
    pssMB: number;
    privateMB: number;
    javaHeapPssMB: number;
    javaHeapMB: number;
    javaHeapTotalMB: number;
    nativeHeapMB: number;
    systemFreeMB: number;
    systemTotalMB: number;
    uptimeSec: number;
};

export interface NativeDebugBridge {
    memoryInfo?: () => Promise<AndroidMemoryAnswer>;
    debugLogPaths?: () => Promise<{ dir: string; runtime: string; memory: string; custom?: boolean; default?: string }>;
    debugAppendLog?: (options: { kind: 'runtime' | 'memory'; text?: string; mode?: 'append' | 'overwrite' }) => Promise<{ path?: string }>;
    debugPickLogDir?: () => Promise<{ cancelled: boolean; dir?: string; error?: string }>;
    debugResetLogDir?: () => Promise<{ dir: string }>;
}

/** The native FoliaBridge, or null in the browser/desktop build. */
export const nativeCapacitor = (): NativeDebugBridge | null => {
    if (typeof window === 'undefined') return null;
    const capacitor = (window as unknown as {
        Capacitor?: {
            isNativePlatform?: () => boolean;
            Plugins?: { FoliaBridge?: NativeDebugBridge };
        };
    }).Capacitor;
    if (!capacitor?.isNativePlatform?.()) return null;
    return capacitor.Plugins?.FoliaBridge ?? null;
};

const androidMemory = async (): Promise<AndroidMemoryAnswer | null> => {
    const bridge = nativeCapacitor();
    if (!bridge) {
        console.warn('[debug] memoryInfo: FoliaBridge 不可用');
        return null;
    }
    try {
        return await bridge.memoryInfo?.() ?? null;
    } catch (error) {
        console.warn('[debug] memoryInfo 调用失败', error);
        return null;
    }
};

/** 与 Electron 主进程那边一致：跑着的这一轮里的峰值/谷值/均值。 */
const run = { peak: 0, floor: Infinity, sum: 0, samples: 0 };
let localTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 手机上的“写入本地文件”由 debugModule 装一个 sink 进来（它知道开关与写入模式）。
 * 采样这边只管把整条 sample 交出去，不关心它落地到哪里。
 */
let memoryLogSink: ((sample: DebugMemorySample) => void) | null = null;
export const setMemoryLogSink = (sink: ((sample: DebugMemorySample) => void) | null) => {
    memoryLogSink = sink;
};

const sampleOnce = async () => {
    const raw = await androidMemory();
    if (!raw) return;
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
    const heapMB = heap ? heap.usedJSHeapSize / (1024 * 1024) : null;
    const pss = Math.round(raw.pssMB);
    run.samples += 1;
    run.peak = Math.max(run.peak, pss);
    run.floor = Math.min(run.floor, pss);
    run.sum += pss;
    const sample: DebugMemorySample = {
        at: new Date().toISOString(),
        uptimeSec: Math.round(raw.uptimeSec),
        // 四条曲线各用一个不同的系统指标，这样既都在，也不会互相重合：
        // 工作集 = PSS（含共享页），私有 = private dirty，渲染私有 = Java 堆的 PSS。
        totalWorkingSetMB: pss,
        totalPrivateMB: Math.round(raw.privateMB),
        cpuPercent: 0,
        processCount: 1,
        peakMB: run.peak,
        floorMB: Number.isFinite(run.floor) ? run.floor : pss,
        avgMB: Math.round(run.sum / run.samples),
        samples: run.samples,
        mainHeapUsedMB: raw.javaHeapMB,
        mainHeapTotalMB: raw.javaHeapTotalMB,
        rendererHeapUsedMB: heapMB,
        rendererPrivateMB: Math.round(raw.javaHeapPssMB),
        rendererFdCount: null,
        gpuFdCount: null,
        systemFreeMB: Math.round(raw.systemFreeMB),
        systemTotalMB: Math.round(raw.systemTotalMB),
        processes: [{
            pid: raw.pid,
            type: 'Application',
            workingSetMB: pss,
            peakWorkingSetMB: run.peak,
            privateMB: pss,
            sharedMB: null,
            heapMB: raw.javaHeapMB,
            blinkMB: heapMB,
            cpuPercent: 0,
            fdCount: null,
        }],
    };
    recordMemorySample(sample);
    memoryLogSink?.(sample);
};

export const startLocalMemorySampling = (intervalMs: number) => {
    stopLocalMemorySampling();
    localTimer = setInterval(() => { void sampleOnce(); }, Math.max(500, intervalMs));
    void sampleOnce();
};

export const stopLocalMemorySampling = () => {
    if (localTimer) clearInterval(localTimer);
    localTimer = null;
};

