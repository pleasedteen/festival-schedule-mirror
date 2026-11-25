# 戏剧节服务台

从各剧场的 HTML 公告中采集现行排期，回答“到哪个剧场、几点入场”。
项目使用 **TypeScript + Node.js + DuckDB**，自带可在本地运行的模拟公告站。

## 快速开始

```bash
npm install          # 安装依赖（含 DuckDB 预编译二进制）
npm run build        # 编译到 dist/

# 终端 1：启动模拟公告站（默认 http://127.0.0.1:8787）
npm run mock

# 终端 2：采集并查询
npm run collect -- --site http://127.0.0.1:8787
npm run query -- event E-1005
npm run query -- venue studio
npm run query -- all
npm run query -- pending
```

默认数据库为 `data/festival.duckdb`，可用 `--db <路径>` 指定。

### 一条命令验证

```bash
npm test
```

安装依赖后运行，**80 秒内**（实测约 10–16 秒）自动完成以下验证并输出可读结果：

1. **翻页恢复**：采集第 2 页时会话被轮换，翻页签名失效返回 409，采集器重新取得入口页并补齐两页公告；
2. **临时限流**：站点返回 429 + `Retry-After` 时按站点给出的时间等待后继续；
3. **公告补采**：缺少入场时间 / 档期为“待定”的公告进入待补采，公告修正后重新采入；
4. **暂停中的并发只读**：采集翻到一半、正等下一页时，另一进程只读查询按编号 / 按剧场 / 待补采，看到的都是上次已发布的数据，不被采到一半的公告污染；
5. **改场前后**：只有一端公告时继续展示最近一次已确认排期并标记待确认；两端到齐后才切换剧场与时间；
6. **中断、重启与续采**：采到一半的剧场本次不发布，查询沿用上次已发布的公告；重启后已确认排期仍可查询；续采到末页后发布，中断前已入库的公告照常参与改场确认；
7. **一致性**：按演出编号与按剧场查询使用同一份已确认结果；
8. 解析与折叠的边界检查（非法日期、占位文字、两端时间不一致、低修订号不覆盖等）。

另有快速单元检查：`npm run test:unit`。

## 业务规则

| 场景 | 行为 |
| --- | --- |
| 公告解析可靠 | 写入 `announcements` 工作区，随剧场发布进入排期 |
| 无法可靠解析（缺时间、缺编号、时间非法等） | 标记为**待补采**，不影响其他公告；修正后重新采集即可进入排期 |
| 剧场翻到末页 | 该剧场工作区公告整体**发布**到 `published_announcements`，并同事务刷新派生排期 |
| 剧场采到一半（失败/页数上限） | 本次**不发布**，按编号、按剧场、待补采查询都沿用上次已发布的公告 |
| 采集正等下一页 | 采集器写库短开短关、等待期间不占用数据库，另一进程可只读查询已发布数据 |
| 同一演出跨剧场 | 沿用同一 `eventId`，按该演出的 `revision` 排序 |
| 改场 | 原剧场端与新剧场端分别发布；仅收到一端时继续展示最近一次已确认排期并标记“改场待确认” |
| 两端确认 | 方向一致且演出/入场时间一致，才对外切换剧场与时间 |
| 取消公告 | 独立生效，不需要另一端 |
| 查询一致性 | 按编号与按剧场查询都只读 `effective_events` / `change_confirmations`（由已发布公告折叠），待补采读 `published_announcements` |
| 采集中断/重启 | 公告按 `ann_key` 幂等入库留在工作区；重启后已发布数据立即可查，续采到末页后中断前入库的公告随该剧场一起发布、参与改场确认 |

## 数据模型

- `announcements`：采集工作区，每条公告一行（`ann_key` 为幂等键），保留原始 HTML、来源页、版式与解析状态；采到一半的公告也留在这里，但不对外可见；
- `published_announcements`：发布快照，只有翻到末页的剧场才会把工作区公告发布到这里，是服务台对外数据的唯一来源；
- `effective_events`：每个演出一行，服务台唯一对外使用的“已确认排期”（剧场、演出时间、入场时间、待确认/待补采标记），由已发布快照折叠；
- `change_confirmations`：每个（演出, 修订号）的改场两端确认状态与理由，同样由已发布快照折叠；
- `venue_sync`：每个剧场最近一次采集的状态（`collecting` 进行中 / `ok` 已发布 / `failed` 失败 / `incomplete` 未翻到末页）、页数、翻页恢复次数、限流等待次数与错误。

## 目录结构

```
src/
  cli.ts                 命令行入口（mock / collect / query / repair / test）
  venues.ts              剧场代码与显示名
  core/types.ts          领域类型
  core/time.ts           时间规范化、Retry-After 解析
  core/effective.ts      已发布公告 → 唯一已确认排期的折叠规则
  parse/parse.ts         新版/旧版 HTML 解析（cheerio）
  parse/venues.ts        改场文本中的剧场识别
  collect/collector.ts   翻页、会话恢复、限流等待、写库短开短关、翻到末页即发布
  db/store.ts            DuckDB 存储、发布快照与派生排期刷新、只读打开
  query/desk.ts          查询服务（按编号 / 按剧场 / 待补采，只读已发布数据）
  query/view.ts          输出格式化
  mock/content.ts        模拟公告内容（三个剧场、两种版式、三个内容版本）
  mock/server.ts         模拟公告站（分页签名、会话轮换、429、故障注入）
  test/e2e.ts            端到端验证（npm test）
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

- 其他控制：`/_control/session/rotate`、`/_control/rotate-after`、`/_control/rate-limit`（支持 `after`，已服务 N 页后才限流，用于模拟“采到一半正等下一页”）、`/_control/abort-after`、`/_control/stats`、`/_control/reset`。

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
