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
  detailRequests: number;
  detailQuotaExhausted: number;
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

function renderStubEntry(item: MockItem, detailHref: string): string {
  return `<article class="entry" data-event="${escapeHtml(item.eventId)}" data-revision="${item.revision}" data-site="${escapeHtml(item.siteId)}">
  <span class="code">${escapeHtml(item.eventId)}</span> <span class="rev">修订 ${item.revision}</span>
  <a class="detail-link" href="${escapeHtml(detailHref)}">详情</a>
</article>`;
}

function renderPage(
  content: VenueContent,
  page: number,
  nextHref: string | null,
  detailHref?: (siteId: string) => string,
): string {
  const total = pageCount(content);
  const items = itemsForPage(content, page);
  const venue = escapeHtml(content.venueId);
  const label = `${page} / ${total}`;
  const heading = `${venueLabel(content.venueId)} · 公告`;

  if (content.layout === 'stub') {
    const nav = nextHref
      ? `<nav class="pager"><span class="page-label">第 ${label} 页</span><a rel="next" href="${escapeHtml(nextHref)}">下一页</a></nav>`
      : `<nav class="pager"><span class="page-label">第 ${label} 页</span><span>没有更多公告</span></nav>`;
    return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>${heading}</title></head>
<body data-layout="stub" data-venue="${venue}">
<header><h1>${heading}</h1></header>
<main class="announcement-index">
${items.map((item) => renderStubEntry(item, detailHref ? detailHref(item.siteId) : '#')).join('\n')}
</main>
${nav}
</body>
</html>`;
  }

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

/** 详情正文页：沿用新版式（v2）渲染单条公告。 */
function renderDetailPage(content: VenueContent, item: MockItem): string {
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>公告详情 ${escapeHtml(item.siteId)}</title></head>
<body data-layout="v2" data-venue="${escapeHtml(content.venueId)}">
<header><h1>${venueLabel(content.venueId)} · 公告详情</h1></header>
<main class="announcement-list">
${renderV2Item(item)}
</main>
</body>
</html>`;
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
 * - 支持临时限流（429 + Retry-After）与故障注入（中断连接）；
 * - 摘要列表剧场（ring）：列表只给编号/修订/详情入口，详情链接同样绑定会话；
 *   详情请求有每轮额度（403 告知用完），可注入“详情与列表不符”的正文。
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
  private detailQuota: number | null = null;
  private detailMismatch = new Map<string, Partial<MockItem>>();
  private venueRequestCount = 0;
  private readonly stats: MockStats = {
    requests: 0,
    venuePagesServed: 0,
    pagingRecoveries: 0,
    rateLimited: 0,
    aborted: 0,
    sessionRotations: 0,
    detailRequests: 0,
    detailQuotaExhausted: 0,
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
    page: number | string,
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
    const detail = url.pathname.match(/^\/venue\/([^/]+)\/detail\/([^/]+)$/);
    if (!entry && !paged && !detail) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }

    const venueId = decodeURIComponent((entry ?? paged ?? detail)![1]);
    const content = venueContent(this.contentVersion, venueId);
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

    if (detail) {
      this.handleDetail(req, res, detail, content, url);
      return;
    }

    const detailHref = (sid: string, state: SessionState) => (siteId: string) =>
      `/venue/${encodeURIComponent(venueId)}/detail/${encodeURIComponent(siteId)}` +
      `?sig=${this.signature(sid, state, venueId, `detail:${siteId}`)}`;

    if (entry) {
      const { sid, state } = this.sessionFor(req, res);
      const nextHref =
        pageCount(content) > 1
          ? `/venue/${venueId}/page/2?sig=${this.signature(sid, state, venueId, 2)}`
          : null;
      this.stats.venuePagesServed += 1;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderPage(content, 1, nextHref, detailHref(sid, state)));
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
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderPage(content, page, nextHref, detailHref(sid!, state!)));
  }

  /**
   * 详情正文：每轮有请求额度，额度用完返回 403；
   * 签名绑定当前会话，会话轮换后旧详情链接返回 409。
   */
  private handleDetail(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    detail: RegExpMatchArray,
    content: VenueContent,
    url: URL,
  ): void {
    const venueId = content.venueId;
    if (content.layout !== 'stub') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('venue has no detail pages');
      return;
    }
    const siteId = decodeURIComponent(detail[2]);

    // 每轮详情额度：先用尽先拒绝，列表翻页不受额度影响。
    if (this.detailQuota !== null && this.detailQuota <= 0) {
      this.stats.detailQuotaExhausted += 1;
      res.writeHead(403, {
        'content-type': 'text/plain; charset=utf-8',
        'x-detail-quota': 'exhausted',
      });
      res.end('本轮详情请求额度已用完，请下一轮再取');
      return;
    }

    const sid = this.currentSid(req);
    const state = sid ? this.sessions.get(sid) : undefined;
    const expected =
      sid && state ? this.signature(sid, state, venueId, `detail:${siteId}`) : null;
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

    const item = content.items.find((entry) => entry.siteId === siteId);
    if (!item) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('unknown announcement');
      return;
    }

    if (this.detailQuota !== null) this.detailQuota -= 1;
    this.stats.detailRequests += 1;
    // 故障注入：详情正文与列表不符（编号/修订对不上），采集器应驳回。
    const override = this.detailMismatch.get(siteId);
    const rendered = override ? { ...item, ...override } : item;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderDetailPage(content, rendered));
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
        this.detailQuota = null;
        this.detailMismatch.clear();
        this.venueRequestCount = 0;
        this.stats.requests = 0;
        this.stats.venuePagesServed = 0;
        this.stats.pagingRecoveries = 0;
        this.stats.rateLimited = 0;
        this.stats.aborted = 0;
        this.stats.sessionRotations = 0;
        this.stats.detailRequests = 0;
        this.stats.detailQuotaExhausted = 0;
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
      case 'detail-quota':
        // 每轮详情请求上限；null 表示不限。
        this.detailQuota =
          payload.count === null || payload.count === undefined
            ? null
            : Number(payload.count);
        response = { ok: true, detailQuota: this.detailQuota };
        break;
      case 'detail-mismatch': {
        // 让某条详情返回与列表不符的正文（编号/修订对不上）；clear 清除。
        const siteId = String(payload.siteId ?? '');
        if (payload.clear === true) {
          this.detailMismatch.delete(siteId);
        } else {
          const override: Partial<MockItem> = {};
          if (typeof payload.eventId === 'string') override.eventId = payload.eventId;
          if (typeof payload.revision === 'number') override.revision = payload.revision;
          if (typeof payload.title === 'string') override.title = payload.title;
          if (typeof payload.showTime === 'string') override.showTime = payload.showTime;
          if (typeof payload.doorsTime === 'string') override.doorsTime = payload.doorsTime;
          this.detailMismatch.set(siteId, override);
        }
        response = {
          ok: true,
          siteId,
          mismatch: this.detailMismatch.get(siteId) ?? null,
        };
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
