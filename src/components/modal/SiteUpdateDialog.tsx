import React from 'react';
import { useTranslation } from 'react-i18next';
import { Download } from 'lucide-react';
import { Sheet, SheetButton } from '../shared/Sheet';
import { openOutsideLink } from '../../utils/system/outsideLink';
import { useAppUpdatePromptStore } from '../../stores/useAppUpdatePromptStore';

// src/components/modal/SiteUpdateDialog.tsx
// 「站点上有新版本」提示：站点上的版本号、更新说明，以及两颗按钮——
// 去浏览器里下载，或者跳过（跳过之后第二天才会再提）。
//
// 下载地址由站点给出（`version.json` 的 downloadUrl，没有就是下载页），
// 一律交给系统浏览器打开：在 App 内打开会盖住播放器，也让用户回不来。

type SiteUpdateDialogProps = {
    isOpen: boolean;
    isDaylight: boolean;
    onClose: () => void;
};

const SiteUpdateDialog: React.FC<SiteUpdateDialogProps> = ({ isOpen, isDaylight, onClose }) => {
    const { t } = useTranslation();
    const version = useAppUpdatePromptStore(state => state.pendingVersion);
    const notes = useAppUpdatePromptStore(state => state.pendingNotes);
    const downloadUrl = useAppUpdatePromptStore(state => state.pendingDownloadUrl);
    const skipVersion = useAppUpdatePromptStore(state => state.skipVersion);
    const appVersion = typeof __APP_VERSION__ === 'undefined' ? null : __APP_VERSION__;

    const handleDownload = () => {
        void openOutsideLink(downloadUrl).catch(() => {
            // 打不开浏览器不算走完：窗口留着，让用户自己再点一次。
        });
        if (version) skipVersion(version, downloadUrl, notes);
        onClose();
    };

    const handleSkip = () => {
        if (version) skipVersion(version, downloadUrl, notes);
        onClose();
    };

    return (
        <Sheet
            isOpen={isOpen}
            onClose={handleSkip}
            isDaylight={isDaylight}
            size="s"
            title={t('siteUpdate.title')}
            subtitle={version ? t('siteUpdate.found', { version }) : undefined}
            titleLead={<Download size={16} aria-hidden="true" />}
            footer={(
                <>
                    <SheetButton onClick={handleSkip} data-testid="site-update-skip">{t('siteUpdate.skip')}</SheetButton>
                    <SheetButton variant="primary" onClick={handleDownload} data-testid="site-update-download">
                        {t('siteUpdate.download')}
                    </SheetButton>
                </>
            )}
            footerNote={appVersion ? t('siteUpdate.current', { version: appVersion }) : undefined}
        >
            <div data-testid="site-update-dialog" className="space-y-3">
                <p className="text-[13px] leading-[21px] text-[color:var(--st-t1)]">
                    {notes || t('siteUpdate.defaultNotes')}
                </p>
                <p className="text-xs leading-[19px] text-[color:var(--st-t2)]">
                    {t('siteUpdate.skipHint')}
                </p>
            </div>
        </Sheet>
    );
};

export default SiteUpdateDialog;
