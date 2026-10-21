# 在线视频下载管理器

一个功能完整、界面现代的在线视频下载管理 Web 应用。粘贴公开视频链接，系统自动识别平台、解析视频信息、创建下载任务，并通过并发受限的任务队列完成下载、断点续传、状态持久化与服务重启恢复。

> 使用约定：本工具仅用于下载**公开、且你拥有下载权或已获授权**的视频资源。不破解 DRM，不绕过付费墙、登录限制或平台访问控制；平台限制无法下载时给出清晰错误提示。

## 功能特性

- **URL 解析**：自动识别 YouTube / Bilibili / Vimeo / X (Twitter) / TikTok / 抖音 (Douyin) / Instagram / 直链视频；验证 URL、获取标题/缩略图/作者/时长/可用画质与格式/文件大小
- **通用平台直通**：未匹配内置平台的链接自动交给 yt-dlp 通用解析（覆盖 1900+ 站点：微博、快手、优酷、腾讯视频、爱奇艺、西瓜视频、Dailymotion、Reddit、Twitch、VK、SoundCloud 等）
- **自定义解析源**：在「设置 → 解析源」为任意站点添加解析规则 —— yt-dlp 参数型（附加参数/Cookie/请求头）或自定义脚本型（脚本输出直链 JSON），内置平台优先
- **代理支持**：HTTP(S) / SOCKS5 代理（设置页或 `PROXY_URL`），同时作用于 yt-dlp、直链下载与直链探测；本机与局域网地址自动直连
- **下载任务**：完整状态机 `Waiting → Parsing → Downloading → Paused / Completed / Failed / Cancelled`；实时进度、速度、剩余时间
- **任务控制**：暂停 / 继续（断点续传）/ 取消 / 重试 / 删除；等待中与运行中的任务都可暂停，删除任务记录与删除实体文件明确分离，删除记录时自动清理 `.part` 临时文件与任务日志，启动时清理过期日志
- **批量操作**：多选任务批量删除、一键删除全部（可限定当前筛选条件），均支持「仅删记录 / 同时删除文件」两种模式
- **并发队列**：默认并发 3（可配置 1/2/3/5/10），超限任务进入等待，完成后自动启动下一个
- **任务恢复**：服务重启后自动读取数据库，恢复 Waiting/Downloading 任务（HTTP Range / yt-dlp `.part` 断点续传），Completed 任务绝不重复下载；续传以 `.part` 实际字节数为准，即使崩溃时数据库进度落后也不会损坏文件
- **失败处理**：中文清晰错误（网络连接中断 / 视频不存在 / URL 无效 / 磁盘空间不足 / 需要登录授权等），可恢复错误按指数退避自动重试（0~10 次可配置），需要登录、视频不存在等不可恢复错误不再无意义重试
- **任务列表**：搜索标题/链接/作者、按状态筛选、分页浏览；历史页额外支持平台/时间排序，任务很多时也不会只能看到前 200 条
- **下载历史**：搜索、按平台/状态筛选、时间排序、分页、打开文件夹、删除文件/记录
- **Dashboard**：今日任务、已完成、进行中、失败、累计下载量、累计任务、成功率、各平台分布、每日下载量图表
- **设置**：默认画质/格式、并发数、保存目录、限速、超时、重试次数、浅色/深色/跟随系统、系统信息（版本/数据库/目录/磁盘）
- **响应式**：桌面 Dashboard 布局 / 平板 / 手机（底部导航、卡片列表、无横向滚动）
- **安全**：API 默认只接受同源与本机/局域网来源的写请求，阻止任意网页跨站调用本机下载服务；下载完整性校验（Content-Length / Content-Range）确保截断连接不会被标记为完成
- **Docker**：多阶段构建，`docker compose up -d` 一键启动

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | React 18 · TypeScript · Vite 5 · Tailwind CSS 3 · React Router 6 · lucide-react |
| 后端 | Node.js (≥22.5) · TypeScript · Express 4 |
| 数据库 | SQLite（Node 内置 `node:sqlite`，零原生依赖） |
| 下载引擎 | 自研任务队列 + HTTP Range 断点续传引擎 + [yt-dlp](https://github.com/yt-dlp/yt-dlp) 子进程（平台视频） |
| 测试 | puppeteer-core（系统 Edge）+ 本地媒体源（Range/限速/断流模拟）+ 20 任务压力测试 |

## 快速开始

环境要求：**Node.js ≥ 22.5**（使用内置 `node:sqlite`）。可选：Python 3 或 yt-dlp 可执行文件、ffmpeg（音频合并/MP3 转码才需要）。

```bash
# 1. 安装依赖
npm install

# 2. 开发模式（前端 5173 + 后端 3000，带 HMR）
npm run dev

# 3. 生产模式
npm run build
npm start
# 打开 http://localhost:3000
```

### yt-dlp 安装（平台视频下载）

直链视频无需任何额外依赖。YouTube / Bilibili 等平台需要 yt-dlp，按优先级自动探测：

1. `tools/ytdlp` 目录存在时，通过 `python -m yt_dlp` 运行（`pip install --target tools/ytdlp yt-dlp`）
2. 系统 Python 已安装 yt-dlp 模块
3. `tools/yt-dlp.exe` / `tools/yt-dlp`（或 `YTDLP_PATH` 指定）
4. PATH 中的 `yt-dlp`

未安装 yt-dlp 时，平台 URL 仍可解析出公开元数据（oEmbed/页面信息）用于预览，但下载会给出明确提示。

## 环境变量

复制 `.env.example` 为 `.env`（可选，均有默认值）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 服务端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `./data` | 数据目录（日志、临时文件） |
| `DB_PATH` | `./data/app.db` | SQLite 数据库路径 |
| `DOWNLOAD_DIR` | `./downloads` | 默认下载目录 |
| `YTDLP_PATH` | `./tools/yt-dlp(.exe)` | yt-dlp 可执行文件路径 |
| `FFMPEG_PATH` | `./tools/ffmpeg(.exe)` | ffmpeg 路径（合并/MP3 需要） |
| `PYTHON_PATH` | `python` / `python3` | 用于 `python -m yt_dlp` 的解释器 |
| `YTDLP_MODULE_DIR` | `./tools/ytdlp` | yt-dlp Python 模块目录（`pip install --target`） |
| `MAX_CONCURRENCY` | `3` | 启动时默认并发数（可在设置页修改） |
| `PROXY_URL` | 空 | HTTP(S)/SOCKS 代理，如 `http://127.0.0.1:10020`；也可只写端口。在设置页可覆盖 |
| `CORS_ORIGINS` | 空 | 额外允许跨源访问 API 的来源，逗号分隔；默认已允许同源、localhost、127.0.0.1 与局域网 IP |

## Docker 部署

```bash
docker compose up -d
# 打开 http://localhost:3000
```

镜像内含 Node 24 + Python + yt-dlp + ffmpeg，数据与下载目录挂载到宿主机（`./data`、`./downloads`），重启后任务自动恢复。

## 项目结构

```
├── server/                  # 后端（Express + SQLite + 任务队列 + 下载引擎）
│   └── src/
│       ├── index.ts         # 入口：启动、恢复、静态托管、优雅关闭
│       ├── config.ts        # 环境变量与路径
│       ├── errors.ts        # 错误码与中文消息
│       ├── db/              # database / tasks / settings / stats
│       ├── services/        # platforms(识别) · metadata(oEmbed/yt-dlp解析)
│       │                    # download(HTTP Range/yt-dlp 引擎) · queue(并发队列)
│       │                    # recovery(启动恢复) · system(系统信息) · ytdlp(子进程)
│       └── routes/api.ts    # REST API
├── web/                     # 前端（React + Vite + Tailwind）
│   └── src/
│       ├── pages/           # 首页 / 任务 / 历史 / Dashboard / 设置
│       ├── components/      # UI 组件库 + 图表(SVG) + 任务操作
│       ├── hooks/           # 轮询 / 任务 / 设置
│       ├── context/         # 主题 / Toast
│       └── lib/             # 类型 / API 客户端 / 格式化 / 常量
├── scripts/                 # media-server / e2e / stress / recovery 测试
├── downloads/               # 默认下载目录
├── data/                    # SQLite 数据库与 yt-dlp / 解析脚本日志
├── Dockerfile               # 多阶段构建
└── docker-compose.yml
```

## API 文档

Base URL：`/api`（开发模式前端经 Vite 代理到 3000）

### 解析与任务

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/parse` | `{url}` → 视频信息（平台/标题/画质/格式/大小/是否可下载/重复提示） |
| POST | `/tasks` | 创建任务 `{url, quality, format, folder?, title?, …}` |
| GET | `/tasks` | 列表，参数：`status`(逗号分隔) `platform` `search` `sort`(created_at/updated_at/completed_at/total_bytes) `order`(asc/desc) `limit` `offset` |
| GET | `/tasks/:id` | 任务详情 |
| POST | `/tasks/:id/pause` · `/resume` · `/cancel` · `/retry` | 任务控制 |
| DELETE | `/tasks/:id?file=1` | 删除记录（同时清理 `.part`）；`file=1` 时同时删除已下载文件 |
| POST | `/tasks/batch-delete` | 批量删除 `{ids: string[], withFiles?: boolean}` → `{deleted, filesDeleted, failed}` |
| POST | `/tasks/delete-all` | 删除全部（可选筛选条件）`{withFiles?, status?, platform?, search?}` → `{deleted, filesDeleted, failed}` |
| POST | `/tasks/:id/delete-file` | 仅删除实体文件（含 `.part`，保留历史记录） |
| POST | `/tasks/:id/open-folder` | 在文件管理器中定位文件 |

### 设置 / 统计 / 系统

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/PUT | `/settings` | 读取/修改设置（downloadQuality、downloadFormat、maxConcurrency(1/2/3/5/10)、downloadDir、maxSpeedKBps、timeoutSec、autoRetries、cookiesFile、proxyUrl）；保存目录必须存在且可写 |
| GET/POST | `/parsers` | 列出/新增自定义解析源 |
| PUT/DELETE | `/parsers/:id` | 更新/删除自定义解析源 |

解析源字段：`name`、`domains`（逗号分隔，支持子域名）、`type`（`ytdlp` / `script`）、`enabled`、`ytdlpArgs`（每行一个参数）、`headers`（JSON 对象）、`script`（命令模板，`{url}` 占位符）、`cookiesFile`。

脚本型解析源约定：脚本在 **stdout 输出一行 JSON**：

```json
{ "title": "可选标题", "thumbnail": "可选封面", "author": "可选作者",
  "durationSec": 0, "url": "必填，直链地址", "sizeBytes": 0,
  "headers": { "Referer": "可选请求头" } }
```

命令模板中未出现 `{url}` 时，页面链接会自动追加为最后一个参数。
| GET | `/stats` | overview（今日/已完成/下载中/失败/累计量/成功率）+ platforms + daily(14天) + recent |
| GET | `/platforms` | 任务中出现过的平台（含自定义解析源名称与数量，供历史页筛选用） |
| GET | `/system` | 版本、数据库状态、下载目录状态、磁盘剩余空间、队列状态 |
| GET | `/health` | 健康检查 |

### 错误格式

```json
{ "error": { "code": "VIDEO_NOT_FOUND", "message": "视频不存在或已被删除" } }
```

错误码：`INVALID_URL` `UNSUPPORTED_PLATFORM` `VIDEO_NOT_FOUND` `VIDEO_UNAVAILABLE` `AUTH_REQUIRED` `NETWORK_ERROR` `TIMEOUT` `DISK_FULL` `WRITE_ERROR` `YTDLP_MISSING` `BAD_REQUEST` `FORBIDDEN` `NOT_FOUND` `INTERNAL`

## 测试

```bash
# 启动本地媒体测试源（Range/限速/断流模拟，端口 8099）
npm run media-server

# API 冒烟测试（URL 校验/任务生命周期/暂停续传/失败处理/设置/统计）
npm run test:smoke

# 回归测试（断点续传字节校验/截断响应/等待任务暂停/路径穿越/跨站请求/设置校验等）
npm run test:regression

# 批量删除 API 验证
node scripts/batch-delete-test.mjs

# 浏览器自动化测试（需系统 Edge；覆盖首页/输入/校验/平台识别(YouTube/抖音)/任务/队列/进度/暂停/继续/取消/重试/失败原因/历史/Dashboard/设置/暗色模式/手机布局/拖拽/批量删除/全部删除）
npm run test:e2e

# 20 任务压力测试（并发限制/状态流转/失败处理/文件落盘/暂停续传）
npm run test:stress

# 服务重启恢复测试（两阶段）
node scripts/recovery.mjs prepare   # 创建中断任务并强杀服务
# …重启服务后…
node scripts/recovery.mjs verify    # 校验自动恢复与断点续传
```

## 常见问题

**Q：YouTube 等站点直连超时 / 403？**
在「设置 → 网络设置 → 代理服务器」填写本机代理地址（如 `http://127.0.0.1:10020`），或设置环境变量 `PROXY_URL`。代理会用于 yt-dlp 解析/下载、直链 HTTP(S) 下载与直链探测；本机与局域网地址自动直连。支持 HTTP(S) 与 SOCKS5 代理，修改后对之后发起的任务生效。

**Q：YouTube/Bilibili 解析后提示“服务器未安装 yt-dlp”？**
安装 yt-dlp 后重启服务：`python -m pip install --target tools/ytdlp yt-dlp`，或下载 `yt-dlp.exe` 放入 `tools/`。

**Q：抖音（Douyin）提示“需要新鲜 Cookie”？**
抖音当前对视频接口要求新鲜 Cookie（平台访问控制）。请在「设置 → 网络设置」中填写你的 Netscape 格式 `cookies.txt` 文件路径（用浏览器登录抖音后导出，仅用于你本人有权访问的内容），配置后重新解析即可；也可以使用 `v.douyin.com` 分享短链接。本应用不会尝试绕过该限制。

**Q：想下载的站点不在内置平台里？**
直接把链接粘贴到首页即可——应用会自动走 yt-dlp 通用解析（支持 1900+ 站点）。若某站点需要特殊参数、Cookie 或 yt-dlp 不支持，请在「设置 → 解析源」添加自定义解析源（yt-dlp 参数型或脚本型）。

**Q：某些平台解析失败？**
平台可能要求登录、地区限制或更改了接口。应用会返回明确错误（如“需要登录或存在访问控制”），不会尝试绕过限制；你可以改用直链下载。

**Q：MP3 / 合并音视频不可用？**
需要 ffmpeg。将 `ffmpeg.exe` 放入 `tools/` 或加入 PATH（Docker 镜像已内置）。

**Q：暂停后能恢复吗？重启后呢？**
能。暂停保留 `.part` 文件与已下载字节数，继续时通过 HTTP Range / yt-dlp `.part` 断点续传；服务重启后自动恢复未完成任务，已完成任务不会重复下载。续传以 `.part` 实际大小为准，进程崩溃导致数据库进度落后时也不会重复写入或损坏文件；连接被提前截断时任务会失败而不是生成残缺的“已完成”文件。

**Q：磁盘空间不足？**
下载前会检查剩余空间并给出“磁盘空间不足”提示；写入失败（ENOSPC）同样映射为明确错误。

**Q：端口冲突？**
设置 `PORT` 环境变量，或修改 `docker-compose.yml` 的端口映射。

## License

MIT（仅供学习与合法使用）
