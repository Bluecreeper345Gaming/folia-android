# 酷狗音乐 VIP 歌曲无法播放 —— 修复说明

## 一、故障现象

- 账号已是酷狗 VIP，普通（非会员）歌曲可以正常播放。
- 选择 VIP 歌曲后：界面显示开始播放，约 0.3～1 秒后自动停止（`playing=false`），没有弹出任何"播放失败"提示。
- 同一首歌重复点播会反复出现"开始 → 立刻停止"，且日志里没有 `OnlineFailure`、没有媒体解码错误。

## 二、根因

酷狗取链本身是成功的，问题出在**取到链接之后、交给播放器之前**的一步"协议改写"。

1. 取链接口（扩展层，`/api/kg/song/url`）对会员曲目返回的地址是 VIP CDN：

   ```
   http://fs.youthandroid2.kugou.com/202610240014/xxxxxxxx.mp3
   ```

   日志证据（`folia-runtime.log`）：

   ```
   [KuGouProvider] playback:url-resolved
     {"scheme":"http:","host":"fs.youthandroid2.kugou.com","ext":"mp3"}
   ```

2. 播放前所有在线地址都会经过 `toSafeRemoteUrl()` 归一化。该函数会把所有
   `fs.*.kugou.com` 的 `http://` **强制改写成 `https://`**（目的是规避 Web/PWA 的混合内容限制）。

3. 但 `fs.youthandroid2.kugou.com`（酷狗 VIP 专用 CDN）**根本没有监听 TLS**：

   ```
   curl https://fs.youthandroid2.kugou.com/   → 000（TLS/连接直接失败）
   curl http://fs.youthandroid2.kugou.com/    → 403（HTTP 端口正常响应）
   ```

   于是播放器拿到的是 `https://fs.youthandroid2.kugou.com/...`，连接立刻失败，
   `<audio>` 加载被立即中止，于是表现为"刚开始播放就停"，也不会产生业务层的失败提示。

普通歌曲的地址来自能正常走 https 的 CDN 域名，所以一直听不出问题 —— 这就是"只有 VIP 歌不能播"的原因。

## 三、修改的文件与具体位置

### 1. `src/utils/appPlaybackHelpers.ts`（核心修复）

- 位置：文件中部，`getAudioSrcKind` 之后、`toSafeRemoteUrl` 之前，新增一个运行时判断函数。

- 新增内容：

```ts
// 原生 App（Capacitor Android/iOS）：与 Electron 一致，保留酷狗的原始 HTTP 媒体地址。
const isNativePlaybackRuntime = (): boolean => (
    typeof window !== 'undefined'
    && Boolean((window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.())
);
```

- 修改点：`toSafeRemoteUrl()` 内 `fs.*.kugou.com` 的 http→https 改写分支。

  修改前：

```ts
        if (
            parsedUrl.protocol === 'http:' &&
            parsedUrl.hostname.startsWith('fs.') &&
            parsedUrl.hostname.endsWith('.kugou.com')
        ) {
            return normalizedUrl.replace(/^http:/, 'https:');
        }
```

  修改后：

```ts
        if (
            parsedUrl.protocol === 'http:' &&
            parsedUrl.hostname.startsWith('fs.') &&
            parsedUrl.hostname.endsWith('.kugou.com')
        ) {
            // 酷狗的 fs 媒体域名多数只开 HTTP：VIP 的 fs.youthandroid2.kugou.com 完全没有 TLS 监听，
            // 改写成 https 会直接连不上（播放开始几百毫秒后就停）。原生端与 Electron 一样保留原协议，
            // WebView 由 Capacitor 的 allowMixedContent 放行 http 媒体。
            if (isNativePlaybackRuntime()) return normalizedUrl;
            return normalizedUrl.replace(/^http:/, 'https:');
        }
```

要点：
- 只在 **原生 App**（APK）里保留原始 `http://`；桌面 Electron 原本就走另一条分支（保留 http），浏览器/PWA 仍然改写为 https，行为不变。
- 只对 `fs.*.kugou.com` 生效，不影响网易云 `music.126.net` 等其他平台的 https 归一化。

### 2. `src/services/onlineMusic/kugou/kugouProvider.ts`（诊断日志，保留）

- 位置：取链循环内，`console.info('[KuGouProvider] playback:url-resolved', ...)` 这一条日志。

- 修改点：在原字段（`hash` / `requestedQuality` / `resolvedQuality` / `requestVariant`）之外，追加三个只描述地址形态的字段，便于下次秒级定位同类问题：

```ts
                            console.info('[KuGouProvider] playback:url-resolved', {
                                hash,
                                requestedQuality: quality,
                                resolvedQuality: candidateQuality,
                                requestVariant: requestVariant.name,
                                // 只看形态：https/http、域名、时长参数，判断是不是被清晰度策略或防外链挡下。
                                scheme: url.slice(0, url.indexOf(':') + 1),
                                host: (() => { try { return new URL(url).host; } catch { return ''; } })(),
                                ext: (url.match(/\.(mp3|m4a|flac|ogg|ape)(\?|$)/i)?.[1] ?? '').toLowerCase(),
                            });
```

注意：这里**不打印完整地址**（酷狗地址里带有时效 token），只打印协议、域名、扩展名。

### 3. 无需改动、但必须保持的两处配置（改回会导致复发）

- `android/app/src/main/AndroidManifest.xml`：`<application ... android:usesCleartextTraffic="true">` 必须保留。
- `capacitor.config.json`：

```json
  "android": { "allowMixedContent": true },
  "server": { "androidScheme": "https", "hostname": "localhost", "cleartext": false }
```

  `allowMixedContent: true` 是必须的：页面本身跑在 `https://localhost`，音频来自 `http://fs.*.kugou.com`，属于混合内容，必须由 WebView 放行。

## 四、排查过程中排除的方向（避免重复踩坑）

以下方向均已验证**不是**原因：

| 怀疑点 | 结论 |
| --- | --- |
| 账号没有会员 / 未登录 | 排除。日志 `loggedIn:true, isVip:true, hasVipToken:true` |
| `vip_token` / `app_token` 缺失 | 排除。参考层已带上会员凭证，且能拿到 VIP CDN 地址 |
| 酷狗风控 / 签名错误 | 排除。取链返回 200 且有 `play_url` |
| `play/getdata` 返回的是试听片段 | 排除。地址是完整曲目（`ext:mp3`），且是 VIP 专属域名 |
| 需要换成 v5 / `login_by_token` 换证 | 无需。当前扩展层的 `android-fast-v5` 通道已能取到会员地址 |

> 补充：曾按"缺 vip_token → 走 v5 取链"的思路改动过 `src/audioNative/kugou.ts`，实测无效后已全部回退。该文件当前与修复前一致，**不要**再把 `play/getdata` 改成 v5 主通道。

## 五、验证方式

1. `npx vite build` → `npx cap sync android` → `cd android && gradlew.bat assembleDebug` → `adb install -r app-debug.apk`。
2. 在酷狗里播放一首 VIP 歌曲，观察是否连续出声（而不是几百毫秒就停）。
3. 设备日志确认（路径 `/sdcard/Android/data/ti.folia.ming/files/logs/folia-runtime.log`）：

   ```
   [KuGouProvider] playback:url-resolved {"scheme":"http:","host":"fs.youthandroid2.kugou.com",...}
   [service-lifecycle] service-start — playing=true      ← 持续为 true，不再立刻变 false
   ```

   修复后实测：单曲连续播放 36 秒以上（`playing=true` 保持），到用户手动停止才变 `playing=false`。

## 六、同类问题的一分钟判断法

看日志里 `playback:url-resolved` 的 `scheme` 与 `host`：

- `scheme:"http:"` + `host:"fs.*.kugou.com"` → 若播放秒停，先测该域名 `https` 是否可连（多数不可），即本文的根因。
- `scheme:"https:"` 且宿主是 `fs.*.kugou.com` → 说明改写逻辑被改回，需要检查 `toSafeRemoteUrl`。
- 完全无 `playback:url-resolved` 行 → 问题在取链（登录态 / 权限），走 `playback:no-url` 的 `error` 字段继续查。
