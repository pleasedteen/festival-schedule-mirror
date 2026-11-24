import { createHmac, randomBytes } from 'node:crypto';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { VENUES } from '../venues';
import {
  PAGE_SIZE,
  itemsForPage,
  pageCount,
  venueContent,
  type MockItem,
  type VenueContent,
} from './content';

interface SessionState {
  epoch: number;
  token: string;
}

interface MockStats {
  requests: number;
  venuePagesServed: number;
  pagingRecoveries: number;
  rateLimited: number;
  aborted: number;
  sessionRotations: number;
  damagedPagesServed: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function venueLabel(venueId: string): string {
  return VENUES[venueId] ?? venueId;
}

function timesFor(item: MockItem): { showTime?: string; doorsTime?: string } {
  return { showTime: item.showTime, doorsTime: item.doorsTime };
}

function renderV2Item(item: MockItem): string {
  const title = escapeHtml(item.title);
  const kind = escapeHtml(item.kind);
  const base = `data-kind="${kind}" data-event="${escapeHtml(item.eventId)}" data-revision="${item.revision}" data-site="${escapeHtml(item.siteId)}"`;
  const lines: string[] = [];
  if (item.kind !== 'cancel') {
    const { showTime, doorsTime } = timesFor(item);
    if (showTime) {
      lines.push(
        `<p class="line"><span>演出</span> <time class="show-time" data-time="${escapeHtml(showTime)}">${escapeHtml(showTime)}</time></p>`,
      );
    }
    if (doorsTime) {
      lines.push(
        `<p class="line"><span>入场</span> <time class="doors-time" data-time="${escapeHtml(doorsTime)}">${escapeHtml(doorsTime)}</time></p>`,
      );
    }
    if (item.kind === 'change') {
      lines.push(
        `<p class="move" data-from="${escapeHtml(item.fromVenue ?? '')}" data-to="${escapeHtml(item.toVenue ?? '')}">由 ${escapeHtml(venueLabel(item.fromVenue ?? ''))} 迁至 ${escapeHtml(venueLabel(item.toVenue ?? ''))}</p>`,
      );
    }
  } else {
    lines.push('<p class="line">本场演出取消</p>');
  }
  return `<article class="announcement" ${base}>
  <h2 class="title">${title}</h2>
  ${lines.join('\n  ')}
</article>`;
}

function legacyWhen(item: MockItem): string {
  const { showTime, doorsTime } = timesFor(item);
  return `演出时间：${showTime ?? '待定'}；入场时间：${doorsTime ?? '待定'}`;
}

function renderLegacyItem(item: MockItem): string {
  const title = escapeHtml(item.title);
  const dataKind =
    item.kind === 'cancel' ? '' : ` data-kind="${escapeHtml(item.kind)}"`;
  const base = `${dataKind} data-event="${escapeHtml(item.eventId)}" data-revision="${item.revision}" data-site="${escapeHtml(item.siteId)}"`;
  const parts: string[] = [];
  if (item.kind === 'cancel') {
    parts.push('<p class="kind-label">取消公告</p>');
    parts.push(`<h3 class="headline">${title}</h3>`);
  } else {
    if (item.kind === 'change') parts.push('<p class="kind-label">改场公告</p>');
    parts.push(`<h3 class="headline">${title}</h3>`);
    if (item.kind === 'change') {
      parts.push(
        `<p class="move">由 ${escapeHtml(venueLabel(item.fromVenue ?? ''))} 迁至 ${escapeHtml(venueLabel(item.toVenue ?? ''))}</p>`,
      );
    }
    parts.push(`<p class="when">${escapeHtml(legacyWhen(item))}</p>`);
  }
  return `<div class="notice"${base}>
  ${parts.join('\n  ')}
</div>`;
}

function renderPage(
  content: VenueContent,
  page: number,
  nextHref: string | null,
): string {
  const total = pageCount(content);
  const items = itemsForPage(content, page);
  const venue = escapeHtml(content.venueId);
  const label = `${page} / ${total}`;
  const heading = `${venueLabel(content.venueId)} · 公告`;

  if (content.layout === 'v2') {
    const nav = nextHref
      ? `<nav class="pager"><span class="page-label">第 ${label} 页</span><a rel="next" href="${escapeHtml(nextHref)}">下一页</a></nav>`
      : `<nav class="pager"><span class="page-label">第 ${label} 页</span><span>没有更多公告</span></nav>`;
    return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>${heading}</title></head>
<body data-layout="v2" data-venue="${venue}">
<header><h1>${heading}</h1></header>
<main class="announcement-list">
${items.map(renderV2Item).join('\n')}
</main>
${nav}
</body>
</html>`;
  }

  const pager = nextHref
    ? `<div class="pages"><span class="page-label">${label}</span><a href="${escapeHtml(nextHref)}">下一页</a></div>`
    : `<div class="pages"><span class="page-label">${label}</span><span>没有更多公告</span></div>`;
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>${heading}</title></head>
<body data-layout="legacy" data-venue="${venue}">
<header><h1>${heading}</h1></header>
<div id="notices" class="old-layout" data-venue="${venue}">
${items.map(renderLegacyItem).join('\n')}
</div>
${pager}
</body>
</html>`;
}

function renderRecoveryPage(venueId: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>翻页凭据失效</title></head>
<body><h1>翻页凭据已失效</h1>
<p>当前会话已更换，请从公告入口重新取得翻页位置。</p>
<a href="/venue/${escapeHtml(venueId)}">返回入口</a>
</body></html>`;
}

/**
 * 故障注入用的“紧凑公告板”版式：
 * 旧版解析器既不认识 data-layout="compact"，也没有 section.board 容器，
 * 会把整页判为无法识别；解析器升级后即可正常解析（离线补采演示）。
 */
function renderCompactItem(item: MockItem): string {
  const title = escapeHtml(item.title);
  const kind = escapeHtml(item.kind);
  const base = `data-kind="${kind}" data-event="${escapeHtml(item.eventId)}" data-revision="${item.revision}" data-site="${escapeHtml(item.siteId)}"`;
  const lines: string[] = [];
  if (item.kind !== 'cancel') {
    const { showTime, doorsTime } = timesFor(item);
    if (showTime) {
      lines.push(
        `<span class="show-time" data-time="${escapeHtml(showTime)}">${escapeHtml(showTime)}</span>`,
      );
    }
    if (doorsTime) {
      lines.push(
        `<span class="doors-time" data-time="${escapeHtml(doorsTime)}">${escapeHtml(doorsTime)}</span>`,
      );
    }
    if (item.kind === 'change') {
      lines.push(
        `<p class="relocate" data-from="${escapeHtml(item.fromVenue ?? '')}" data-to="${escapeHtml(item.toVenue ?? '')}">由 ${escapeHtml(venueLabel(item.fromVenue ?? ''))} 迁至 ${escapeHtml(venueLabel(item.toVenue ?? ''))}</p>`,
      );
    }
  } else {
    lines.push('<span class="cancelled">本场演出取消</span>');
  }
  return `<div class="card" ${base}>
  <h3 class="card-title">${title}</h3>
  ${lines.join('\n  ')}
</div>`;
}

/** 版式完全无法识别：不带任何已知 data-layout，容器也是全新的。 */
function renderUnknownLayoutPage(
  content: VenueContent,
  page: number,
  nextHref: string | null,
): string {
  const total = pageCount(content);
  const items = itemsForPage(content, page);
  const venue = escapeHtml(content.venueId);
  const label = `${page} / ${total}`;
  const nav = nextHref
    ? `<nav class="board-pager"><span class="page-label">${label}</span><a rel="next" href="${escapeHtml(nextHref)}">下一页</a></nav>`
    : `<nav class="board-pager"><span class="page-label">${label}</span><span>没有更多公告</span></nav>`;
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>${venueLabel(content.venueId)} · 公告板</title></head>
<body data-venue="${venue}">
<header><h1>${venueLabel(content.venueId)} · 公告板</h1></header>
<section class="board" data-venue="${venue}">
${items.map(renderCompactItem).join('\n')}
</section>
${nav}
</body>
</html>`;
}

/** 版式认得（v2）但公告容器缺失：article 散落在 main 之外。 */
function renderMissingContainerPage(
  content: VenueContent,
  page: number,
  nextHref: string | null,
): string {
  const total = pageCount(content);
  const items = itemsForPage(content, page);
  const venue = escapeHtml(content.venueId);
  const label = `${page} / ${total}`;
  const nav = nextHref
    ? `<nav class="pager"><span class="page-label">第 ${label} 页</span><a rel="next" href="${escapeHtml(nextHref)}">下一页</a></nav>`
    : `<nav class="pager"><span class="page-label">第 ${label} 页</span><span>没有更多公告</span></nav>`;
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>${venueLabel(content.venueId)} · 公告</title></head>
<body data-layout="v2" data-venue="${venue}">
<header><h1>${venueLabel(content.venueId)} · 公告（容器维护中）</h1></header>
<div class="orphans">
${items.map(renderV2Item).join('\n')}
</div>
${nav}
</body>
</html>`;
}

type DamageMode = 'unknown-layout' | 'missing-container';

interface DamageRule {
  mode: DamageMode;
  /** 已下发的受损页次数（每次命中累加）。 */
  hits: number;
  /** 最多下发多少次；缺省/0 表示持续生效，直到显式清除。 */
  times: number;
}

export interface MockSiteOptions {
  host?: string;
  port?: number;
  contentVersion?: number;
}

/**
 * 本地模拟公告站：
 * - 三个剧场、两种版式、分页；
 * - 翻页签名绑定当前会话与翻页令牌，会话轮换后旧翻页链接返回 409；
 * - 支持临时限流（429 + Retry-After）与故障注入（中断连接）。
 */
export class MockSite {
  private readonly server: http.Server;
  private readonly secret = randomBytes(16);
  private sessions = new Map<string, SessionState>();
  private epoch = 0;
  private contentVersion: number;
  private rotateAfter: number | null = null;
  private rateLimit: { seconds: number; remaining: number } | null = null;
  private abortAfter: number | null = null;
  /** 按剧场注入整页故障：key = venueId:page，命中一次扣减一次。 */
  private damageRules = new Map<string, DamageRule>();
  /** 按剧场覆盖内容版本（用于模拟同一公告回到旧内容）。 */
  private venueVersionOverride = new Map<string, number>();
  private venueRequestCount = 0;
  private readonly stats: MockStats = {
    requests: 0,
    venuePagesServed: 0,
    pagingRecoveries: 0,
    rateLimited: 0,
    aborted: 0,
    sessionRotations: 0,
    damagedPagesServed: 0,
  };
  private listening: Promise<void> | null = null;
  private boundPort = 0;
  private readonly host: string;

  constructor(options: MockSiteOptions = {}) {
    this.host = options.host ?? '127.0.0.1';
    this.contentVersion = options.contentVersion ?? 1;
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`mock site error: ${(error as Error).message}`);
      });
    });
  }

  get port(): number {
    return this.boundPort;
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.boundPort}`;
  }

  async listen(port?: number): Promise<number> {
    const target = port ?? 0;
    this.listening = new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(target, this.host, () => {
        this.boundPort = (this.server.address() as AddressInfo).port;
        this.server.off('error', reject);
        resolve();
      });
    });
    await this.listening;
    return this.boundPort;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  getInfo(): MockStats & { epoch: number; contentVersion: number } {
    return { ...this.stats, epoch: this.epoch, contentVersion: this.contentVersion };
  }

  private rotateSession(): void {
    this.epoch += 1;
    this.sessions.clear();
    this.stats.sessionRotations += 1;
  }

  private sessionFor(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): { sid: string; state: SessionState } {
    const cookie = req.headers.cookie ?? '';
    const match = cookie.match(/festival_sid=([^;]+)/);
    const sid = match?.[1];
    if (sid) {
      const existing = this.sessions.get(sid);
      if (existing && existing.epoch === this.epoch) return { sid, state: existing };
    }
    const newSid = `s${this.epoch}-${randomBytes(6).toString('hex')}`;
    const state: SessionState = {
      epoch: this.epoch,
      token: randomBytes(8).toString('hex'),
    };
    this.sessions.set(newSid, state);
    res.setHeader(
      'set-cookie',
      `festival_sid=${newSid}; Path=/; HttpOnly; SameSite=Lax`,
    );
    return { sid: newSid, state };
  }

  private signature(
    sid: string,
    state: SessionState,
    venueId: string,
    page: number,
  ): string {
    return createHmac('sha256', this.secret)
      .update(`${sid}:${state.token}:${venueId}:${page}:${state.epoch}`)
      .digest('hex')
      .slice(0, 20);
  }

  private currentSid(req: http.IncomingMessage): string | null {
    const cookie = req.headers.cookie ?? '';
    const match = cookie.match(/festival_sid=([^;]+)/);
    return match?.[1] ?? null;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.baseUrl);
    this.stats.requests += 1;

    if (url.pathname === '/_health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, ...this.getInfo() }));
      return;
    }

    if (url.pathname.startsWith('/_control/')) {
      await this.handleControl(url, req, res);
      return;
    }

    const entry = url.pathname.match(/^\/venue\/([^/]+)\/?$/);
    const paged = url.pathname.match(/^\/venue\/([^/]+)\/page\/(\d+)$/);
    if (!entry && !paged) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }

    const venueId = decodeURIComponent((entry ?? paged)![1]);
    const contentVersion = this.venueVersionOverride.get(venueId) ?? this.contentVersion;
    const content = venueContent(contentVersion, venueId);
    if (!content) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('unknown venue');
      return;
    }

    // 临时限流：按站点给出的 Retry-After 恢复访问。
    if (this.rateLimit && this.rateLimit.remaining > 0) {
      this.rateLimit.remaining -= 1;
      this.stats.rateLimited += 1;
      res.writeHead(429, {
        'content-type': 'text/plain; charset=utf-8',
        'retry-after': String(this.rateLimit.seconds),
      });
      res.end('服务繁忙，请稍后重试');
      return;
    }

    // 故障注入：在已服务若干页后中断连接，模拟采集中断。
    if (this.abortAfter !== null && this.stats.venuePagesServed >= this.abortAfter) {
      this.stats.aborted += 1;
      req.socket.destroy();
      return;
    }

    this.venueRequestCount += 1;
    if (this.rotateAfter !== null && this.venueRequestCount === this.rotateAfter) {
      this.rotateSession();
    }

    if (entry) {
      const { sid, state } = this.sessionFor(req, res);
      const nextHref =
        pageCount(content) > 1
          ? `/venue/${venueId}/page/2?sig=${this.signature(sid, state, venueId, 2)}`
          : null;
      this.stats.venuePagesServed += 1;
      const damaged = this.takeDamage(venueId, 1, content, nextHref);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(damaged ?? renderPage(content, 1, nextHref));
      return;
    }

    const page = Number((paged as RegExpMatchArray)[2]);
    const sid = this.currentSid(req);
    const state = sid ? this.sessions.get(sid) : undefined;
    const inRange = Number.isInteger(page) && page >= 1 && page <= pageCount(content);
    const expected =
      sid && state && inRange ? this.signature(sid, state, venueId, page) : null;
    const provided = url.searchParams.get('sig') ?? '';
    const valid =
      Boolean(sid && state) &&
      state!.epoch === this.epoch &&
      expected !== null &&
      expected === provided;

    if (!valid) {
      this.stats.pagingRecoveries += 1;
      res.writeHead(409, {
        'content-type': 'text/html; charset=utf-8',
        'x-paging-recovery': 'entry',
      });
      res.end(renderRecoveryPage(venueId));
      return;
    }

    const nextHref =
      page < pageCount(content)
        ? `/venue/${venueId}/page/${page + 1}?sig=${this.signature(sid!, state!, venueId, page + 1)}`
        : null;
    this.stats.venuePagesServed += 1;
    const damaged = this.takeDamage(venueId, page, content, nextHref);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(damaged ?? renderPage(content, page, nextHref));
  }

  /** 命中故障规则时返回受损页面 HTML，否则返回 null（正常页面）。 */
  private takeDamage(
    venueId: string,
    page: number,
    content: VenueContent,
    nextHref: string | null,
  ): string | null {
    const key = `${venueId}:${page}`;
    const rule = this.damageRules.get(key);
    if (!rule) return null;
    if (rule.times > 0 && rule.hits >= rule.times) return null;
    rule.hits += 1;
    this.stats.damagedPagesServed += 1;
    return rule.mode === 'missing-container'
      ? renderMissingContainerPage(content, page, nextHref)
      : renderUnknownLayoutPage(content, page, nextHref);
  }

  private async handleControl(
    url: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await this.readBody(req);
    const payload = body ? (JSON.parse(body) as Record<string, unknown>) : {};
    const action = url.pathname.slice('/_control/'.length);
    let response: Record<string, unknown> = { ok: true };

    switch (action) {
      case 'reset':
        this.sessions.clear();
        this.epoch += 1;
        this.rotateAfter = null;
        this.rateLimit = null;
        this.abortAfter = null;
        this.damageRules.clear();
        this.venueVersionOverride.clear();
        this.venueRequestCount = 0;
        this.stats.requests = 0;
        this.stats.venuePagesServed = 0;
        this.stats.pagingRecoveries = 0;
        this.stats.rateLimited = 0;
        this.stats.aborted = 0;
        this.stats.sessionRotations = 0;
        this.stats.damagedPagesServed = 0;
        if (typeof payload.contentVersion === 'number') {
          this.contentVersion = payload.contentVersion;
        }
        break;
      case 'content':
        this.contentVersion = Number(payload.version ?? this.contentVersion);
        response = { ok: true, contentVersion: this.contentVersion };
        break;
      case 'session/rotate':
        this.rotateSession();
        response = { ok: true, epoch: this.epoch };
        break;
      case 'rotate-after':
        this.rotateAfter = Number(payload.count ?? 0) || null;
        this.venueRequestCount = 0;
        response = { ok: true, rotateAfter: this.rotateAfter };
        break;
      case 'rate-limit':
        this.rateLimit =
          Number(payload.remaining ?? 0) > 0
            ? {
                seconds: Number(payload.seconds ?? 1),
                remaining: Number(payload.remaining ?? 1),
              }
            : null;
        response = { ok: true, rateLimit: this.rateLimit };
        break;
      case 'abort-after':
        this.abortAfter =
          payload.count === null || payload.count === undefined
            ? null
            : Number(payload.count);
        response = { ok: true, abortAfter: this.abortAfter };
        break;
      case 'damage': {
        // 注入整页故障：{ venue, page, mode, times }
        // times 为命中次数上限，0/缺省表示持续生效直到 damage/clear。
        const venue = String(payload.venue ?? '');
        const page = Number(payload.page ?? 1);
        const mode = payload.mode === 'missing-container'
          ? 'missing-container'
          : 'unknown-layout';
        const times = Math.max(0, Number(payload.times ?? 0));
        this.damageRules.set(`${venue}:${page}`, { mode, hits: 0, times });
        response = { ok: true, damage: { venue, page, mode, times } };
        break;
      }
      case 'damage/clear':
        this.damageRules.clear();
        break;
      case 'venue-version': {
        // 覆盖单个剧场的内容版本，模拟同一公告回到旧内容。
        const venue = String(payload.venue ?? '');
        if (payload.version === null || payload.version === undefined) {
          this.venueVersionOverride.delete(venue);
        } else {
          this.venueVersionOverride.set(venue, Number(payload.version));
        }
        response = { ok: true, venue, version: this.venueVersionOverride.get(venue) ?? null };
        break;
      }
      case 'stats':
        response = { ok: true, ...this.getInfo() };
        break;
      default:
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'unknown control action' }));
        return;
    }

    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(response));
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
}

export { PAGE_SIZE };
