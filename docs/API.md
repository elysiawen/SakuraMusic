# Sakura Music 网关 API 参考

面向客户端开发者。本文档描述 `gateway` 暴露的全部 HTTP 接口、返回结构与若干必须理解的约定。

- 默认监听 `http://127.0.0.1:8787`（`HOST` / `PORT` 可改），所有接口都以 `/api` 开头，**没有版本前缀**。
- 网关只做「聚合 + 鉴权 + 代理」，自身不存储音频文件；音乐数据来自两个上游（网易云 `netease-upstream/`、QQ 音乐 `qq-upstream/`，两个都是本仓库自带的薄壳），由网关在服务端持有凭据并转发。
- 另外两套「协作」协议有自己的专文，不在本文范围内：多设备管理与控制见 `connect-protocol.md`，
  一起听（房间）见 `together-protocol.md`——它们各自的接口（`/api/connect/*`、`/api/rooms/*`）
  只在那两篇里讲。

---

## 最近更新

> **2026-10-14** —— **`AccountProfile` 多了账号级会员标识**（`vip` + `vipLabel`）：
>
> - 绑定、凭据列表、刷新、状态这些接口返回的 `profile` 里，现在会带上「**这个账号**是不是会员、
>   是哪一档」。`vipLabel` 是 **ASCII 标识、不本地化**（取值就是点亮的上游字段名：QQ 音乐
>   `vip` / `svip` / `huge_vip`；**网易云暂不发**，上游给不出可靠档位），显示成什么由客户端
>   自己映射（本仓库 web 见 `formatVipLabel`）→ [§2 数据类型](#2-数据类型)、
>   [3.3 第三方账号绑定与凭据](#33-第三方账号绑定与凭据)
> - 别跟**曲目上的** `vip`（那首歌是否付费/会员专享）混了，那是另一个字段、另一套语义。
> - 老的凭据里没有这两个字段，要调一次 `POST /api/credentials/:platform/refresh` 才会带上
>   （会员信息是在**绑定**与**刷新凭据**时写进 `profile` 的）。

> **2026-10-12（其二）** —— 两点更正/变更，都跟 QQ 上游有关：
>
> - **微信扫码不再"不可用"**：实测当前这类凭据是被 QQ 承认的（`check_expired` 为 False、免费曲目取地址
>   `result=0`、需要登录的收藏接口正常返回），0.7.3 与 0.8.2 两个版本下都成立。
>   所以 `bind/commit` 不再对 `loginType: "wx"` 特殊拒绝（绑定时的登录态校验照旧保留，对谁都一视同仁）
>   → [3.3 第三方账号绑定与凭据](#33-第三方账号绑定与凭据)
> - **QQ 上游 SDK 升到 `qqmusic-api-python==0.8.2`**（原 0.7.3）。逐项核对过：网关依赖的方法参数、枚举顺序
>   （`file_type` 下标）、`size_*` 字段、`Credential` 字段与别名、响应模型字段名都**没有变化**，
>   所以客户端与网关都不需要改；升级只影响 QQ 上游进程（需重启才生效）。

> **2026-10-12** —— 歌单的「描述」从"只能创建时写"变成"随时可读写"：
>
> - 歌单页现在会显示描述，并把它并进「编辑信息」——名称与描述走**同一次** `PATCH` 提交
>   → [3.6 个人音乐库](#36-个人音乐库)
> - 描述长度上限为 **800 字**（前端 `maxlength` 与服务端上限必须一致，否则界面能填进去的内容
>   会被服务端悄悄截掉）→ [3.6 个人音乐库](#36-个人音乐库)
> - 只改名称时描述不受影响（`PATCH` 里没带的字段保持原值）。

> **2026-10-07** —— 这一批改动都跟「音质档位」有关，客户端要改的地方集中在三处：
>
> - **档位从 4 档扩到 7 档**：新增 `spatial`（高清臻音）、`master`（超清母带）、`surround`（沉浸环绕声）。
>   两个平台都有这三档，但**都需要对应等级的会员**；`hires`（Hi-Res）**只有网易云有**，QQ 的最高档直接是母带。
>   取值与各平台对应关系 → [1.4 其它约定](#14-其它约定)
> - **`UnifiedTrack` 多了 3 个字段**：`qualities`（这首歌**实际有的**档位，别再把没有的列出来打灰）、
>   `qualitySizes`（各档文件大小）、`qualitiesComplete`（清单是否完整，`false` 时补一次单曲详情就齐了）
>   → [§2.1](#2-数据类型)
> - **`POST /api/play/resolve` 的 `actualQuality` 是"实际拿到的档位"**：UI 上显示「当前音质」必须用它，
>   不要用请求值 —— 网易云拿不到某一档时**不报错，而是"按能给的给"**（请求沉浸环绕声可能实际给高清臻音），
>   照请求值显示会把"正在听无损"说成"沉浸环绕声" → [3.5 音频播放](#35-音频播放)
> - ~~**QQ 音乐的「微信扫码」暂不可用**：这类凭据不被上游承认，`bind/commit` 现在会真校验登录态并当场拒绝，
>   请改用手机 QQ 扫码 / QQ 音乐客户端扫码~~ → **该结论已被推翻，见 2026-10-12（其二）**
>   → [3.3 第三方账号绑定与凭据](#33-第三方账号绑定与凭据)
> - **头像以平台返回的为准**：客户端不要再自己拼 `qlogo` 去覆盖（`qlogo` 只在平台没给头像时兜底；
>   微信登录账号的 `userId` 是 19 位伪 uin，拼出来是坏图）→ [2. 数据类型](#2-数据类型) 里 `AccountProfile` 一段
> - **刷新凭据不再谎报成功**：上游没换出新凭据时一律 `valid: false`，并区分「库里没凭据」与「有凭据但上游不认」
>   两种失败文案 → [3.3 第三方账号绑定与凭据](#33-第三方账号绑定与凭据)
>
> 上面每条只是「改了什么」；**完整的字段说明、示例与注意事项在下面对应小节**（箭头指过去的那节）。
> 之后再有改动，就在这一节最上面按同样格式加一段带日期的说明。

---

## 目录

1. [通用约定](#1-通用约定)
2. [数据类型](#2-数据类型)
3. [接口清单](#3-接口清单)
   - [3.1 健康检查](#31-健康检查)
   - [3.2 账户](#32-账户)
   - [3.3 第三方账号绑定与凭据](#33-第三方账号绑定与凭据)
   - [3.4 音乐聚合](#34-音乐聚合)
   - [3.5 音频播放](#35-音频播放)
   - [3.6 个人音乐库](#36-个人音乐库)
  - [3.7 平台账号音乐库（只读 + 导入）](#37-平台账号音乐库只读--导入)
4. [播放链路说明](#4-播放链路说明)
5. [错误码表](#5-错误码表)
6. [客户端实现要点](#6-客户端实现要点)
7. [环境变量](#7-环境变量)

---

## 1. 通用约定

### 1.1 鉴权

**除下面这几个公开接口外，其余全部要求已登录**，未登录返回 `401`：

| 接口 | 说明 |
|---|---|
| `GET /api/health` | 探活 |
| `POST /api/auth/register` | 注册 |
| `POST /api/auth/login` | 登录 |
| `POST /api/auth/logout` | 登出（未登录调用也返回成功） |
| `GET /api/auth/me` | 当前用户；**未登录返回 200 + `user: null`**，不报错 |
| `GET /api/stream` | 音频流；用 URL 里的令牌鉴权，**不看会话 Cookie** |

登录态是一个 **HttpOnly Cookie**：

| 属性 | 值 |
|---|---|
| 名称 | `sakura_session` |
| 值 | 32 字节随机数的 base64url（服务端只存 sha256 散列） |
| Path | `/` |
| SameSite | `Lax` |
| HttpOnly | 是 |
| Secure | 由 `COOKIE_SECURE` 决定（默认关闭） |
| 有效期 | `SESSION_DAYS`，默认 30 天 |

客户端只需像浏览器一样保存并回传 Cookie 即可。登录 / 注册成功时由 `Set-Cookie` 下发。

### 1.2 「仅本机」凭据透传（重要）

用户绑定第三方账号时可以选择把凭据**存在服务器**（加密入库）或**仅存在本地**。选择「仅本机」时，凭据不会到达服务器，因此**客户端必须在每次音乐类请求上带上它**：

```http
X-Sakura-Credential: <base64url(JSON)>
```

解码后是一个「平台 → Cookie 字符串」的对象：

```json
{ "netease": "MUSIC_U=xxx; __csrf=yyy", "qq": "musicid=123; musickey=zzz" }
```

规则：

- 值 = `base64url(JSON.stringify(map))`，**不带 `=` 补齐**（与 Node 的 `Buffer.from(x, 'base64url')` 一致）。
- 只需包含该用户选择的「仅本机」平台；缺省平台会回落到服务器上的凭据。
- **本机凭据优先级高于服务器凭据**——用户选了「仅本机」，就绝不会使用服务器上那份。
- 该头仅在内存中参与转发，网关**不落库、不写日志**。
- 头部解析失败时按「未提供」处理，不会报错。
- 需要它的接口：`/api/search`、`/api/track/*`（含歌词）、`/api/play/resolve`、`/api/artist/*`、`/api/album/*`、`/api/toplists`、`/api/toplist/*`、`/api/collection/*`、`/api/discover/feed`、`/api/credentials/:platform/status`、`/api/credentials/:platform/refresh`。
  （音乐库 `/api/playlists`、`/api/favorites`、`/api/history` 不访问上游，不需要它。）

### 1.3 错误格式

所有错误统一为：

```json
{ "error": { "code": "bad_request", "message": "请输入搜索关键词" } }
```

- `code`：稳定的机器可读标识。
- `message`：面向用户的中文文案，可直接展示。
- **非预期**的服务端异常（未被识别的 5xx）会被脱敏成「服务器开小差了，请稍后再试」，真实原因只进服务端日志；而业务错误（如 `upstream_error`）**会保留具体原因**，便于前端提示与排障。

### 1.4 其它约定

| 项目 | 约定 |
|---|---|
| 请求体 | JSON，最大 2 MB；声明了 `application/json` 但请求体为空也允许（部分客户端调无参 DELETE 会这样） |
| 时间 | 一律 ISO 8601 字符串（UTC），如 `2026-09-22T10:00:00.000Z` |
| 分页 | `page` 从 **1** 开始；`limit` 有各自上限，越界会被夹到合法区间（不报错） |
| 平台标识 | `netease`（网易云）/ `qq`（QQ 音乐），出现在很多字段里 |
| 音质 | `standard` / `high` / `lossless` / `hires` / `spatial` / `master` / `surround`（标准 / 极高 / 无损 / Hi-Res / 高清臻音 / 超清母带 / 沉浸环绕声）。两家各只有其中几档：`hires` 只有网易云有；后三档两边都有，但都需要对应等级的会员，等级不够时自动降级 |
| CORS | 仅 `WEB_ORIGIN` 白名单内的来源可用，且 `Access-Control-Allow-Credentials: true`；允许的方法 `GET,POST,PATCH,DELETE,OPTIONS`，允许的请求头 `Content-Type, X-Sakura-Credential, Range` |
| 404 | 未匹配到路由时返回 `{"error":{"code":"not_found","message":"接口不存在：GET /api/xxx"}}` |

---

## 2. 数据类型

### 2.1 `UnifiedTrack` — 统一歌曲

跨平台合并后的歌曲。同一首歌在多个平台都有时，`sources` 会包含多个来源，客户端可据此实现「切换音源」。

```json
{
  "key": "netease:1234567",
  "title": "晴天",
  "artists": [{ "name": "周杰伦", "id": "6452", "platform": "netease" }],
  "album": {
    "name": "叶惠美",
    "cover": "https://...jpg",
    "id": "18888",
    "platform": "netease"
  },
  "durationMs": 269000,
  "sources": [
    { "platform": "netease", "id": "1234567" },
    { "platform": "qq", "id": "003OUlho2HcRHC", "mid": "003OUlho2HcRHC", "numericId": "1059922" }
  ],
  "vip": false,
  "qualities": ["standard", "high", "lossless", "spatial", "master"],
  "qualitySizes": { "standard": 4718592, "high": 11848908, "lossless": 37539021 },
  "qualitiesComplete": true
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `key` | string | 主标识，`平台:ID`，**列表去重与「当前播放」判等都靠它** |
| `title` | string | 歌名（已去 HTML 标签） |
| `artists[].name` | string | 歌手名 |
| `artists[].id` | string? | 平台内歌手 ID，可跳转歌手页 |
| `artists[].platform` | `netease`/`qq`? | `id` 所属平台；**两个平台的 ID 体系不同，必须按它拼接** |
| `album.name` | string | 专辑名 |
| `album.cover` | string? | 封面图 |
| `album.id` | string? | 平台内专辑 ID |
| `album.platform` | `netease`/`qq`? | 同上 |
| `durationMs` | number | 时长（毫秒），0 表示未知 |
| `sources[]` | `TrackSource[]` | 各平台来源，**顺序 = 合并时的优先级**，`sources[0]` 为主来源 |
| `sources[].id` | string | 网易云为数字 ID，QQ 音乐为歌曲 mid |
| `sources[].mid` | string? | QQ 音乐歌曲 mid |
| `sources[].numericId` | string? | QQ 音乐数字 ID（部分写操作需要） |
| `vip` | boolean? | 是否付费/会员专享 |
| `qualities` | `Quality[]`? | 这首歌**实际有的**档位（不是 [1.4](#14-其它约定) 里那个全量枚举）。客户端应当**只列这里出现的档位**，别把没有的列出来打灰。缺省 = 不知道，此时按全量列 |
| `qualitySizes` | object? | 各档的文件大小（字节），键同 `qualities`；缺省 = 不知道（不要当成 0 字节显示） |
| `qualitiesComplete` | boolean? | `qualities` 是否**完整**。QQ 曲目一拿到就完整；网易云的搜索与歌单只带基础档，高级档要单曲详情才知道 —— 此时为 `false`，客户端可在播放时补一次 `GET /api/track/:platform/:id`（返回的 `qualities` 是完整的） |
| `playedAt` | string? | 仅播放历史里出现 |

> 取播放地址时传 `sources[i].id` 与 `sources[i].platform` 即可（见 [3.5](#35-音频播放)）。

### 2.2 `PlaylistSummary` — 榜单 / 平台歌单

```json
{
  "platform": "qq",
  "id": "4",
  "title": "热歌榜",
  "cover": "https://...jpg",
  "description": "每周更新",
  "trackCount": 100
}
```

### 2.3 `CollectionDetail` — 榜单 / 歌单详情

```json
{
  "platform": "netease",
  "id": "3778678",
  "title": "热歌榜",
  "cover": "https://...jpg",
  "description": "...",
  "trackCount": 200,
  "items": [ /* UnifiedTrack[] */ ]
}
```

### 2.4 歌手与专辑

搜索结果里的歌手/专辑**已经做过跨平台合并**：同名歌手只占一条，`sources` 保留各平台入口，客户端可渲染成「点哪个平台徽标就进哪个平台的详情页」。

**`UnifiedArtist`（合并后，搜索返回）**

```json
{
  "key": "netease:6452",
  "name": "周杰伦",
  "avatar": "https://...jpg",
  "subtitle": "Jay Chou",
  "songCount": 1200,
  "albumCount": 45,
  "sources": [
    { "platform": "netease", "id": "6452" },
    { "platform": "qq", "id": "0025NhlN2yWrP4" }
  ]
}
```

**`UnifiedAlbum`（合并后，搜索返回）**

```json
{
  "key": "netease:18888",
  "name": "叶惠美",
  "cover": "https://...jpg",
  "artists": [{ "name": "周杰伦", "id": "6452", "platform": "netease" }],
  "releaseDate": "2003-07-31",
  "trackCount": 11,
  "sources": [{ "platform": "netease", "id": "18888" }]
}
```

**`PlatformArtist` / `PlatformAlbum`（单平台，详情接口返回）**

与上面的区别是：多一个顶层 `platform` 字段、**没有** `sources`。歌手/专辑详情页返回的就是这一种——因为「详情页」本身就是针对某一个平台的。

```json
{ "platform": "qq", "id": "0025NhlN2yWrP4", "name": "周杰伦", "avatar": "https://...jpg", "songCount": 1000, "albumCount": 40 }
```

### 2.5 账户

**`PublicUser`**（永远不会包含密码散列）

```json
{
  "id": "8f3a...",
  "username": "sakura",
  "nickname": "Sakura",
  "avatar": "https://...jpg",
  "role": "admin",
  "createdAt": "2026-09-01T00:00:00.000Z"
}
```

`role` 为 `admin` / `user`。**全站第一个注册的用户自动成为 `admin`。**

**`UserStats`**

```json
{ "playlists": 3, "favorites": 128, "history": 542 }
```

**`AccountProfile`**（第三方平台账号资料）

```json
{
  "nickname": "Sakura",
  "avatar": "https://...jpg",
  "userId": "1580115937",
  "vip": true,
  "vipLabel": "huge_vip"
}
```

> `vip` 是**账号**级别的「是不是会员」，与曲目上的 `vip`（那首歌是否付费/会员专享）不是一回事。
> `vipLabel` 是会员档位**标识**：**ASCII、不本地化**，取值就是上游的字段名（接口里不放展示文案，
> 显示成什么由客户端决定）：

| 平台 | 取值 | 对应（点亮的是哪个上游标志） |
|---|---|---|
| QQ 音乐 | `vip` | 绿钻（`identity.vip`） |
| QQ 音乐 | `svip` | 豪华绿钻（顶层 `svip`，或 `identity.eight` 那个「豪华绿钻·八平台」形态） |
| QQ 音乐 | `huge_vip` | 超级会员（`identity.huge_vip`） |
| 网易云 | —— | **不发 `vipLabel`**，见下 |

> ⚠️ **QQ 的字段名和产品名是反的**：`huge_vip` 是**超级会员**（不是"豪华"），`svip` 才是**豪华绿钻**。
> 别照名字理解，也别"顺手修"——这是拿真实账号核对出来的：该账号 `identity.huge_vip_end` 正是
> 其**超级会员**的到期日、`identity.eight_end` 正是 App 里**豪华绿钻**的到期日，两个日期一一对上。
> （SDK 自己的注释在这点上是错的，它另一处 `sound_power.py` 的说法反而与实测一致。）
>
> 优先级从高到低：超级会员 > 豪华绿钻 > 绿钻 —— 高等级会把低等级的标志一并点亮。
>
> **网易云为什么没有档位**（只给 `vip` 布尔值）：
> `login/status` 的 `vipType` 是个编码（实测 110），没有公开取值表；`/vip/info` 的 `redVipLevel`
> 是**等级**不是档位 —— 网易云官方文档里它就叫「红 VIP 等级」（且不给取值表），实测还见过 `7`
> 这种值，1/2 档位说不通；真正表示「VIP 类型」的是响应里那些产品块（`associator` / `musicPackage`
> 自带的 `vipCode` / `vipLevel`），但官方**没有公开 `type` / `vipCode` 的枚举表**，社区流传的说法
> 拿真实数据一对就不成立。没有可靠依据就不猜 —— 网易云会员统一显示通用的「会员」。
> 将来要补：要么拿到官方枚举，要么用已知档位的账号做标定（`netease-upstream` 的 `endpoints.ts`
> 里留着 `/vip/info`，标定完成后把它接上即可）。
>
> 两者缺省都表示**上游没给出**（未绑定、查询失败等）——此时界面不要显示任何会员标识；
> `vip` 为 `true` 而 `vipLabel` 缺省时（旧数据，或档位查询失败），客户端显示通用的「会员」。
>
> `avatar` **以上游返回的为准**：QQ 音乐的主页接口会直接给一个头像地址（QQ 号账号给 QQ 头像，
> 微信登录的账号给微信头像），客户端**不要自己拼 qlogo 去覆盖它**。
> QQ 音乐侧 `userId` 是 **QQ 号**（即凭据里的 `musicid`），只在**上游没给头像**时用来兜底：
> `https://q1.qlogo.cn/g?b=qq&nk={userId}&s=640`（`s` 可自选尺寸）。微信登录的账号 `userId`
> 是 19 位伪 uin，拼 qlogo 只会得到一张坏图。

**`ServerCredential`**（凭据列表项）

```json
{
  "platform": "qq",
  "platformLabel": "QQ 音乐",
  "mode": "server",
  "profile": { "nickname": "QQ 音乐用户 1580115937", "userId": "1580115937" },
  "status": "active",
  "lastError": null,
  "updatedAt": "2026-09-22T10:00:00.000Z"
}
```

`status`：`active` / `invalid`（上次调用上游失败并记录了 `lastError`）。

### 2.6 其它

**`PlatformStatus`**（搜索时每个平台的命中情况）

```json
{ "platform": "netease", "ok": true, "count": 20, "error": null }
```

> `count` 是**合并去重前**该平台返回的条数，因此可能大于最终数组长度。

**`DiscoverSection` / `DiscoverFeed`**

```json
{
  "sections": [
    {
      "key": "netease-daily",
      "title": "每日推荐",
      "subtitle": "来自网易云音乐",
      "platform": "netease",
      "kind": "tracks",
      "items": [ /* UnifiedTrack[] 或 PlaylistSummary[] */ ]
    }
  ],
  "errors": [{ "platform": "qq", "section": "qq-guess", "message": "上游返回 code=..." }]
}
```

`kind` 决定 `items` 的元素类型：`tracks` → `UnifiedTrack[]`；`playlists` / `toplists` → `PlaylistSummary[]`。

---

## 3. 接口清单

共 **40** 个端点。下面「认证」一栏的含义：**是** = 需要登录 Cookie；**否** = 公开。

### 3.1 健康检查

#### `GET /api/health` — 探活

- **认证**：否
- **响应**

```json
{
  "ok": true,
  "time": "2026-09-22T10:00:00.000Z",
  "upstreams": { "netease": "http://127.0.0.1:3000", "qq": "http://127.0.0.1:3701" }
}
```

> 只表示网关进程存活，**不探测两个上游是否真的可用**。

---

### 3.2 账户

#### `POST /api/auth/register` — 注册

- **认证**：否
- **Body**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `username` | string | 是 | `^[a-zA-Z0-9_-]{3,24}$`，不区分大小写查重 |
| `password` | string | 是 | 长度 8–128 |
| `nickname` | string | 否 | 缺省时用 `username` |

- **响应**：`{ "user": PublicUser }`，同时 `Set-Cookie` 下发会话
- **注意**：`ALLOW_REGISTER=false` 时直接 400（`code: register_disabled`）；用户名占用返回 `409 conflict`；**第一个注册的用户 `role` 为 `admin`**

#### `POST /api/auth/login` — 登录

- **认证**：否
- **Body**：`{ "username": "...", "password": "..." }`（username 不区分大小写）
- **响应**：`{ "user": PublicUser }` + `Set-Cookie`
- **失败**：`401`，`code: invalid_credentials`，文案「用户名或密码不正确」

#### `POST /api/auth/logout` — 登出

- **认证**：是
- **响应**：`{ "ok": true }`，并清除 Cookie（服务端会话行同时删除）

#### `GET /api/auth/me` — 当前用户

- **认证**：否（未登录**不报错**）
- **响应**

```json
{ "user": { /* PublicUser */ }, "stats": { "playlists": 3, "favorites": 128, "history": 542 } }
```

未登录时返回 `{ "user": null, "stats": null }`。适合客户端启动时一次性拿到登录态与统计。

#### `PATCH /api/auth/profile` — 修改资料

- **认证**：是
- **Body**

| 字段 | 类型 | 说明 |
|---|---|---|
| `nickname` | string? | 长度 1–32，省略则不改 |
| `avatar` | string \| null? | 图片 URL，最长截断到 500；**显式传 `null` 表示清空**（回到渐变头像），省略则不改 |

- **响应**：`{ "user": PublicUser }`

#### `POST /api/auth/password` — 修改密码

- **认证**：是
- **Body**：`{ "oldPassword": "...", "newPassword": "..." }`（新密码同样 8–128）
- **响应**：`{ "ok": true }`
- **注意**：
  - 原密码错误 → `400`，`code: invalid_password`
  - **成功后该用户所有设备的会话全部失效**并清除 Cookie，客户端需要引导重新登录

---

### 3.3 第三方账号绑定与凭据

绑定流程（三步）：

```
POST /api/bind/start  →  拿到二维码图与 identifier
GET  /api/bind/poll   →  轮询直到 status=success，拿到 ticket 与 profile
POST /api/bind/commit →  提交「存服务器 / 仅本机」，完成绑定
```

> 本节各接口返回的 `profile` 就是 [§2](#2-数据类型) 的 `AccountProfile`，**账号级会员标识就在里面**：
> `vip: boolean?`（是不是会员）+ `vipLabel: string?`（哪一档，ASCII 标识，取值见 §2 那张表）。
> 客户端的渲染规则：`vip !== true` → 不显示任何会员标识；`vip === true` → 按平台把 `vipLabel`
> 映射成自己的文案（本仓库的 web 见 `formatVipLabel`），`vipLabel` 缺省时显示通用的「会员」
> （表示"是会员，但不知道哪一档"）。
> 会员信息是在**绑定**与**刷新凭据**时写进 `profile` 的，所以这个字段上线前绑的账号
> 要先调一次 `POST /api/credentials/:platform/refresh` 才会带上。

#### `POST /api/bind/start` — 开始扫码

- **认证**：是
- **Body**

| 字段 | 类型 | 说明 |
|---|---|---|
| `platform` | `netease`/`qq` | 必填 |
| `loginType` | string? | 网易云：`pc`（也可省略）。QQ 音乐：`qq`(默认) / `wx` / `mobile` |

- **响应**

```json
{ "platform": "qq", "identifier": "5f0c...", "qrImage": "data:image/png;base64,...", "loginType": "qq" }
```

- **注意**：
  - `qrImage` 可直接当 `<img src>` 使用。
  - `loginType: "mobile"`（QQ 音乐客户端扫码）与其它接口同源，都打在自建上游（`QQ_BASE_URL`，默认 `http://127.0.0.1:3701`）的 `/mobile/*` 上；扫码状态由上游那条 MQTT 长连接推送，**该请求最长可能耗时 40 秒**；上游未启动会返回 `504`（`上游服务不可用（…）`）。
  - `loginType: "wx"`（微信扫码）：产出的凭据 musickey 以 `W_X_` 开头，`musicid` 是 19 位**伪 uin**（不是 QQ 号）。
    **现在可用**（实测：`check_expired` 为 False、免费曲目取地址 `result=0`、收藏接口正常返回）。
    一个提醒：早前有一批 wx 凭据在 QQ 的鉴权接口上不被承认（一律 `code=1000`、返回体 `uin` 为空），
    那份判断已不再成立，所以不要按"wx 必定失效"做特殊处理。
    另外无论哪种扫码方式，`POST /api/bind/commit` 都会在绑定那一刻**真校验一次登录态**（失败先刷新再试一次），
    只有上游明确说不可用才拦下来，避免"绑好了才发现用不了"。

#### `GET /api/bind/poll` — 轮询扫码状态

- **认证**：是
- **Query**：`platform`（必填）、`identifier`（必填）、`loginType`（与 start 保持一致）
- **响应**

```json
{ "platform": "qq", "status": "success", "ticket": "...", "profile": { "nickname": "..." } }
```

| `status` | 含义 | 是否终态 |
|---|---|---|
| `waiting` | 等待扫码 | 否 |
| `scanned` | 已扫码，等待确认 | 否 |
| `confirmed` | 已确认（少数平台会短暂出现） | 否 |
| `success` | 授权成功，**此时返回 `ticket` 与 `profile`** | 是 |
| `expired` | 二维码过期 | 是 |
| `refused` | 用户拒绝 | 是 |
| `error` | 出错，`message` 里有原因（如风控） | 是 |

- **建议轮询间隔**：1.5–2 秒。
- `ticket` 有效期 5 分钟，只能使用一次。

#### `POST /api/bind/commit` — 提交存储方式

- **认证**：是
- **Body**：`{ "ticket": "...", "mode": "server" | "local" }`（`mode` 缺省或非法值都按 `server` 处理）
- **响应**

```json
{
  "platform": "qq",
  "mode": "local",
  "profile": { "nickname": "..." },
  "credential": { "cookie": "musicid=...; musickey=...", "raw": { "musicid": "..." } }
}
```

| 模式 | `credential` 字段 |
|---|---|
| `server` | **不返回**（已加密入库，客户端不必也不该持有） |
| `local` | 返回 `cookie`，以及 QQ 音乐专有的 `raw`（用于之后刷新凭据） |

> `local` 模式客户端必须自行安全保存：后续每次请求都要通过 `X-Sakura-Credential` 回传。

#### `DELETE /api/bind/session` — 释放扫码会话

- **认证**：是
- **Query**：`loginType`、`identifier`
- **响应**：`{ "ok": true }`
- **用途**：用户关闭弹窗时调用。手机端扫码会立刻断开 MQTT 长连接，不必空耗到超时。

#### `GET /api/credentials` — 已保存的凭据列表

- **认证**：是
- **响应**：`{ "items": ServerCredential[] }`
- **注意**：**只包含「存服务器」的凭据**；「仅本机」的凭据服务器根本不知道其存在，需要客户端自己在本地记录。

#### `DELETE /api/credentials/:platform` — 解绑

- **认证**：是
- **路径参数**：`platform` ∈ `netease` / `qq`
- **响应**：`{ "ok": true }`
- **注意**：只删除服务器上的凭据；若该用户是「仅本机」模式，需客户端自行删除本地记录。

#### `POST /api/credentials/:platform/refresh` — 刷新凭据

- **认证**：是
- **响应**（按凭据存放位置分两种形态）

服务器模式：

```json
{ "mode": "server", "valid": true, "profile": { "nickname": "..." } }
{ "mode": "server", "valid": false, "message": "上游没有换出新凭据，请重新扫码登录" }
{ "mode": "server", "valid": false, "message": "该平台尚未在服务器保存凭据" }
```

本机模式（从请求头的本机凭据刷新，并把**新凭据回传**，客户端必须覆盖保存）：

```json
{
  "mode": "local",
  "valid": true,
  "profile": { "nickname": "..." },
  "credential": { "cookie": "musicid=...; musickey=...", "raw": { "musicid": "..." } }
}
{ "mode": "local", "valid": false, "message": "刷新失败，请重新扫码登录" }
```

- **注意**：
  - **只有 QQ 音乐支持真正刷新**（`musickey` 有有效期，网关在服务器模式下也会在过期前自动刷新）。
  - 网易云没有刷新接口，本机模式下只会把原 cookie 回传、`valid: true`；服务器模式下仅校验一次当前凭据。
  - **上游没换出新凭据时一律 `valid: false`**，绝不会把旧凭据当刷新结果交回去报「成功」——
    客户端据此提示重新扫码即可（两种失败文案不同：库里没凭据 vs 有凭据但上游不认）。

#### `GET /api/credentials/:platform/status` — 凭据是否可用

- **认证**：是
- **响应**

```json
{ "bound": true, "valid": true, "profile": { "nickname": "..." } }   // 网易云
{ "bound": true, "valid": false }                                     // QQ 音乐（校验 musickey 是否过期）
{ "bound": false, "valid": false }                                    // 未绑定
```

> 判断前会先决议用哪份凭据（本机优先）。网易云会顺手带回 `profile`（含昵称与头像 URL）。
>
> QQ 的 `valid` 来自上游 `/login/check_expired`（它把布尔折进信封：过期 → `code=-1`，正常 → `code=0`，
> 网关显式读 `code` 判定），**不是**读完整个凭据就算。注意：上游不可达时（网络抖动、限流、上游没起）
> 当前也会返回 `valid: false`，客户端最好结合 HTTP 状态码区分"真的失效"与"这次没问出来"，
> 不要仅凭一次 `valid: false` 就催用户重新扫码。

---

### 3.4 音乐聚合

以下接口都可能返回 `5xx`（`code: upstream_error`），表示对应上游不可用。

#### `GET /api/platforms` — 支持的平台与能力

- **认证**：否（启动时就要用，客户端据此渲染平台开关）
- **响应**

```json
{
  "items": [
    {
      "platform": "netease",
      "label": "网易云音乐",
      "capabilities": { "search": true, "discover": true, "library": true }
    }
  ]
}
```

- `capabilities` 是**静态能力**（代码事实）：某平台不具备的能力为 `false`，客户端不要为它渲染开关。

#### `GET /api/search` — 聚合搜索

- **认证**：是
- **Query**

| 参数 | 默认 | 说明 |
|---|---|---|
| `keyword` | — | 必填，去空白后不能为空 |
| `type` | `song` | `song` / `artist` / `album` / `playlist` |
| `page` | 1 | ≥1 |
| `limit` | 20 | 1–50 |
| `platforms` | 全部 | 逗号分隔的启用平台，如 `netease`；只向这些平台发请求，被排除的平台也不会出现在 `platforms[]` 里 |

- **响应**

```json
{
  "keyword": "周杰伦",
  "type": "song",
  "page": 1,
  "limit": 20,
  "items": [ /* UnifiedTrack[]，仅 type=song */ ],
  "artists": [ /* UnifiedArtist[]，仅 type=artist */ ],
  "albums": [ /* UnifiedAlbum[]，仅 type=album */ ],
  "playlists": [ /* PlaylistSummary[]，仅 type=playlist */ ],
  "platforms": [{ "platform": "netease", "ok": true, "count": 20 }]
}
```

- **注意**：
  - 四个数组**总是存在**，与 `type` 无关的三个是空数组。
  - `type=song`：各平台结果**混排 + 按名称/歌手去重**，同一首歌合并成一个 `UnifiedTrack`（`sources` 有两条），再按相关度排序；只启用一个平台时 `sources` 自然只有一条。
  - `type=artist` / `album`：**同名合并**（专辑要求「专辑名 + 首位歌手」都相同），各平台入口在 `sources`。
  - 单侧平台失败不影响整体：`platforms[i].ok=false` 且带 `error`，另一侧结果照常返回。
  - 抓不到内容不报错，返回空数组。

#### `GET /api/track/:platform/:id` — 单曲详情

- **认证**：是
- **响应**：`{ "track": UnifiedTrack }`
- **失败**：取不到时 `400`，文案「未找到该歌曲」

#### `GET /api/track/:platform/:id/lyric` — 歌词

- **认证**：是
- **响应**

```json
{ "lrc": "[00:00.00]...", "trans": "[00:00.00]...", "roma": "" }
```

- 均为**原始 LRC 文本**，由客户端自行解析（支持逐行时间戳与翻译/罗马音双语）。没有对应内容时为空字符串。

#### `GET /api/discover/feed` — 发现页

- **认证**：是
- **Query**：`platforms`（可选，逗号分隔；缺省为全部。被排除的平台不发起请求）
- **响应**：`DiscoverFeed`（见 [2.6](#26-其它)）
- **内置分区**（按平台分组、组内按下列顺序；某项为空则不出现）

| `key` | 标题 | `kind` | 平台 |
|---|---|---|---|
| `netease-daily` | 每日推荐 | tracks | netease（需登录网易云） |
| `netease-fm` | 私人 FM | tracks | netease（需登录网易云） |
| `netease-toplists` | 网易云榜单 | toplists | netease |
| `qq-guess` | 猜你喜欢 | tracks | qq |
| `qq-newsong` | 新歌速递 | tracks | qq |
| `qq-toplists` | QQ 音乐榜单 | toplists | qq |
| `qq-songlists` | 热门歌单 | playlists | qq |

- **注意**：单个分区失败只记录到 `errors`，其余分区照常返回；未绑定账号时「每日推荐 / 私人 FM」等需要登录的分区会静默缺失。

#### `GET /api/preferences` — 云端偏好

- **认证**：是
- **响应**：`{ "items": [{ "key": "platforms", "value": { ... }, "updatedAt": "2026-10-19T..." }] }`
- 偏好只有云端这一份（浏览器里的副本仅作首屏快照）；网关不解释 `value` 的语义，只做键名与体积校验。

#### `PUT /api/preferences/:key` — 写入一份偏好

- **认证**：是
- **Body**：`{ "value": { ... } }`（整份覆盖，不做字段级合并）
- **限制**：`key` 匹配 `^[a-z][a-z0-9_-]{0,31}$`；`value` 序列化后不超过 16 KB
- **响应**：`{ "key": "...", "value": ..., "updatedAt": "..." }`

#### `DELETE /api/preferences/:key` — 删除一份偏好

- **认证**：是
- **响应**：`{ "ok": true }`

#### `GET /api/toplists` — 平台榜单列表

- **认证**：是
- **Query**：`platform`（必填）
- **响应**：`{ "items": PlaylistSummary[] }`

#### `GET /api/toplist/:platform/:id` — 榜单详情

- **认证**：是
- **Query**：`page`（默认 1）、`limit`（默认 100，最大 200）
- **响应**：`CollectionDetail`

#### `GET /api/collection/:platform/:id` — 歌单详情

- **认证**：是
- **Query**：同榜单
- **响应**：`CollectionDetail`

> 榜单与歌单在网易云侧是同一种资源，两个接口的区别只在走哪个上游方法。

#### `GET /api/artist/:platform/:id` — 歌手详情

- **认证**：是
- **响应**

```json
{
  "artist": { /* PlatformArtist：单平台，含 platform 字段 */ },
  "items": [ /* UnifiedTrack[]：热门歌曲，通常 50 首 */ ],
  "albums": [ /* UnifiedAlbum[]：已包成合并模型（此处只有单一来源） */ ]
}
```

- **注意**：`albums` 里的每一项 `sources` 只有一个平台，可以直接交给「专辑卡片」渲染。

#### `GET /api/album/:platform/:id` — 专辑详情

- **认证**：是
- **响应**

```json
{ "album": { /* PlatformAlbum */ }, "items": [ /* UnifiedTrack[]：完整曲目 */ ] }
```

- **注意**：QQ 音乐侧的专辑详情接口本身不含曲目数，网关已把曲目接口的 `total_num` 合并进 `album.trackCount`。

---

### 3.5 音频播放

播放要两步：先解析出**带令牌的代理地址**，再把该地址交给播放器。

#### `POST /api/play/resolve` — 解析播放地址

- **认证**：是
- **Body**

| 字段 | 类型 | 说明 |
|---|---|---|
| `platform` | string | 必填，取 `track.sources[i].platform` |
| `id` | string | 必填，取 `track.sources[i].id` |
| `quality` | string | 缺省 `high`，取值见 [1.4](#14-其它约定) |

- **响应**（同时给出**两条路**）

```json
{
  "url": "/api/stream?t=eyJ...",
  "direct": {
    "url": "https://m701.music.126.net/....mp3?authSecret=...",
    "headers": {
      "Referer": "https://music.163.com/",
      "Origin": "https://music.163.com",
      "User-Agent": "Mozilla/5.0 ... Chrome/122.0 Safari/537.36"
    }
  },
  "quality": "master",
  "actualQuality": "spatial",
  "trial": false
}
```

| 字段 | 说明 |
|---|---|
| `url` | **网关代理地址**（相对路径）：音频字节经服务器转发，兼容一切客户端 |
| `direct.url` | **平台 CDN 的真实地址**：客户端自己取流，**服务器不占音频带宽** |
| `direct.headers` | 直连时客户端需要自行附加的请求头（防盗链）。**浏览器无法设置 `Referer` / `Origin`**，仅对能自定义请求头的客户端（桌面 / 原生）有意义 |
| `quality` | 请求的档位，原样回显 |
| `actualQuality` | **实际拿到的档位**，降级时与 `quality` 不同。**UI 上显示「当前音质」必须用它**：照请求值显示会把"正在听无损"说成"沉浸环绕声"（请求高级档而账号等级不够时必然发生） |
| `trial` | 是否只能听试听片段 |

- **注意**：
  - `url` 是**相对路径**，客户端需自行拼上网关地址。
  - `trial: true` 表示受版权或会员限制，只能听到**试听片段**；建议在 UI 上标注。QQ 音乐不会返回试听（无权限时直接失败）。
  - 该接口会**先真正解析一次上游地址**：拿不到时直接报错（而不是等播放器静默失败），同时预热缓存。
  - 所有档位都拿不到地址时返回 `404`，`code: upstream_error`，文案「该歌曲在当前音质下没有可用播放地址（可能受版权或会员限制）」。
  - 两个平台降级的方式不同，但 `actualQuality` 都会如实反映：
    - **网易云**静默降级 —— 拿不到请求的档位时不报错，而是"按能给的给"（实测请求 `surround` 会回来 `spatial`、请求 `hires` 会回来 `lossless`），网关读它返回的 `level` 字段回报；
    - **QQ 音乐**按网关的降级链逐个 `file_type` 重试（无权限时上游回 `result=104003`），成功后回报真正取到的那个档位。

##### 该用哪条路？（带宽 vs 兼容）

| 客户端类型 | 建议 |
|---|---|
| **浏览器 Web** | 先试 `direct.url`；播放器报错（一个字节都没加载出来）时**自动换成 `url` 重试**，并把该平台记为「必须走代理」，后续直接跳过直连 |
| **桌面 / 原生** | 用 `direct.url` + `direct.headers` 自己取流（**服务器带宽为零**）；失败同样回退 `url` |
| **不想折腾** | 一律用 `url`，行为与旧版一致 |

> 直连能否成功取决于平台 CDN 是否校验 Referer / 是否绑定请求 IP（网关出口 IP 与客户端不同）。
> **建议把判断权交给客户端**：服务器探测通过不代表客户端能通过，所以务必实现"直连失败自动回退代理"。

#### `GET /api/stream?t=<token>` — 音频流代理

- **认证**：**否**（令牌即凭证）
- **Query**：`t` = `play/resolve` 返回的令牌
- **响应**：音频字节流
  - 状态码 `200` 或 `206`（Partial Content）
  - 响应头透传 `Content-Type`、`Content-Length`、`Content-Range`、`ETag`、`Last-Modified`，并带 `Accept-Ranges: bytes`、`Cache-Control: no-store`

- **注意**：
  - **必须用流式方式播放**，并支持 HTTP Range 请求（拖动进度条、边下边播都依赖它）。
  - 令牌是自加密的，**有效期 10 分钟**、内含平台/歌曲/音质/凭据。同一令牌可重复使用（拖动进度条会反复请求）。
  - 缺少 `t` 参数 → `400`，`code: bad_request`。
  - 令牌失效或损坏 → `401`，`code: stream_token_invalid`，文案「播放地址已过期，请重新点击播放」。客户端应在收到该错误时**重新调用 `play/resolve`**。
  - 上游拒绝或没有数据 → `502`（`stream_failed` / `stream_empty`）。
  - 该接口不校验 Sakura 会话，因此**不能**用作权限边界之外的资源访问（令牌本身就限定了单曲）。

---

### 3.6 个人音乐库

这些数据存在 Sakura 自己的数据库里，**与两个第三方平台完全独立**，不绑定任何平台账号也能用。

所有写歌曲的接口都接受一个 `track` 对象，字段从 `UnifiedTrack` 里取：

| 字段 | 必填 | 说明 |
|---|---|---|
| `sources[0].platform` | 是 | 也可退化为顶层 `platform` |
| `sources[0].id` | 是 | 也可退化为顶层 `id` |
| `title` | 否 | 缺省「未知歌曲」 |
| `artists[]` | 否 | 元素可为 `{name, id?, platform?}` 或字符串；缺省「未知歌手」 |
| `artists[].id` / `.platform` | 否 | **存下来才能在歌单 / 收藏 / 历史里点进歌手页**；只给名字，列表里就只显示纯文本 |
| `album.name` / `album.cover` | 否 | |
| `album.id` / `album.platform` | 否 | 同上，用于跳转专辑页 |
| `durationMs` | 否 | 缺省 0 |
| `key` / `vip` | 否 | `key` 缺省时按 `平台:ID` 生成 |

> 实践上直接把搜索返回的 `UnifiedTrack` 原样回传即可。

> 这三个列表（歌单曲目 / 收藏 / 播放历史）读回来的 `UnifiedTrack` 同样带 `artists[].id` 与 `album.id`，
> 前端据此把歌手、专辑渲染成可点的链接。**补上这两列之前写入的老数据没有 ID**，会退化成"只有名字"；
> 跑一次 `pnpm --filter @sakura/gateway backfill:track-refs` 即可补齐（见 README「升级已有部署」）。

#### 歌单

| 方法 | 路径 | 说明 | 响应 |
|---|---|---|---|
| `GET` | `/api/playlists` | 歌单列表（按创建时间倒序） | `{ "items": Playlist[] }` |
| `POST` | `/api/playlists` | 新建，Body `{name, description?}`（名称 1–60 字，描述 ≤800） | `{ "playlist": Playlist }` |
| `GET` | `/api/playlists/:id` | 详情含曲目 | `{ "playlist": Playlist, "items": UnifiedTrack[] }` |
| `PATCH` | `/api/playlists/:id` | 改名 / 改描述，Body `{name?, description?}` | `{ "ok": true }` |
| `DELETE` | `/api/playlists/:id` | 删除歌单（连同其中的曲目） | `{ "ok": true }` |
| `POST` | `/api/playlists/:id/tracks` | 加歌，Body `{track}` | `{ "added": boolean, "trackCount": number }` |
| `DELETE` | `/api/playlists/:id/tracks/:platform/:trackId` | 移除一首 | `{ "ok": true, "trackCount": number }` |

`Playlist`：

```json
{
  "id": "12",
  "name": "通勤精选",
  "description": "",
  "cover": "https://...jpg",
  "trackCount": 42,
  "createdAt": "2026-09-01T00:00:00.000Z",
  "updatedAt": "2026-09-20T00:00:00.000Z"
}
```

> `cover` 取歌单里**最近加入**那首歌的封面（该曲目恰好没有封面时，往前找最近一首有封面的），可能为 `null`。
> 歌单本身**没有**独立的封面字段，这个值是查询时算出来的，因此加歌之后它会跟着变成新歌的封面。
> `added: false` 表示这首歌（同平台同 ID）已在歌单里，此时不重复插入。
> 所有 `/api/playlists/:id/*` 都做过归属校验，别人的歌单返回 `404`。

#### 收藏

| 方法 | 路径 | 说明 | 响应 |
|---|---|---|---|
| `GET` | `/api/favorites` | 收藏列表（按收藏时间倒序，最多 500） | `{ "items": UnifiedTrack[], "keys": string[] }` |
| `POST` | `/api/favorites` | Body `{track, favorite?}`，`favorite` 缺省为 `true` | `{ "favorite": boolean }` |
| `DELETE` | `/api/favorites/:platform/:trackId` | 取消收藏 | `{ "ok": true }` |

> `keys` 是收藏歌曲的 `UnifiedTrack.key` 集合，客户端拿它标记红心状态最省事。
> `POST` 是幂等的：重复收藏不会报错。

#### 播放历史

| 方法 | 路径 | 说明 | 响应 |
|---|---|---|---|
| `GET` | `/api/history` | Query `limit`（默认 100，最大 300） | `{ "items": (UnifiedTrack & {playedAt})[] }` |
| `POST` | `/api/history` | 记一次播放，Body `{track}` | `{ "ok": true }` |
| `DELETE` | `/api/history` | 清空 | `{ "ok": true }` |

> **5 分钟内重复播放同一首歌只刷新时间**，不会刷屏。

### 3.7 平台账号音乐库（只读 + 导入）

读的是**绑定账号在平台上**的歌单，与 3.6 的本地库是两套完全独立的数据：
这里不写回平台，也不会自动同步进本地库。「导入」是**单向复制**——复制完成后两边各走各的，
想刷新内容就再导一次（会新建一张，不覆盖旧的）。三套数据（本地 / 网易云 / QQ 音乐）各显各的。

**前置条件：该平台必须已绑定。** 没绑定时返回 `400 platform_not_bound`，而不是退化成匿名查询 ——
两个平台对匿名调用都会返回**别人的或匿名账号名下**的数据（网易云 `/user/playlist`、`/likelist`
如此，QQ 那边会按请求里的 uin 回一份公开歌单），结果是用户看到一份与自己无关的「我喜欢」，
比直接报错更难排查。

| 方法 | 路径 | 说明 | 响应 |
|---|---|---|---|
| `GET` | `/api/platform/:platform/playlists` | 该账号的歌单：我创建的 + 我收藏的 | `{ "items": PlaylistSummary[] }` |
| `GET` | `/api/platform/:platform/favorites` | 该账号的收藏 | `{ "platform", "title", "cover?", "total", "page", "limit", "items": UnifiedTrack[] }` |
| `POST` | `/api/platform/:platform/playlists/:id/import` | 把平台上某张歌单复制成本地歌单 | `PlatformImportResult` |
| `POST` | `/api/platform/:platform/favorites/import` | 把收藏复制成本地歌单 | `PlatformImportResult` |

> - `:platform` 取 `netease` / `qq`；两个平台的响应结构一致，客户端不必分支。
> - **收藏也在歌单列表里**：QQ 音乐的「我喜欢」、网易云的「我喜欢的音乐」本身就是一张歌单，
>   平台就是这么返回的。所以界面上的歌单列表同时承担了收藏入口，`/favorites` 是给需要
>   单独列收藏的客户端留的。
> - 歌单里的曲目仍走 3.4 的 `GET /api/collection/:platform/:id` 获取（分页参数 `page`、`limit`）。
> - `favorites` 的 Query 支持 `page`、`limit`（默认 1 / 50，上限 100）。

`PlatformImportResult`：

```json
{
  "playlist": { "id": "12", "name": "2022 年度歌单", "trackCount": 187, "...": "同 3.6 的 Playlist" },
  "added": 187,
  "skipped": 0,
  "total": 187,
  "truncated": false
}
```

| 字段 | 说明 |
|---|---|
| `added` | 实际写入的曲目数 |
| `skipped` | 因重复或缺少音源被跳过的数量 |
| `total` | 平台侧的曲目总数 |
| `truncated` | 是否因为单次上限只导入了前面一部分 |

导入的行为约定：

- **单次上限 300 首**（上游有频控，服务端翻页之间还会间隔 150ms）。超出时 `truncated: true`，
  客户端应当把「只导入了前 N 首」明确告诉用户，否则用户会以为整张都进来了。
- **去重口径是 `平台 + 曲目 ID`**：平台歌单里的重复曲目只保留首次出现；本地歌单里已有的同曲会记进 `skipped`。
- **重名处理**：新歌单默认用平台原名（超过 60 字会被裁到上限内），同名时依次尝试
  `原名（平台）`、`原名（2..9）`、`原名（导入）`，不会覆盖已有歌单。
- **描述里写明来源**，例如 `从QQ 音乐导入，共 187 首`；被截断时写 `原歌单共 512 首，本次导入前 300 首`。
- 导进来的曲目是本地快照：之后在平台里加歌，本地这张不会跟着变。
- 空歌单 / 空收藏返回 `400`（`empty_playlist` / `empty_favorites`）。

---

## 4. 播放链路说明

`play/resolve` 会同时给出**直连**与**代理**两条路，客户端选一条走：

```
客户端                       网关                        平台 CDN
  │                           │                             │
  ├─ POST /api/play/resolve ──┤                             │
  │   {platform,id,quality}   ├─ 解析真实播放地址 ──────────►│
  │                           │◄──── 带签名/防盗链的 URL ────┤
  │◄─ { url: "/api/stream?t=…",                             │
  │     direct: {url,headers} } ┤（同时预热 5 分钟缓存）      │
  │                                                          │
  │  ┌── 路径 1：直连（服务器零音频流量）──────────────────┐ │
  ├──┴─ GET direct.url（带 direct.headers）─────────────────►│
  │◄─────────────── 200/206 音频流 ─────────────────────────┤
  │                                                          │
  │  ┌── 路径 2：代理（字节经服务器）──────────────────────┐ │
  ├──┴─ GET /api/stream?t=… ──►│                           │ │
  │◄──── 200/206 音频流 ───────┤◄──── 音频字节 ────────────┘ │
```

几个必须理解的背景：

1. **不能直连上游音频地址**。两个平台的 CDN 都有 Referer 防盗链，浏览器/客户端直接请求会 `403`，必须经网关转发（网关会补 `Referer` 与 `User-Agent`）。
2. **`<audio src>` 无法自定义请求头**，所以「仅本机」模式的凭据没法在流请求上传递。因此设计成：先用一次带鉴权的 `play/resolve` 把凭据**封装进自加密令牌**，后续流请求只凭令牌即可。
3. **令牌有效期 10 分钟**，但 `resolve` 里解析出的上游地址有 **5 分钟**内存缓存（按 平台+歌曲+音质+凭据指纹 缓存），所以拖进度条不会反复打上游。
4. **音质降级**：请求的音质不可用时，网关会自动逐级降低（如 `hires → lossless → exhigh → standard`，QQ 是 `file_type` 12/7/13 那条链），尽量让歌能放出来；网易云在全都无权限时才回退到试听片段并置 `trial: true`。「高清臻音 / 超清母带 / 沉浸环绕声」需要对应等级的会员，拿不到地址时会落到无损或 Hi-Res，不会直接失败。

---

## 5. 错误码表

| HTTP | `code` | 含义 / 处理建议 |
|---|---|---|
| 400 | `bad_request` | 参数不合法（原因见 `message`） |
| 400 | `register_disabled` | 站点已关闭注册（`ALLOW_REGISTER=false`） |
| 400 | `invalid_password` | 原密码不正确 |
| 400 | `bind_ticket_expired` | 绑定会话已过期，重新扫码 |
| 400 | `credential_decrypt_failed` | 凭据解密失败（主密钥变了），需重新绑定该平台 |
| 401 | `unauthorized` | 未登录 / 会话过期 → 跳登录页 |
| 401 | `invalid_credentials` | 用户名或密码错误 |
| 401 | `stream_token_invalid` | 播放令牌过期 → 重新调 `play/resolve` |
| 403 | `forbidden` | 无权限 |
| 404 | `not_found` | 资源不存在（含别人的歌单） |
| 409 | `conflict` | 冲突（用户名被占用） |
| 428 | `credential_required` | 预留：未绑定该平台账号。**当前没有接口会返回** |
| 500 | `internal_error` | 服务端异常（原因见服务端日志） |
| 502 | `upstream_error` | 上游（网易云 / QQ 音乐）不可用或返回异常 |
| 502 | `stream_failed` / `stream_empty` | 音频源返回错误 / 没有数据 |
| — | `request_error` | 4xx 的兜底 code |

---

## 6. 客户端实现要点

### 6.1 最小可用流程

```
1. POST /api/auth/register 或 /api/auth/login   → 保存 Cookie
2. GET  /api/auth/me                            → 确认登录态、拿统计
3. POST /api/bind/start → 轮询 /api/bind/poll → POST /api/bind/commit
   ├─ mode=server：什么都不用管
   └─ mode=local ：安全保存 credential.cookie，并记住「该平台要透传」
4. GET  /api/search?keyword=xxx&type=song       → 展示列表
5. POST /api/play/resolve                       → 拿代理地址
6. 用播放器打开 {gateway}{url}，支持 Range
```

### 6.2 容易踩的点

- **`X-Sakura-Credential` 只在「仅本机」模式需要**，但一旦需要，就必须每个音乐类请求都带，否则会出现「明明绑定了却只能听试听」。
- **`url` 是相对路径**，别忘了拼网关地址。
- **搜索的三个非当前类型数组始终存在**，按 `type` 取用即可，不要假设字段缺失。
- **`platforms[].count` 是合并前的条数**，与 `items.length` 不一定相等。
- **歌手/专辑需要用 `sources` 渲染入口**：`artist.id` 只在对应平台的详情接口里有效，跨平台会把 ID 拼错。
- **`/api/auth/me` 未登录返回 200 + null**，不要拿它当鉴权探针（用业务接口的 401 判断）。
- **改密码会踢掉所有设备**，包括当前这台。
- **QQ 音乐的 `musickey` 会过期**：服务器模式网关注意在过期前自动刷新；本机模式需要客户端自己调 `refresh` 并**覆盖保存**返回的新凭据。
- **`/api/stream` 请求不要带 Cookie**（也不需要），它只认 `t`。
- **想省服务器带宽就用 `direct`**：`play/resolve` 返回两条路，直连省掉全部音频流量；但**判断权必须在客户端**（上游签名可能绑定请求 IP，服务器探测通过不等于客户端能通过），所以直连失败务必自动回退到 `url`。

### 6.3 一个可用的最小请求集

只需要「能搜、能放」的客户端，实现这 6 个就够：

```
POST /api/auth/login
GET  /api/auth/me
GET  /api/search
POST /api/play/resolve
GET  /api/stream?t=...
GET  /api/track/:platform/:id/lyric   （可选，歌词）
```

---

## 7. 环境变量

网关启动时会依次读取 `gateway/.env` 与仓库根目录 `.env`（已存在的进程环境变量优先）。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HOST` | `127.0.0.1` | 监听地址 |
| `PORT` | `8787` | 监听端口 |
| `DATABASE_URL` | — | **必填**，PostgreSQL 连接串 |
| `DB_SSL` | `auto` | `auto` / `true` / `false` |
| `CREDENTIAL_KEY` | 自动生成 | 32 字节 base64；缺省时生成到 `gateway/.data/credential.key`。**这是解密已存凭据的唯一钥匙，不要丢** |
| `NETEASE_BASE_URL` | `http://127.0.0.1:3700` | 网易云上游（自建 `netease-upstream/`） |
| `QQ_BASE_URL` | `http://127.0.0.1:3701` | QQ 音乐上游（自建 `qq-upstream/`，含三种扫码登录） |
| `QQ_STREAM_HOST` | `https://ws.stream.qqmusic.qq.com/` | QQ 音乐流地址前缀 |
| `WEB_ORIGIN` | `http://localhost:5173` | CORS 白名单，逗号分隔多个 |
| `COOKIE_SECURE` | `false` | 置 `true` 时会话 Cookie 带 `Secure`（HTTPS 部署时必须开） |
| `ALLOW_REGISTER` | `true` | 是否允许注册 |
| `SESSION_DAYS` | `30` | 会话有效期（天） |
| `UPSTREAM_TIMEOUT_MS` | `15000` | 上游请求超时 |
| `LOG_LEVEL` | `info` | 日志级别 |
