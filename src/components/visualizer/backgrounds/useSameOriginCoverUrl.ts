import { useEffect, useState } from 'react';

// src/components/visualizer/backgrounds/useSameOriginCoverUrl.ts
// A cover the background modes can actually read.
//
// Monet's picture is made in a worker, and Nomand and Latent hand the cover to a shader as a
// texture: all three draw the pixels, so the image has to be the page's own - a canvas texture of a
// cross-origin image taints and fails. The platforms hand out covers on their CDNs (qq's
// y.gtimg.cn, qishui's douyinpic hosts), which send no CORS headers; on the desktop app there is no
// CORS, but the Android WebView blocks them, and the backgrounds then draw nothing (a black frame,
// with "no texture bound" in the log).
//
// So on the Android app the cover is fetched once per URL through the native bridge (the global
// fetch shim, src/audioNative/fetchShim.ts) and handed on as a blob: URL, which is same-origin.
// Everywhere else the URL is returned as it is: the desktop needs no copy, and the web build has no
// bridge to fetch through.

const isNativeApp = (): boolean => (
    typeof window !== 'undefined' && Boolean((window as any).Capacitor?.isNativePlatform?.())
);

export const useSameOriginCoverUrl = (coverUrl: string | null | undefined): string | null => {
    const [resolved, setResolved] = useState<string | null>(coverUrl ?? null);

    useEffect(() => {
        if (!coverUrl) {
            setResolved(null);
            return;
        }
        if (!isNativeApp() || !/^https?:/i.test(coverUrl)) {
            setResolved(coverUrl);
            return;
        }
        let cancelled = false;
        let objectUrl: string | null = null;
        // Until the copy is made the remote URL is still shown: a background that can use it as a
        // plain CSS image (Monet's raw cover fallback) has something to draw meanwhile.
        setResolved(coverUrl);
        void (async () => {
            try {
                const response = await fetch(coverUrl, { mode: 'cors' });
                if (!response.ok) return;
                const blob = await response.blob();
                if (cancelled) return;
                objectUrl = URL.createObjectURL(blob);
                setResolved(objectUrl);
            } catch {
                // The remote URL stays: the background falls back to its own colour/gradient.
            }
        })();
        return () => {
            cancelled = true;
            if (objectUrl) {
                // A beat later: a background that just took the URL may still be painting with it.
                const url = objectUrl;
                window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            }
        };
    }, [coverUrl]);

    return resolved;
};
