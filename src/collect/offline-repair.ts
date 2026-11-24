import { parsePage } from '../parse/parse';
import type { Store } from '../db/store';
import type { Layout, ParsedPage } from '../core/types';

export interface OfflineRepairOptions {
  /** 注入日志，测试里可静默。 */
  log?: (message: string) => void;
  /**
   * 最多回放多少个受损页（不含已补采的）。
   * 用于模拟补采中断；不传则一次补完。
   */
  maxCaptures?: number;
  /** 解析器当前可识别的版式；不传表示全部支持（已修复）。 */
  layouts?: Layout[];
  /** 是否容忍公告容器缺失；受限版式（修复前）下应关闭。 */
  tolerateMissingContainer?: boolean;
  /** 起始回放时刻，测试可注入固定时钟。 */
  startAt?: Date;
}

export interface OfflineRepairResult {
  total: number;
  replayed: number;
  remaining: number;
  announcements: number;
  inserted: number;
  changed: number;
  stillFailing: number;
  interrupted: boolean;
  ok: boolean;
}

/**
 * 离线补采：不发起任何网络请求，只回放采集时留存的受损页原文。
 *
 * - 严格按受损页的采集顺序（seq）回放，同一页坏两次或公告回到旧内容时，
 *   最终排期与改场记录与在线顺序采集一致；
 * - 每个受损页独立处理，回放成功即标记 repaired_at；补采中断后重启，
 *   已标记的页面不会重复回放，未标记的页面接着补；
 * - 只写受损页解析出的公告，其他剧场/页面的数据完全不动；
 * - 原页下线也不影响补采，因为解析所需的原文已在本地。
 */
export class OfflineRepair {
  private readonly log: (message: string) => void;

  constructor(private readonly store: Store, options: OfflineRepairOptions = {}) {
    this.log = options.log ?? (() => undefined);
    this.maxCaptures = options.maxCaptures;
    this.layouts = options.layouts;
    this.tolerateMissingContainer = options.tolerateMissingContainer ?? true;
    this.clock = options.startAt ?? new Date();
  }

  private readonly maxCaptures?: number;
  private readonly layouts?: Layout[];
  private readonly tolerateMissingContainer: boolean;
  private clock: Date;

  private tick(): string {
    // 单调递增的回放时刻：保证后回放的采集结果在 updated_at 上一定更晚。
    this.clock = new Date(this.clock.getTime() + 1);
    return this.clock.toISOString();
  }

  async run(): Promise<OfflineRepairResult> {
    const pending = await this.store.pendingDamagedPages();
    const limit = this.maxCaptures ?? pending.length;
    const batch = pending.slice(0, limit);
    const interrupted = batch.length < pending.length;

    let replayed = 0;
    let announcements = 0;
    let inserted = 0;
    let changed = 0;
    let stillFailing = 0;

    for (const capture of batch) {
      let parsed: ParsedPage;
      try {
        parsed = parsePage(
          capture.rawHtml,
          capture.sourceUrl,
          capture.sourcePage,
          capture.venueId,
          {
            layouts: this.layouts,
            tolerateMissingContainer: this.tolerateMissingContainer,
          },
        );
      } catch (error) {
        // 解析器仍无法处理（例如修复尚未发布）：保持待补采，下次再试。
        stillFailing += 1;
        this.log(
          `  受损页 #${capture.seq}（${capture.venueId} 第 ${capture.sourcePage} 页）仍无法解析：${(error as Error).message}`,
        );
        continue;
      }

      const replayAt = this.tick();
      const write = await this.store.upsertPage(parsed.announcements, replayAt, replayAt);
      await this.store.markDamagedPageRepaired(capture.seq, replayAt);
      replayed += 1;
      announcements += parsed.announcements.length;
      inserted += write.inserted;
      changed += write.changed;
      this.log(
        `  受损页 #${capture.seq}（${capture.venueId} 第 ${capture.sourcePage} 页，${parsed.layout}）` +
          `回放 ${parsed.announcements.length} 条，新增 ${write.inserted} / 更新 ${write.changed}`,
      );
    }

    await this.store.refreshEffective();

    const remaining = (await this.store.pendingDamagedPages()).length;
    return {
      total: pending.length,
      replayed,
      remaining,
      announcements,
      inserted,
      changed,
      stillFailing,
      interrupted,
      ok: !interrupted && stillFailing === 0 && remaining === 0,
    };
  }
}
