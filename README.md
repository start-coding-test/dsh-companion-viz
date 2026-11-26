# dsh-companion-viz

只读的 dsh-companion 记忆快照可视化：今天、上下文时间轴和记忆库。Node 24，运行时零第三方依赖。使用上游 `dsh-companion` v0.7.20 的数据库结构；不提供写入、鉴权或实时连接生产库的功能。

## 环境与运行

- Node.js 24；生成快照需要 Linux 的 `sqlite3`、`realpath`、`stat`、`mktemp`。
- `VIZ_SNAPSHOT`：只读快照路径，默认 `./data/snapshot.db`。
- `VIZ_PORT`：端口，默认 `50090`。服务仅监听 `127.0.0.1`。

```sh
npm start
# 浏览 http://127.0.0.1:50090
```

快照不存在时页面提示而非报错。每次 API 请求均以 `DatabaseSync({readOnly:true})` 打开快照；网页进程从不打开生产数据库。敏感记录默认折叠；私密记录在服务端脱敏。此应用无鉴权，请勿直接暴露到公网。

## 快照

由部署方在拥有适当权限的主机上执行（与网页进程分离）：

```sh
sh scripts/snapshot.sh /path/to/production.db /path/to/snapshot.db
# 或省略第二参数，使用 VIZ_SNAPSHOT 或默认路径
```

脚本以 `umask 077` 限制新快照权限，用 `sqlite3 -readonly` 对源库执行 `VACUUM INTO` 写入目标目录临时文件，再原子 `mv` 覆盖快照。同一快照文件的修改时间距今不足 10 分钟时跳过，锁目录防止并发。源与目标必须不同。发生错误时保留旧快照；若异常中断残留 `snapshot.db.lock`，确认无其他快照进程后再删除锁目录。生产库、快照、日志与环境变量文件均不应提交。

## 测试与虚构数据

```sh
npm test
TZ=UTC npm test
TZ=Asia/Shanghai npm test
TZ=America/New_York npm test
node scripts/make-fixture.js ./data/fixture.db
VIZ_SNAPSHOT=./data/fixture.db npm start
```

夹具脚本拒绝覆盖已有文件；内容全部虚构。`scripts/schema-v0.7.20.sql` 由上游 tag `v0.7.20` 的 `src/memory/store.js` 中 `SCHEMA_SQL` 和三个 DDL 函数展开所得，作为测试夹具的结构来源。

## systemd --user 示例

修改路径后将下例保存为 `~/.config/systemd/user/dsh-companion-viz.service`。这里只是示例，不会自动安装或启动：

```ini
[Unit]
Description=DSH companion read-only snapshot visualizer
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/USER/dsh-companion-viz
Environment=VIZ_SNAPSHOT=/home/USER/dsh-companion-viz/data/snapshot.db
Environment=VIZ_PORT=50090
ExecStart=/usr/bin/node /home/USER/dsh-companion-viz/server.js
Restart=on-failure

[Install]
WantedBy=default.target
```

执行 `systemctl --user daemon-reload` 后可用 `systemctl --user enable --now dsh-companion-viz`。程序固定只绑定 `127.0.0.1`；快照刷新需另行调度。

## Tailscale 接入

由部署方配置访问控制与 Serve，示例（请按实际端口调整）：

```sh
tailscale serve --bg --https=443 http://127.0.0.1:50090
```

不要启用 Tailscale Funnel。该应用本身没有登录或授权，务必通过 Tailscale 的访问策略限制访问。

## 接口（GET）

- `/api/status`：`available`, `snapshot_mtime`。
- `/api/today?date=YYYY-MM-DD`：`available`, `date`, `today_main_usage`（上海当天 `source=main` 的 `input_tokens` 之和，无记录时为 0）, `compact_floor`（最近一次压缩后的实测上下文 tokens；缺失为 null）, `counts`（`action`, `count`）, `backfill_cursor`, `backfill_day`（`date`, `count`）, `latest`（`id`, `kind`, `trigger`, `status`, `started_at`, `finished_at`）, `reminders`。日期可省略，默认上海当天。
- `/api/events?date=YYYY-MM-DD&action=ADD`：`events`，每项 `id`, `at`, `action`, `table_name`, `row_id`, `actor`, `reason`, `statement`, `sensitive`；日期及动作可省略。私密关联事件及找不到关联事实或情景的事件，其 reason 脱敏。
- `/api/timeline`：`consolidations`（`id`, `scope`, `kind`, `trigger`, `status`, `upto_seq`, `started_at`, `finished_at`）, `watermark`, `backfill_cursor`。
- `/api/consolidations/:id/episodes`：`episodes`，普通或敏感记录含 `id`, `status`, `started_at`, `ended_at`, `created_at`, `title`, `summary`, `sensitive`；私密记录只含 ID、状态、时间及脱敏文本。
- `/api/facts?scope=&kind=&source_kind=&salience=&status=active&q=&page=1`：`facts`, `page`, `page_size`, `total`。普通或敏感事实含 `id`, `scope`, `kind`, `statement`, `source_kind`, `salience`, `status`, `observed_at`, `last_reinforced_at`, `used_count`, `created_at`, `updated_at`, `sensitive`；私密事实只含 ID、状态、时间及脱敏文本。`status=all` 包含所有状态；关键字按字面 LIKE 匹配；按范围、类型、来源、显著性或关键字筛选时排除私密事实，避免通过筛选结果推断其隐藏属性。
- `/api/facts/:id/events`：`events`，字段同 `/api/events`，按时间升序。

所有返回的数字时间戳均为 Unix 秒，`snapshot_mtime` 为 ISO 时间。`token_usage.at` 在数据库中为毫秒，但该接口不返回该字段。不存在快照时 API 返回 `available: false`, `message`, `snapshot_mtime: null`。非 GET 一律返回 405。
