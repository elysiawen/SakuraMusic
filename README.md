# Sakura Music 🌸

聚合 **网易云音乐** 与 **QQ 音乐** 的自建音乐平台：一套账号系统、一次搜索同时命中两个平台、扫码登录后可自行选择把凭据存在服务器还是只存在本机。

- 两个上游项目（`../api-enhanced`、`../QQMusicApi`）**保持零改动**，原样运行即可。
- 不使用 Docker，全部为原生进程；数据库使用你已有的 PostgreSQL 实例。
- 前端：Vue 3 + Vite + TypeScript + Pinia；网关：Node.js + Fastify + TypeScript。
- 要开发其它客户端（桌面端 / 移动端 / 第三方前端）？接口清单见下文 **[主要接口](#主要接口)**，完整实现以 `gateway/src/routes/` 为准。

---

## 架构

```
                     ┌──────────────────────────────┐
   浏览器  ──────────▶│  web (Vue 3 + Vite, :5173)   │
   (Vite 代理 /api)   └──────────────┬───────────────┘
                                     │ /api/*
                     ┌───────────────▼──────────────┐         ┌──────────────────┐
                     │  gateway (Fastify, :8787)    │────────▶│ PostgreSQL       │
                     │  账户 / 会话 / 凭据保险库     │         │ (你已有的实例)    │
                     │  聚合搜索 / 音频流代理        │         └──────────────────┘
                     └───┬──────────┬──────────┬────┘
                         │          │          │
     Cookie 头注入凭据    │          │          │  仅 QQ 音乐 App 扫码时调用
                         ▼          ▼          ▼
        ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────────────────┐
        │ api-enhanced     │ │ QQMusicApi web   │ │ sidecar (:8090)              │
        │ (:3700)          │ │ (:8080)          │ │ sidecar/qq_mobile_login.py   │
        │ 网易云上游        │ │ QQ 音乐上游       │ │ 只做「QQ 音乐 App 扫码」——    │
        │ (Express)        │ │ (FastAPI)        │ │ 它需要 MQTT 长连接，而上游     │
        └──────────────────┘ └──────────────────┘ │ Web 层是单次请求-响应式路由     │
                                                  └──────────────────────────────┘
```

> sidecar 直接 `import qqmusic_api` 复用官方 SDK，因此 **QQMusicApi 仓库保持零改动**；
> 它只在用户选择「QQ音乐扫码」时才被调用，其余功能全部走 QQMusicApi 的 Web 服务。

### 凭据是如何工作的（核心设计）

两个上游都支持**按请求注入凭据**，这是整个方案的基础：

| | 网易云 | QQ 音乐 |
|---|---|---|
| 注入方式 | `Cookie` 头（`api-enhanced` 会合并进 `query.cookie`） | `Cookie` 头（`musicid` / `musickey` / … ，优先级高于服务端共享账号池） |
| 凭据形态 | 一整串 Cookie | 结构化 `Credential`，网关转成 Cookie |

据此网关提供两种存储模式，请求链路完全一致：

- **存服务器**：凭据以 AES-256-GCM 加密写入 `credentials` 表，网关按需解密后注入。QQ 凭据过期前会自动刷新并写回。
- **仅本机**：凭据只写入浏览器 IndexedDB，每次请求通过 `X-Sakura-Credential` 头透传，网关**只在内存中转发，不落库、不写日志**。

扫码成功后前端会强制弹窗要求选择其中一种（不设默认值）。

---

## 目录结构

```
sakura-music/
├─ gateway/                 Node.js + Fastify 聚合网关
│  ├─ src/
│  │  ├─ app.ts             应用组装（CORS、错误处理、路由注册）
│  │  ├─ config.ts          环境变量与凭据主密钥加载
│  │  ├─ db/                连接池与幂等建表脚本
│  │  ├─ lib/               AES-GCM / scrypt / 解析工具
│  │  ├─ upstream/          netease.ts、qq.ts 两个平台适配器
│  │  ├─ services/          账户、凭据保险库、聚合、音频流、音乐库
│  │  └─ routes/            HTTP 路由
├─ web/                     Vue 3 + Vite 前端（毛玻璃 + 6 套配色，默认深海蓝，浅色/暗色）
├─ sidecar/                 QQ 音乐 App 扫码服务（Python，复用 QQMusicApi 的 venv）
├─ scripts/
│  ├─ bootstrap.mjs         首次准备：克隆上游、装依赖、生成 gateway/.env、建表
│  ├─ start-all.mjs         开发模式一键拉起 5 个进程（前端跑 Vite dev server）
│  ├─ start-prod.mjs        生产模式一键拉起（网关跑 dist、前端跑静态产物）
│  └─ serve-web.mjs         零依赖静态服务：托管 web/dist + 反代 /api（可单独运行）
└─ .env.example             环境变量模板（复制为 gateway/.env）
```

> `gateway/.env` 与仓库根的 `.env` 都会被网关加载，模板统一放在仓库根 `.env.example`。

---

## 前置要求

| 组件 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 20.11 | 建议 22 LTS |
| pnpm | ≥ 9 | 仓库使用 pnpm workspace |
| Python + uv | ≥ 3.10 | 仅 QQ 音乐上游需要（`QQMusicApi` 自带 `uv.lock`） |
| PostgreSQL | ≥ 13 | 使用你已有的实例，填连接串即可 |

---

## 首次运行

### 一键准备（推荐）

```powershell
git clone https://github.com/elysiawen/SakuraMusic.git ; cd SakuraMusic
node scripts/bootstrap.mjs          # 也可以加 --start，准备完直接把全部进程拉起来
```

它会依次：检查 Node / git / pnpm / uv → 把 `api-enhanced` 与 `QQMusicApi` 克隆到**本仓库的同级目录**（已存在则跳过并可选更新）→ 安装三个项目的依赖 → 生成 `gateway/.env`（自动写入随机 `CREDENTIAL_KEY`，会问你一次数据库连接串）→ 连库并幂等建表。

跑完执行 `pnpm start:all` 即可（或直接用 `node scripts/bootstrap.mjs --start`）。

> **关于两个上游**：它们是各自独立的第三方项目（`QQMusicApi` 为 **GPL-3.0**，`api-enhanced` 为 MIT），本仓库**不包含它们的源码**，只在同级目录以独立进程 + HTTP 的方式使用。因此本仓库的许可证不受其影响。

下面是手动版步骤，需要逐步控制或排错时照着做。

### 1. 准备两个上游的依赖

```powershell
cd ../api-enhanced ; pnpm install
cd ../QQMusicApi   ; uv sync
```

### 2. 创建数据库

```sql
-- 在你的 PostgreSQL 实例上
CREATE DATABASE sakura_music;
```

### 3. 配置网关环境变量

```powershell
cd sakura-music
Copy-Item .env.example gateway/.env
notepad gateway/.env   # 至少填好 DATABASE_URL
```

关键项：

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | **必填**，指向你已有的 PostgreSQL |
| `CREDENTIAL_KEY` | 可选。32 字节 base64 主密钥；留空时网关自动生成到 `gateway/.data/credential.key`（请妥善保管，删了旧凭据就解不开了） |
| `NETEASE_BASE_URL` / `QQ_BASE_URL` | 两个上游地址，默认 `:3700` / `:8080` |
| `WEB_ORIGIN` | 前端来源，默认 `http://localhost:5173` |
| `ALLOW_REGISTER` | 是否开放注册，默认 `true` |

生成主密钥（可选，推荐显式配置以便备份）：

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### 4. 安装依赖并建表

```powershell
pnpm install
pnpm db:init      # 幂等建表，也可等网关启动时自动执行
```

### 5. 启动全部进程

```powershell
pnpm start:all
```

会依次拉起：网易云上游 `:3700`、QQ 音乐上游 `:8080`、网关 `:8787`、前端 `:5173`、客户端扫码服务 `:8090`。

也可以分开启动，方便看日志：

```powershell
pnpm start:netease     # 终端 1  网易云上游
pnpm start:qq          # 终端 2  QQ 音乐上游
pnpm start:sidecar     # 终端 3  QQ 音乐 App 扫码服务（可选，缺了只是少一种扫码方式）
pnpm dev:gateway       # 终端 4  网关
pnpm dev:web           # 终端 5  前端
```

### 6. 开始使用

打开 <http://localhost:5173>：

1. **注册第一个账号** —— 系统内的第一个用户会自动成为 `admin`。
2. 进入「设置」→「第三方音乐账号」→ 扫码绑定网易云 / QQ 音乐。
3. 扫码成功后弹窗选择「保存在服务器」或「仅保存在本机」。
4. 回到「发现」或「搜索」开始使用。

> 不绑定任何第三方账号也能搜索、播放与使用收藏/歌单/历史，只是「每日推荐」「私人 FM」等个性化内容不可用。

---

## 功能一览

| 模块 | 能力 |
|---|---|
| 账户系统 | 注册 / 登录 / 登出、HttpOnly Cookie + 服务端 Session、scrypt 密码散列、改昵称与头像、改密码（吊销全部会话） |
| 凭据管理 | 双平台扫码登录（QQ 音乐支持 **手机 QQ / 微信 / QQ 音乐 App** 三种码）、强制选择存储位置、查看状态、刷新、解绑 |
| 聚合搜索 | 两个平台并发搜索 → 标题+歌手归一化去重 → 相关性排序，同一首歌带多个 `sources`；页签与页码写入 URL，点进详情再返回仍停在原处 |
| 播放 | 底部播放条（进度拖动、音量、上下首、列表/单曲/不循环、随机）、音质切换、**手动切源**、断点续传的 Range 代理 |
| 歌词 | LRC 解析、翻译/罗马音合并、逐行滚动、点击跳转、全屏歌词页（歌手与专辑可直接点进详情页） |
| 音乐库 | 本地歌单增删改、收藏、播放历史（自动合并 5 分钟内的重复播放） |
| 发现 | 网易云每日推荐 / 私人 FM / 榜单，QQ 猜你喜欢 / 新歌速递 / 热门歌单 / 排行榜 |
| 外观 | 毛玻璃质感；明暗模式（浅色 / 暗色 / 跟随系统）与 6 套主题配色（樱花 / 抹茶 / 深海 / 紫藤 / 晚霞 / 水墨）可自由组合，樱花飘落背景动画，响应式布局 |

---

## 主要接口

所有接口都在网关 `/api` 前缀下，除 `/api/auth/*`、`/api/health`、`/api/stream` 外均需登录。

<details>
<summary>展开接口清单</summary>

**账户**

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` | 注册（首个用户为管理员） |
| POST | `/api/auth/login` | 登录 |
| POST | `/api/auth/logout` | 登出 |
| GET | `/api/auth/me` | 当前用户与统计 |
| PATCH | `/api/auth/profile` | 改昵称 / 头像 |
| POST | `/api/auth/password` | 改密码 |

**凭据**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/credentials` | 服务器已保存的凭据 |
| POST | `/api/bind/start` | 获取二维码 |
| GET | `/api/bind/poll` | 轮询扫码状态 |
| POST | `/api/bind/commit` | 提交存储模式（`server` / `local`） |
| DELETE | `/api/credentials/:platform` | 解绑 |
| POST | `/api/credentials/:platform/refresh` | 刷新凭据 |
| GET | `/api/credentials/:platform/status` | 校验凭据 |

**音乐**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/search?keyword=&page=&limit=` | 聚合搜索 |
| GET | `/api/track/:platform/:id` | 单曲详情 |
| GET | `/api/track/:platform/:id/lyric` | 歌词 |
| POST | `/api/play/resolve` | 换取带令牌的流地址 |
| GET | `/api/stream?t=` | 音频流代理（支持 Range） |
| GET | `/api/discover/feed` | 发现页聚合 |
| GET | `/api/toplists?platform=` | 榜单列表 |
| GET | `/api/toplist/:platform/:id` | 榜单详情 |
| GET | `/api/collection/:platform/:id` | 平台歌单详情 |

**音乐库**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/playlists` | 歌单列表 / 新建 |
| GET/PATCH/DELETE | `/api/playlists/:id` | 详情 / 改名 / 删除 |
| POST | `/api/playlists/:id/tracks` | 加入歌曲 |
| DELETE | `/api/playlists/:id/tracks/:platform/:trackId` | 移除歌曲 |
| GET/POST | `/api/favorites` | 收藏列表 / 收藏或取消 |
| GET/POST/DELETE | `/api/history` | 历史列表 / 记录 / 清空 |

</details>

---

## 生产部署

### 一键启动

```powershell
pnpm start:prod
```

它会先确保构建产物存在（缺 `gateway/dist` 或 `web/dist` 时自动执行 `pnpm build`），然后拉起
**网易云上游 :3700、QQ 音乐上游 :8080、网关（跑编译产物）:8787、前端静态服务 :6173**，
以及可选的 QQ 音乐 App 扫码 sidecar :8090。浏览器直接开 <http://127.0.0.1:6173> 即可。

| 参数 | 作用 |
|---|---|
| `--no-build` | 缺产物时直接报错，不自动构建 |
| `--no-web` | 不启动内置静态服务（已用 Nginx 托管 `web/dist` 时） |
| `--no-sidecar` | 不启动 QQ 音乐 App 扫码服务 |

与开发用的 `pnpm start:all` 的区别：网关跑 `dist/index.js` 而非 `tsx watch`，前端跑静态产物而非 Vite dev server。
`--no-web` 之外也可以单独运行 `pnpm start:web`（由 `WEB_HOST` / `WEB_PORT` / `GATEWAY_URL` / `WEB_DIST` 控制）。
临时换端口不必改代码，例如 PowerShell 下 `$env:WEB_PORT="80"` 后再执行 `pnpm start:prod`。

> 内置静态服务是零依赖的 `node:http` 实现：托管 `web/dist`、SPA 路由回退、`/api` 原样反代（含音频流的 `Range`）。
> 它与网关同源，因此不需要额外配置 CORS。**它是明文 HTTP**，适合单机/内网；面向公网请按下文用 Nginx 终结 TLS。

### 面向公网（Nginx 托管静态 + /api 反代）

生产推荐让 Nginx 直接托管 `web/dist`：省掉内置静态服务那一跳，`sendfile` / gzip / 长缓存都能用上，网关只负责 `/api`。

```powershell
pnpm build                  # 构建网关 (dist) 与前端 (web/dist)
pnpm start:prod --no-web    # 只拉起后端进程（上游 ×2 + 网关 + 可选 sidecar）
```

站点根目录指向 `sakura-music/web/dist`，`server {}` 里只需要这四段：

```nginx
# 1) 带内容哈希的静态资源：长期强缓存
location ^~ /assets/ {
    expires 365d;
    add_header Cache-Control "public, immutable";
    access_log off;
    try_files $uri =404;            # 真缺文件时给 404，别回退成 HTML
}

# 2) 入口页不缓存：发版后客户端立刻拿得到新的资源清单
location = /index.html {
    expires -1;
}

# 3) 网关 API
location /api/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # 音频流：Range 透传 + 关闭缓冲，否则起播慢、拖动卡
    proxy_set_header Range $http_range;
    proxy_set_header If-Range $http_if_range;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
}

# 4) SPA 路由回退 —— 必须放最后，否则 /discover、/search 这类前端路由会 404
location / {
    try_files $uri $uri/ /index.html;
}
```

三个几乎必踩的坑：

| 现象 | 原因 |
|---|---|
| 接口全 404 | `proxy_pass http://127.0.0.1:8787**/**;` 多了尾斜杠会把 `/api` 前缀剥掉，必须**不带** |
| `duplicate location "/"` | 面板建的静态站自带一个 `location /`，把 `try_files` 加进那一个即可，别再新建一个 |
| `/discover` 直接 404 | 漏了 `try_files $uri $uri/ /index.html;`——`index` 指令只管目录索引，兜不住前端路由 |

### HTTPS 与 Cookie

TLS 由 Nginx 或 CDN 终结即可。上线后改 `gateway/.env` 并重启网关：

```ini
WEB_ORIGIN=https://你的域名     # 多条用英文逗号分隔
COOKIE_SECURE=true              # 顺序别反：先有 HTTPS，再打开它
ALLOW_REGISTER=false            # 先注册出首个管理员账号，再关掉注册
```

前后端同源（同一个 `server{}` 同时提供静态与 `/api`），CORS 不会触发，`WEB_ORIGIN` 只是兜底。

> **挂了 CDN 的话**：`/api/` 一定要设成「不缓存」（登录态 Cookie 与音频流被缓存会出大问题），缓存策略选「遵循源站」；`index.html` 已经返回 `Cache-Control: no-cache`，CDN 就不会再缓存入口页。

### 长期运行与自启

`pnpm start:prod` 是前台进程，适合排查问题。要开机自启 + 崩溃重拉：

- **宝塔面板**：装「Supervisor 管理器」，启动命令用 `cd /www/wwwroot/music/SakuraMusic && pnpm start:prod --no-web`（静态已交给 Nginx）。注意 Supervisor 的环境变量很干净，`node` / `pnpm` / `uv` 常常不在 PATH 里，用绝对路径最稳。
- **Linux**：为网关、两个上游各写一个 systemd unit（`Restart=always`，`WorkingDirectory` 指向各自目录）。
- **Windows**：用 NSSM / WinSW 注册成服务，或 `pm2 start` 托管。

防火墙只放行 `80` / `443`；`3700`、`8080`、`8787`、`8090` 一律只听 `127.0.0.1`。

### 发版

```powershell
pnpm build      # 产物就地写进 gateway/dist 与 web/dist
```

Nginx 托管 `web/dist` 时**不用拷文件、不用重启 Nginx、不用重启网关**（只有网关代码改动才需要重启）。挂了 CDN 再刷一下 `/` 与 `/index.html` 两个地址即可——静态资源带内容哈希且 `immutable`，入口页一更新，客户端自然会去拉新的哈希资源。

### 必须保管的东西

`gateway/.data/credential.key`（未显式配置 `CREDENTIAL_KEY` 时生成）是解密已入库第三方凭据的唯一钥匙，**迁移机器必须一并复制**，丢了旧凭据就全部解不开（见下文 FAQ）。

---

## 常见问题

**搜索返回“上游返回 4xx/5xx”**
先在浏览器直接访问 `http://127.0.0.1:3700` 与 `http://127.0.0.1:8080` 确认上游已启动。网易云的未登录接口偶尔会触发风控，稍后重试通常即可。

**某首歌播不出来 / 只有试听片段**
会员或版权限制。网关已内置音质降级链（网易云 `hires→lossless→exhigh→standard`，QQ `母带→无损→320→128`），仍失败时可在播放条点击另一平台的标签手动切源。

实测结论：**网易云未登录也能取流**（含免费与部分版权歌曲）；**QQ 音乐未登录时只有免费歌曲能取到播放地址**，其余会返回 `result=104003`（无权限）。所以想听 QQ 音乐的歌，请扫码绑定一个 QQ 音乐账号。

**绑定时报“凭据解密失败”**
说明 `CREDENTIAL_KEY` 与入库时不一致（例如删掉了 `gateway/.data/credential.key`）。重新绑定该平台账号即可。

**QQ 音乐显示“QQ 音乐用户 1234…”而不是真实昵称**
昵称取自 `/user/{euin}/homepage`，该接口在上游结构变动或账号受限时可能取不到，不影响播放。

**「QQ音乐扫码」提示手机端扫码服务不可用**
sidecar 没启动。执行 `pnpm start:sidecar`（或直接用 `pnpm start:all` 一次拉起）。它复用 `QQMusicApi/.venv`，
如果提示找不到解释器，先在 `QQMusicApi` 目录跑一次 `uv sync`。另外手机 QQ / 微信扫码**不需要**这个服务。

**sidecar 启动报「端口已被占用」**
已经有一个 sidecar 在跑了，或上一次没退干净：
`Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like '*qq_mobile_login*' } | Stop-Process -Force`

**网易云上游报 `xeapi public key is missing`**
`api-enhanced` 启动时是「先取 xeapi 公钥 → 再用它注册匿名 token」的顺序，公钥缓存在系统临时目录（Linux 即 `/tmp/xeapi_public_key`）。**全新环境第一次启动必然报一次**（文件还没生成），随后它会自己拉取并写入，第二次启动就干净了。

如果反复出现，通常是**属主冲突**：有人用 root 跑过一次（文件属主变成 root），之后换 www 跑就读得到、覆盖不了。

```bash
rm -f /tmp/xeapi_public_key /tmp/anonymous_token   # 让运行用户自己重建
ls -ld /tmp                                        # 正常应为 drwxrwxrwt
```

根治办法是**始终用同一个用户**跑上游，别 root / www 混用（`/tmp` 被系统定期清理后也会自动重建，不影响使用）。

**QQ 音乐上游报 `spawn uv ENOENT`（进程根本没起来）**
`uv` 不在 PATH——systemd / Supervisor 这类干净环境很常见，或者 uv 装在 `/root/.local/bin` 而运行用户是 www（`/root` 权限 700，穿不进去）。

`pnpm start:prod` 会先探测 uv，**找不到就自动降级用 `QQMusicApi/.venv/bin/python web/run.py`**，所以运行时并不需要 uv，只在更新上游依赖时才用得上它：

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh     # 或直接把 uv 二进制复制到 /usr/local/bin
cd /path/to/QQMusicApi && uv sync --group web && chown -R www:www .venv
```

注意降级依赖 `.venv` 已存在，全新机器仍要先跑一次 `uv sync --group web`。

**改了上游端口后网易云一直失败**
默认端口：网易云 `3700`、QQ 音乐 `8080`、网关 `8787`、扫码 sidecar `8090`。
`pnpm start:prod` 用环境变量 `NETEASE_PORT` 启动网易云上游，而网关侧读的是 `gateway/.env` 里的 `NETEASE_BASE_URL`——**两者必须一致**，否则网关会把请求打到没人监听的端口上（现象是所有网易云搜索/播放都失败，但进程看着都正常）。改端口时两个一起改。

**收藏 / 歌单 / 播放历史里的歌手、专辑点不动**
这三处网关是按文本存库的（只有歌手名与专辑名），没有平台 ID，所以列表里的歌手链接不可用；**正在播放的那首**会在开始播放时自动补一次单曲详情，播放页里可以正常跳转。想让列表里也能点，需要网关把 `id` / `platform` 一并存库。

**想换回 SQLite / 不想用 PostgreSQL**
网关的数据库访问集中在 `gateway/src/db/`（连接池 + 一份幂等建表 SQL），更换驱动只需改这一层。

---

## 免责声明

音乐版权归各平台所有。本项目仅用于个人学习与技术研究，请勿用于商业用途或侵犯版权的行为。使用第三方平台的账号进行登录，可能受各平台用户协议约束，请自行评估风险。
