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

安装依赖后运行，**80 秒内**（实测约 2–4 秒）自动完成以下验证并输出可读结果：

1. **翻页恢复**：采集第 2 页时会话被轮换，翻页签名失效返回 409，采集器重新取得入口页并补齐两页公告；
2. **临时限流**：站点返回 429 + `Retry-After` 时按站点给出的时间等待后继续；
3. **公告补采**：缺少入场时间 / 档期为“待定”的公告进入待补采，公告修正后重新采入；
4. **改场前后**：只有一端公告时继续展示最近一次已确认排期并标记待确认；两端到齐后才切换剧场与时间；
5. **重启与续采**：关闭并重新打开数据库后已确认排期仍可查询；采集中断后查询不受影响，随后续采成功；
6. **一致性**：按演出编号与按剧场查询使用同一份已确认结果；
7. **整页受损与断网补采**：版式认不出或公告容器缺失时，整页原文留存为“受损页”并继续翻页；解析修复后 `repair --offline` 不联网、按采集顺序回放受损页，原页下线或补采中断重启都能补完，最终排期/改场记录与顺序采集逐条一致；
8. 解析与折叠的边界检查（非法日期、占位文字、两端时间不一致、低修订号不覆盖等）。

另有快速单元检查：`npm run test:unit`。

### 整页受损 → 断网离线补采

```bash
# 1. 采集期遇到整页受损：原文自动留存，采集继续，可在 query pending 看到受损页
npm run collect -- --site http://127.0.0.1:8787
npm run query -- pending

# 2. 解析器修复（升级到新版式/容器容错）后，断网也能补：
npm run repair -- --offline
#    不发起任何网络请求，严格按受损页采集顺序回放本地原文；
#    原页已下线、或补采中途被打断，再次运行同一条命令即可接着补完。
```

## 业务规则

| 场景 | 行为 |
| --- | --- |
| 公告解析可靠 | 写入 `announcements`，参与排期折叠 |
| 无法可靠解析（缺时间、缺编号、时间非法等） | 标记为**待补采**，不影响其他公告；修正后重新采集即可进入排期 |
| 整页无法解析（版式认不出 / 公告容器缺失） | 整页原文留存到 `damaged_page_captures`，尽力找到下一页继续采集，不拖垮后续页面与其他剧场；解析修复后用 `repair --offline` 回放 |
| 同一页先后坏两次 / 公告回到旧内容 | 每次受损都各留一行原文，离线补采严格按采集顺序（`seq`）回放；最终排期与改场记录与在线顺序采集一致 |
| 离线补采 | `repair --offline` 不发起任何网络请求，只回放本地受损页；只写受损页涉及的公告历史，其他数据不动；原页下线、补采中断重启均可补完 |
| 同一演出跨剧场 | 沿用同一 `eventId`，按该演出的 `revision` 排序 |
| 改场 | 原剧场端与新剧场端分别发布；仅收到一端时继续展示最近一次已确认排期并标记“改场待确认” |
| 两端确认 | 方向一致且演出/入场时间一致，才对外切换剧场与时间 |
| 取消公告 | 独立生效，不需要另一端 |
| 查询一致性 | 采集结束后统一把结果折叠到 `effective_events` / `change_confirmations`；按编号与按剧场查询都只读这两张表 |
| 采集中断/重启 | 公告按 `ann_key` 幂等入库；启动时依据公告重建派生排期，已确认结果仍可查询，续采接上此前未确认的改场 |

## 数据模型

- `announcements`：每条公告一行（`ann_key` 为幂等键），保留原始 HTML、来源页、版式与解析状态；
- `damaged_page_captures`：整页无法解析时留存的原始页面，只追加不覆盖；`seq` 记录采集顺序，`repaired_at` 标记离线补采进度（中断重启后从未标记处继续）；
- `effective_events`：每个演出一行，服务台唯一对外使用的“已确认排期”（剧场、演出时间、入场时间、待确认/待补采标记）；
- `change_confirmations`：每个（演出, 修订号）的改场两端确认状态与理由；
- `venue_sync`：每个剧场最近一次采集的页数、翻页恢复次数、限流等待次数与错误。

## 目录结构

```
src/
  cli.ts                 命令行入口（mock / collect / query / repair / test）
  venues.ts              剧场代码与显示名
  core/types.ts          领域类型
  core/time.ts           时间规范化、Retry-After 解析
  core/effective.ts      公告 → 唯一已确认排期的折叠规则
  parse/parse.ts         新版/旧版/紧凑版 HTML 解析（cheerio），容器缺失容错
  parse/venues.ts        改场文本中的剧场识别
  collect/collector.ts   翻页、会话恢复、限流等待、受损页留存、幂等入库
  collect/offline-repair.ts 断网离线补采：按顺序回放受损页原文
  db/store.ts            DuckDB 存储与派生排期刷新
  query/desk.ts          查询服务（按编号 / 按剧场 / 待补采）
  query/view.ts          输出格式化
  mock/content.ts        模拟公告内容（三个剧场、三种版式、三个内容版本）
  mock/server.ts         模拟公告站（分页签名、会话轮换、429、故障与整页受损注入）
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

- 其他控制：`/_control/session/rotate`、`/_control/rotate-after`、`/_control/rate-limit`、`/_control/abort-after`、`/_control/stats`、`/_control/reset`。
- 整页受损注入（验证断网补采）：

```bash
# 某剧场某页持续返回无法识别版式（compact 公告板），直到 damage/clear
curl -X POST http://127.0.0.1:8787/_control/damage \
     -H 'content-type: application/json' \
     -d '{"venue":"studio","page":2,"mode":"unknown-layout"}'
# 或返回“版式认得但公告容器缺失”的页面
curl -X POST http://127.0.0.1:8787/_control/damage \
     -H 'content-type: application/json' \
     -d '{"venue":"harbor","page":1,"mode":"missing-container"}'
# 单独覆盖某剧场的内容版本，模拟同一公告回到旧内容
curl -X POST http://127.0.0.1:8787/_control/venue-version \
     -H 'content-type: application/json' -d '{"venue":"studio","version":1}'
```

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
