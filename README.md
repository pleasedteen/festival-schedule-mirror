# 戏剧节服务台

从各剧场的 HTML 公告中采集现行排期，回答“到哪个剧场、几点入场”。
几家剧场的公告已迁到不同站点：同一次 collect 按“剧场 → 站点”配置分别采集，
再把各站公告汇总折叠为同一份排期。
项目使用 **TypeScript + Node.js + DuckDB**，自带可在本地运行的模拟公告站。

## 快速开始

```bash
npm install          # 安装依赖（含 DuckDB 预编译二进制）
npm run build        # 编译到 dist/

# 终端 1：启动两个本地模拟公告站（分别监听 8787 / 8790）
npm run mock -- --port 8787
npm run mock -- --port 8790

# 终端 2：多站采集（按剧场配置各自站点）并查询
printf '{"grand":"http://127.0.0.1:8787","studio":"http://127.0.0.1:8787","harbor":"http://127.0.0.1:8790"}' > venues.json
npm run collect -- --config venues.json
npm run query -- event E-1005
npm run query -- venue studio
npm run query -- all
npm run query -- pending
```

### 单站用法（保留兼容）

不传多站配置时，行为与原来一致，所有剧场都从同一站点采集：

```bash
npm run collect -- --site http://127.0.0.1:8787
# 也可只采部分剧场
npm run collect -- --site http://127.0.0.1:8787 --venue grand --venue studio
```

### 剧场站点配置的三种写法

| 方式 | 说明 |
| --- | --- |
| `--site URL` | 单站：本次所有剧场走同一站点（默认 `http://127.0.0.1:8787`） |
| `--config 路径.json` | 多站：JSON 内容为 `{ "剧场代码": "站点URL" }`，未列出的剧场回退到 `--site` |
| `--venue-site grand=http://host:port` | 多站：可重复，单独指定某剧场站点，与 `--config` 叠加时优先级更高 |

`repair` 优先沿用每个剧场上次采集时记录在 `venue_sync.site_base_url` 的站点，
命令行配置仅作兜底。

默认数据库为 `data/festival.duckdb`，可用 `--db <路径>` 指定。

### 一条命令验证

```bash
npm test
```

安装依赖后运行，**80 秒内**（实测约 5 秒）自动拉起**两个本地模拟站**，
完成以下验证并输出可读的采集顺序、限流恢复与排期检查结果：

1. **多站配置与采集顺序**：grand/studio 配置在 A 站、harbor 在 B 站；采集按站点分组，
   同站剧场连续采集（grand → studio）再采另一站（harbor），同站共享会话并演示翻页 409 恢复；
2. **同站 429 共享等待**：A 站返回一次 429 + `Retry-After` 后，同站两个剧场共用一个恢复时刻、
   只等待一次；B 站完全不受影响、照常采集；
3. **等待超单次上限**：`Retry-After` 超过单次上限时持久化站点给出的恢复时刻，本轮跳过同站剧场、
   其他站点照常；
4. **重启与 repair 遵守站点时间**：重开数据库后立即跑 collect / repair，未到恢复时刻的站点
   不发请求直接跳过；恢复时刻过后自动清掉限流记录并续采成功；
5. **公告补采**：缺少入场时间 / 档期为“待定”的公告进入待补采，公告修正后按各自站点重新采入；
6. **跨站改场两端确认**：改场一端公告在 A 站、另一端在 B 站；仅一端时继续展示最近一次已确认排期
   并标记待确认，两端到齐后才切换剧场与时间；
7. **汇总与一致性**：两个站点的公告汇总为同一份 `effective_events`，按演出编号与按剧场查询结果一致；
8. 解析、限流闸门与折叠的边界检查（非法日期、占位文字、两端时间不一致、低修订号不覆盖等）。

另有快速单元检查：`npm run test:unit`。

## 业务规则

| 场景 | 行为 |
| --- | --- |
| 公告迁到不同站点 | 按“剧场 → 站点”配置分别采集；同站剧场共享会话与限流状态，结果汇总到同一数据库折叠 |
| 同站某剧场收到 429 + Retry-After | 等待未超单次上限时按站点给出的时间等待，**同站所有剧场一并等待**，到点继续 |
| 等待超过单次上限 | 把站点给出的恢复时刻持久化，本轮跳过同站剧场；**其他站点照常采集** |
| 重启后再跑 collect / repair | 读入持久化的站点恢复时刻，未到点不发请求直接跳过，到点自动恢复并清除记录 |
| 公告解析可靠 | 写入 `announcements`，参与排期折叠 |
| 无法可靠解析（缺时间、缺编号、时间非法等） | 标记为**待补采**，不影响其他公告；修正后重新采集即可进入排期 |
| 同一演出跨剧场 | 沿用同一 `eventId`，按该演出的 `revision` 排序 |
| 改场（可跨站点） | 原剧场端与新剧场端分别发布；仅收到一端时继续展示最近一次已确认排期并标记“改场待确认” |
| 两端确认 | 方向一致且演出/入场时间一致，才对外切换剧场与时间 |
| 取消公告 | 独立生效，不需要另一端 |
| 查询一致性 | 采集结束后统一把结果折叠到 `effective_events` / `change_confirmations`；按编号与按剧场查询都只读这两张表 |
| 采集中断/重启 | 公告按 `ann_key` 幂等入库；启动时依据公告重建派生排期，已确认结果仍可查询，续采接上此前未确认的改场 |

## 数据模型

- `announcements`：每条公告一行（`ann_key` 为幂等键），保留原始 HTML、来源页、版式与解析状态；
- `effective_events`：每个演出一行，服务台唯一对外使用的“已确认排期”（剧场、演出时间、入场时间、待确认/待补采标记）；
- `change_confirmations`：每个（演出, 修订号）的改场两端确认状态与理由；
- `venue_sync`：每个剧场最近一次采集的站点（`site_base_url`）、页数、翻页恢复次数、限流等待次数与错误；
- `site_rate_limits`：每个站点的限流恢复时刻（绝对时间）与请求的等待时长；重启后 collect / repair 据此继续遵守站点时间。

## 目录结构

```
src/
  cli.ts                 命令行入口（mock / collect / query / repair / test）
  venues.ts              剧场代码与显示名
  core/types.ts          领域类型
  core/time.ts           时间规范化、Retry-After 解析
  core/rateLimit.ts      站点级限流闸门（同站共享、恢复时刻持久化）
  core/effective.ts      公告 → 唯一已确认排期的折叠规则
  parse/parse.ts         新版/旧版 HTML 解析（cheerio）
  parse/venues.ts        改场文本中的剧场识别
  collect/config.ts      “剧场 → 站点”配置解析（--site / --config / --venue-site）
  collect/collector.ts   按站点分组采集、翻页恢复、同站限流等待、幂等入库
  db/store.ts            DuckDB 存储与派生排期刷新
  query/desk.ts          查询服务（按编号 / 按剧场 / 待补采）
  query/view.ts          输出格式化
  mock/content.ts        模拟公告内容（三个剧场、两种版式、三个内容版本）
  mock/server.ts         模拟公告站（分页签名、会话轮换、429、故障注入）
  test/e2e.ts            双站点端到端验证（npm test）
  test/unit.ts           解析、限流闸门与折叠的单元检查
```

## 模拟公告站

- 入口：`/venue/grand`、`/venue/studio`、`/venue/harbor`；
- 每页 2 条公告，共 2–4 页；`grand`/`harbor` 为新版式，`studio` 为旧版式；
- 翻页链接形如 `/venue/grand/page/2?sig=...`，签名绑定会话 cookie 与翻页令牌；会话轮换后旧链接返回 `409`；
- 内容版本（演示/测试用）：

```bash
curl -X POST http://127.0.0.1:8787/_control/content \
     -H 'content-type: application/json' -d '{"version":2}'
```

  | 版本 | 变化 |
  | --- | --- |
  | 1 | 初始公告（含待补采） |
  | 2 | 海港剧场修正《暴风雨》入场时间；实验剧场补全《等待戈多》档期 |
  | 3 | 海港剧场补发 E-1005 改场公告，与实验剧场一端配对确认 |

- 其他控制：`/_control/session/rotate`、`/_control/rotate-after`、`/_control/rate-limit`、`/_control/abort-after`、`/_control/stats`、`/_control/reset`。

## 查询输出示例

```text
$ npm run query -- event E-1005
演出 E-1005  海鸥
状态 已确认
E-1005  海鸥  实验剧场 2026-12-22 19:00 入场 2026-12-22 18:15 · 修订 2 · 另有改场待确认
    修订 3 改场 studio → harbor 待确认：仅收到原剧场（studio）公告，等待新剧场（harbor）确认
改场记录：
  E-1005 修订 2：大剧院 → 实验剧场  已确认（两端公告一致），2026-12-22 19:00 入场 2026-12-22 18:15
  E-1005 修订 3：实验剧场 → 海港剧场  待确认（仅收到原剧场（studio）公告，等待新剧场（harbor）确认）
```
