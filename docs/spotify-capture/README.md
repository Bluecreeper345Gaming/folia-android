# Spotify 接口实测（2026-10-22，真账号实跑）

这份文档回答 `src/services/onlineMusic/UPSTREAMS.md` 里一直空着的问题：「新的哈希从哪里读到」。

结论先说，有三条和现有代码不一致：

1. **`client-token` 已经不需要了。** 现在的网页播放器 bundle（`web-player.15cdd331.js` + 89 个路由 chunk）里搜不到 `client-token` / `clienttoken` 字样。实测只带 `Authorization: Bearer <token>` 就能打 pathfinder，`app-platform`、`origin`、`referer` 全都不需要。`spotifyAndroid.ts` 里那套 `ensureClientToken()` / 隐藏 WebView 抄 token 的逻辑是过时的。
2. **哈希不用再靠猜。** 全量在 bundle 里，抓一次就有 172 个 operation。
3. **公开 Web API 仍然 429。** `api.spotify.com/v1/me`、`/v1/search` 用同一个 token 都回 `429 API rate limit exceeded`，和 UPSTREAMS 里记的一致 —— pathfinder 是唯一路。

## 一、怎么拿到 token

OAuth 2.0 授权码 + PKCE，和 `spotifyAndroid.ts` 用的是同一个客户端：

| 项 | 值 |
| --- | --- |
| `client_id` | `65b708073fc0480ea92a077233ca87bd` |
| `redirect_uri` | `http://127.0.0.1:5588/login` |
| 授权页 | `https://accounts.spotify.com/authorize` |
| 换 token | `https://accounts.spotify.com/api/token` |

实测：起一个只听 `127.0.0.1:5588` 的本地服务，把授权链接丢给系统浏览器（`am start -a android.intent.action.VIEW -d '<url>'`），用户点一次「同意」后，`accounts.spotify.com` 会 302 到 `http://127.0.0.1:5588/login?code=...`，本地服务直接收下 code，再换 token。**不需要桌面版、不需要 WebView 截导航、不需要用户填密码**。

换回来的 token 带 24 个 scope（`user-library-read`、`playlist-read-private`、`user-top-read`、`user-read-playback-state` 等），`expires_in` 3600，refresh 用同一 `/api/token` 的 `grant_type=refresh_token`，不需要 client secret（PKCE 本就不需要）。

## 二、请求形状（实测最小值）

```
POST https://api-partner.spotify.com/pathfinder/v2/query
authorization: Bearer <access_token>
content-type: application/json

{
  "variables": { ... },
  "operationName": "<op>",
  "extensions": { "persistedQuery": { "version": 1, "sha256Hash": "<hash>" } }
}
```

实测细节：

- 只带 `authorization` + `content-type`，HTTP 200，正常返回。
- 加 `app-platform: WebPlayer`、`origin`、`referer`、`spotify-app-version` 也是 200，结果一样 —— 可选。
- `operationName` 其实几乎没用：**同一个 sha256Hash 被多个名字共用**（`home`/`homeSection` 同一个哈希，`fetchPlaylist`/`fetchPlaylistContents`/`fetchPlaylistMetadata` 同一个，`addToLibrary`/`removeFromLibrary` 同一个，`addToPlaylist`/`removeFromPlaylist` 同一个）。真正决定取哪份文档的是哈希。
- 变量按 GraphQL 校验，缺必填项会回 400 并点名变量，例如：
  `missing variable `$homeEndUserIntegration`: for required GraphQL type `HomeEndUserIntegration!``
  所以变量写错能立刻从错误信息里看出来。

## 三、Folia 要用的操作（全部 200 通过）

`✅` = 实测 HTTP 200；回包大小是这次抓到的真实响应体。

| operation | 结果 | 回包 | 顶层键 | 用途 |
| --- | --- | --- | --- | --- |
| `profileAttributes` | ✅ | 0.2 KB | `me` | 账号资料 |
| `fetchLibraryTracks` | ✅ | 0.1 KB | `me` | 点赞歌曲（分页） |
| `libraryV3` | ✅ | 0.5 KB | `me` | 库：歌单 / 专辑（`filters` 切换） |
| `home` | ✅ | 94.0 KB | `home` | 首页推荐 |
| `homeSection` | ✅ | 0.6 KB | `homeSections` | 首页某一块的下一批 |
| `queryWhatsNewFeed` | ✅ | 0.1 KB | `whatsNewFeedItems` | 关注艺人的新发行 |
| `browsePage` | ✅ | 3.9 KB | `browse` | Made For You 页（推荐核心） |
| `searchDesktop` | ✅ | 399.4 KB | `searchV2` | 搜索总入口：albumsV2 / artists / tracksV2 / playlists / users / episodes / podcasts / genres / topResultsV2 / chipOrder |
| `searchTracks` | ✅ | 46.9 KB | `searchV2` | 只搜歌曲 |
| `searchAlbums` | ✅ | 39.8 KB | `searchV2` | 只搜专辑 |
| `searchArtists` | ✅ | 33.9 KB | `searchV2` | 只搜艺人 |
| `searchPlaylists` | ✅ | 44.4 KB | `searchV2` | 只搜歌单 |
| `searchUsers` | ✅ | 9.3 KB | `searchV2` | 只搜用户 |
| `searchSuggestions` | ✅ | 47.7 KB | `searchV2` | 搜索联想 |
| `getTrack` | ✅ | 119.7 KB | `trackUnion` | 单曲详情 |
| `getAlbum` | ✅ | 19.5 KB | `albumUnion`, `meV2` | 专辑详情 + 曲目 |
| `queryArtistOverview` | ✅ | 93.3 KB | `artistUnion` | 艺人主页 |
| `queryArtistDiscographyAll` | ✅ | 58.1 KB | `artistUnion` | 艺人全部作品 |
| `queryArtistPlaylists` | ✅ | 1.0 KB | `artistUnion` | 艺人相关歌单 |
| `seoRecommendedTrackPlaylistDesktop` | ✅ | 0.1 KB | `seoRecommendedTrackPlaylist` | 「相似歌曲」歌单入口（这次是 null） |
| `browseAll` | ✅ | 25.2 KB | `browseStart` | 浏览全部 |
| `areEntitiesInLibrary` | ✅ | 0.1 KB | `lookup` | 是否已收藏 |
| `fetchPlaylist` | ✅ | 136.7 KB | `playlistV2` | 歌单详情 + 首屏曲目（Folia 主力） |
| `fetchPlaylistContents` | ✅ | 134.0 KB | `playlistV2` | 同上，同一个哈希 |
| `fetchPlaylistMetadata` | 400 | 0.2 KB | — | 必须带 `enableWatchFeedEntrypoint` |

### 变量形状（照抄 Folia 现在用的，实测都能过）

```jsonc
// profileAttributes
{}

// fetchLibraryTracks
{ "offset": 0, "limit": 10 }

// libraryV3
{ "filters": ["Playlists"], "order": null, "textFilter": "", "features": [],
  "limit": 20, "offset": 0, "flatten": true, "expandedFolders": [],
  "folderUri": null, "includeFoldersWhenFlattening": true }

// home —— 注意多了 homeEndUserIntegration，缺了就 400
{ "timeZone": "Asia/Shanghai", "sp_t": "",
  "homeEndUserIntegration": "INTEGRATION_WEB_PLAYER",
  "facet": "", "sectionItemsLimit": 10 }

// homeSection
{ "timeZone": "Asia/Shanghai", "sp_t": "",
  "homeEndUserIntegration": "INTEGRATION_WEB_PLAYER",
  "uri": "<某一块的 uri>", "sectionItemsOffset": 0, "sectionItemsLimit": 20 }

// browsePage（Made For You）
{ "uri": "spotify:page:0JQ5DAt0tbjZptfcdMSKl3",
  "pagePagination": { "offset": 0, "limit": 20 },
  "sectionPagination": { "offset": 0, "limit": 10 },
  "browseEndUserIntegration": "INTEGRATION_WEB_PLAYER",
  "includeEpisodeContentRatingsV2": true }

// searchDesktop
{ "searchTerm": "daft punk", "offset": 0, "limit": 20, "numberOfTopResults": 20,
  "includeAudiobooks": true, "includeAuthors": false, "includePreReleases": false }

// searchTracks
{ "searchTerm": "daft punk", "offset": 0, "limit": 20, "includePreReleases": false,
  "numberOfTopResults": 20, "includeAudiobooks": true, "includeAuthors": false }

// searchAlbums / searchArtists / searchPlaylists / searchUsers
{ "searchTerm": "daft punk", "offset": 0, "limit": 20, "numberOfTopResults": 20 }

// getTrack
{ "uri": "spotify:track:<id>" }

// getAlbum
{ "uri": "spotify:album:<id>", "locale": "", "offset": 0, "limit": 50 }

// queryArtistOverview
{ "uri": "spotify:artist:<id>", "locale": "", "preReleaseV2": false }

// queryArtistDiscographyAll
{ "uri": "spotify:artist:<id>", "offset": 0, "limit": 50, "order": "DATE_DESC" }

// fetchPlaylist
{ "uri": "spotify:playlist:<id>", "offset": 0, "limit": 30, "enableWatchFeedEntrypoint": false }

// areEntitiesInLibrary
{ "uris": ["spotify:album:<id>"] }
```

## 四、哈希：新的 vs Folia 里钉的

`2026-10-08` 那批哈希**大多仍然有效**（Spotify 保留旧文档），但新文档字段更多，而且旧 `home` 和新变量不匹配。建议换新。

| operation | Folia 现在（旧） | 现在 bundle 里的（新） | 旧的是否还能用 |
| --- | --- | --- | --- |
| `home` | `3357ffed…` | `5fb7da7a…` | 能，但**不认** `homeEndUserIntegration` |
| `homeSection` | `d62af271…` | `5fb7da7a…` | — |
| `browsePage` | `f5c4e6d6…` | `f5c4e6d668f5716464a231c1cc8b22c1cbf6ad68b09929fd7de813a30581298b` | 未变 |
| `queryWhatsNewFeed` | `3b53dede…` | `d889c8c9…` | — |
| `profileAttributes` | `53bcb064…` | `08ffb473…` | — |
| `libraryV3` | `390c78e5…` | 未变 | 能 |
| `fetchLibraryTracks` | `087278b2…` | 未变 | 能 |
| `fetchPlaylist` | `cd227543…` | `21ea11a6…` | 能（回包 9.7 KB vs 新 26 KB，同 5 行） |
| `getAlbum` | `b9bfabef…` | `0b6ce351…` | 能（新多了 `meV2`） |
| `queryArtistOverview` | `7f86ff63…` | `9f8134ef…` | 能（两者几乎一样大） |
| `queryArtistDiscographyAll` | `5e07d323…` | 未变 | 能 |
| `searchTracks` | `bc1ca2fc…` | `b0268319…` | 能（5.5 KB vs 新 11.9 KB） |
| `getTrack` | `612585ae…` | `fe16b808…` | — |
| `areEntitiesInLibrary` | `13433799…` | 未变 | 能 |
| `addToLibrary` / `removeFromLibrary` | `896ebcb4…` | 未变 | 能 |
| `addToPlaylist` / `removeFromPlaylist` | `47b2a123…` | `b907ad6b…` | — |

> 换新哈希时注意：新文档比旧文档大很多（`fetchPlaylist` 同 5 行 9.7 KB → 26 KB，`searchTracks` 5.5 KB → 11.9 KB），说明多了字段。`spotifyNormalize.ts` 读的是老的键名，换之前要拿真回包再核一遍。

## 五、bundle 外的两个 spclient 接口（Folia 也在用）

```
GET https://spclient.wg.spotify.com/inspiredby-mix/v2/seed_to_playlist/spotify:track:<id>?response-format=json
→ 200 {"total":1,"mediaItems":[{"uri":"spotify:playlist:37i9dQZF1E8..."}]}     # 这首歌的电台（一个歌单）
GET https://spclient.wg.spotify.com/melody/v1/product_state?market=from_token
→ 200 {"product":"free","catalogue":"free","country":"HK","ads":"0","on-demand":"1",...}
```

两个都只要 `authorization`，不需要 client-token。

## 六、对 Folia 代码的影响（还没改，等你点头）

1. `src/services/onlineMusic/spotify/spotifyAndroid.ts`
   - `QUERIES` 按上表换；`home` 的变量要加 `homeEndUserIntegration`。
   - `CHANGES.addToPlaylist` / `removeFromPlaylist` 换 `b907ad6b…`。
   - `ensureClientToken()` 与 `client-token` 头可以删（服务端已经不认也不要求）；留着只是多一次隐藏 WebView 的开销。
   - `homeVariables()` 在 `spotifyExplore.ts:137`，加一个字段即可。
2. `spotifyNormalize.ts`：换新哈希后要按新回包核字段（旧键名不一定还在）。
3. `UPSTREAMS.md`：把「新的哈希从哪里读到：不清楚」改成指向本文件。

## 七、怎么复现

脚本都在应用私有目录 `/data/user/0/com.deepseek.harness.mobile/files/spotify-capture/`（含真 token，别外传）：

| 脚本 | 作用 |
| --- | --- |
| `oauth-server.mjs` | 起 127.0.0.1:5588 收授权码 → 写 `tokens.json` |
| `get-bundle.mjs` | 拉网页播放器 bundle |
| `grab-chunks.mjs` | 按 bundle 里的 chunk 表下 89 个路由 chunk |
| `list-ops.mjs` / `ops-all.json` | 抽出全部 172 个 operation + 哈希 |
| `capture.mjs` | 把上表里 20 多个操作逐个实跑，回包写 `captures/*.json` |
| `probe4.mjs` | 新旧哈希对比 |

bundle 地址会变，重跑 `get-bundle.mjs` 即可拿到当天的（本次是 `web-player.15cdd331.js`）。chunk 表就在 bundle 里的 `u.u=e=>""+({名字表})[e]+"."+({hashtable})[e]+".js"`。
