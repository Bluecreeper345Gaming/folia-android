import React, { useSyncExternalStore } from 'react';
import { FolderOpen, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ConsoleLogPanel from '../../../shared/ConsoleLogPanel';
import {
    chooseLocalLogDir,
    getDebugModuleSnapshot,
    openDebugLogsFolder,
    resetLocalLogDir,
    setDebugModuleState,
    subscribeToDebugModule,
    type DebugLogMode,
} from '../../../../services/debug/debugModule';
import { isConsoleCaptureEnabled, setConsoleCaptureEnabled, subscribeToConsoleLog } from '../../../../utils/consoleLogBuffer';
import { setIsMemoryMonitorVisible } from '../../../../stores/useAppChromeStore';
import { Button, Group, Keys, Reveal, Row, Segmented, Toggle, option, useSettingsKitTheme, type SettingsGroupDef, type SettingsOptionDef } from '../kit';

// src/components/modal/settings/pages/DeveloperPage.tsx
// The 开发者 page: the debug module's switches. Two recordings, each with a switch for whether
// anything is kept at all and, under it, whether what is kept is also written to a file: the
// session log (with the log itself to read, filter and copy) and the memory monitor. The packaged
// desktop app has no console, so this page and the two shortcuts printed on it are the way in.
// The log viewer is the panel the Alt+Shift+D overlay also shows (shared/ConsoleLogPanel).

const TOOLS: SettingsGroupDef = { id: 'developerTools', titleKey: 'options.developerTools' };

const O = {
    sessionLog: option(TOOLS, 'consoleLogCapture', 'options.consoleLogCapture'),
    logToFile: option(TOOLS, 'debugLogsToFile', 'options.debugLogsToFile'),
    memoryMonitor: option(TOOLS, 'memoryMonitor', 'options.memoryMonitor'),
    memoryInterval: option(TOOLS, 'memoryMonitorInterval', 'options.memoryMonitorInterval'),
};

export const OPTIONS: SettingsOptionDef[] = Object.values(O);

const MEMORY_INTERVALS_MS = [1000, 2000, 5000, 15000];
const MEMORY_INTERVAL_CHOICES = MEMORY_INTERVALS_MS.map(interval => ({ value: String(interval), label: `${interval / 1000}s` }));

/** Where a recording is written: a path has no spaces, so it may break anywhere. */
const filePath = (path: string | null) => path && <span className="break-all">{path}</span>;

const DeveloperPage: React.FC = () => {
    const { t } = useTranslation();
    const { isDaylight } = useSettingsKitTheme();
    // Each is its own subscription: the switch has to answer for itself, also when the log's lines
    // did not change with it.
    const capturing = useSyncExternalStore(subscribeToConsoleLog, isConsoleCaptureEnabled);
    const debug = useSyncExternalStore(subscribeToDebugModule, getDebugModuleSnapshot);
    const modeChoices: Array<{ value: DebugLogMode; label: string }> = [
        { value: 'append', label: t('options.debugLogModeAppend') },
        { value: 'overwrite', label: t('options.debugLogModeOverwrite') },
    ];

    return (
        <Group def={TOOLS} bare foot={t('options.consoleLogConvention')}>
            <Row option={O.sessionLog} hint={t('options.consoleLogCaptureDesc')}>
                {/* 手机没有键盘：快捷键只作桌面提示，不在手机上显示。 */}
                {debug.available && <Keys keys={['Alt', 'Shift', 'D']} />}
                <Toggle checked={capturing} onChange={setConsoleCaptureEnabled} />
            </Row>
            {/* With the session log off nothing is kept, so there is nothing to write or to read. */}
            <Reveal when={capturing}>
                <Row sub option={O.logToFile} hint={filePath(debug.runtimeFile ?? debug.logsRoot)}>
                    {/* 桌面：打开文件所在目录；手机：换一个日志目录（SAF 自带授权）。 */}
                    {debug.available
                        ? <Button icon={FolderOpen} tip={t('options.debugLogsOpenFolder')} onClick={() => void openDebugLogsFolder('runtime')} />
                        : <Button icon={FolderOpen} tip={t('options.debugLogDirPick')} onClick={() => void chooseLocalLogDir()} />}
                    {!debug.available && debug.logDirCustom && (
                        <Button icon={RotateCcw} tip={t('options.debugLogDirReset')} onClick={() => void resetLocalLogDir()} />
                    )}
                    {/* 手机只有追加：写满就另存为第二份（folia-runtime.1.log），所以不给模式选择。 */}
                    {debug.available && (
                        <Segmented
                            value={debug.runtimeLogMode}
                            options={modeChoices}
                            onChange={mode => void setDebugModuleState({ runtimeLogMode: mode })}
                            disabled={!debug.filesAvailable || !debug.runtimeLogEnabled}
                        />
                    )}
                    <Toggle checked={debug.runtimeLogEnabled} onChange={enabled => void setDebugModuleState({ runtimeLogEnabled: enabled })} />
                </Row>
                <Row below={<ConsoleLogPanel isDaylight={isDaylight} className="rounded-lg bg-[var(--st-pv)]" listMaxHeightClass="max-h-[22rem]" />} />
            </Reveal>

            {/* 手机上这段由渲染进程自己采样（见 memorySamples 的本地采样器），所以不再是桌面专属。 */}
            <Row option={O.memoryMonitor} hint={t('options.memoryMonitorDesc')}>
                {/* 手机没有键盘，Alt+Shift+M 按不出来，这里给一个能点的入口。 */}
                {debug.memoryAvailable && !debug.available
                    ? <Button onClick={() => setIsMemoryMonitorVisible(true)}>{t('options.memoryMonitorOpen')}</Button>
                    : <Keys keys={['Alt', 'Shift', 'M']} />}
                <Toggle
                    checked={debug.memoryMonitorEnabled}
                    disabled={!debug.memoryAvailable}
                    onChange={enabled => void setDebugModuleState({ memoryMonitorEnabled: enabled })}
                />
            </Row>
            {/* No samples are taken with the monitor off, so no file is written and no interval runs. */}
            <Reveal when={debug.memoryMonitorEnabled}>
                {/* Named by `label`, not an option: the search already lists 写入本地文件 once, for the row above. */}
                <Row sub label={t('options.debugLogsToFile')} hint={filePath(debug.memoryFile ?? debug.logsRoot)}>
                    {debug.available
                        ? <Button icon={FolderOpen} tip={t('options.debugLogsOpenFolder')} onClick={() => void openDebugLogsFolder('memory')} />
                        : <Button icon={FolderOpen} tip={t('options.debugLogDirPick')} onClick={() => void chooseLocalLogDir()} />}
                    {!debug.available && debug.logDirCustom && (
                        <Button icon={RotateCcw} tip={t('options.debugLogDirReset')} onClick={() => void resetLocalLogDir()} />
                    )}
                    {debug.available && (
                        <Segmented
                            value={debug.memoryLogMode}
                            options={modeChoices}
                            onChange={mode => void setDebugModuleState({ memoryLogMode: mode })}
                            disabled={!debug.filesAvailable || !debug.memoryLogEnabled}
                        />
                    )}
                    <Toggle checked={debug.memoryLogEnabled} onChange={enabled => void setDebugModuleState({ memoryLogEnabled: enabled })} />
                </Row>
                <Row sub option={O.memoryInterval}>
                    <Segmented
                        value={String(debug.memoryIntervalMs)}
                        options={MEMORY_INTERVAL_CHOICES}
                        onChange={interval => void setDebugModuleState({ memoryIntervalMs: Number(interval) })}
                        disabled={!debug.memoryAvailable}
                    />
                </Row>
            </Reveal>
        </Group>
    );
};

export default DeveloperPage;
