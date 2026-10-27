// Read-only local browser trace for real DSH events. The browser never gets a
// DSH, DeepSeek, or Codex credential: it gets one short-lived, unguessable
// capability ticket in the path. Every event is escaped before it reaches HTML.
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';

const TICKET = /^[A-Za-z0-9_-]{43}$/;
const VIEW_ID = /^[A-Za-z0-9_-]{22}$/;
const LOOPBACK = /^(?:::ffff:)?(?:127\.0\.0\.1|::1)$/;

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function redactSecrets(value) {
  return String(value ?? '')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '<REDACTED_KEY>')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '<REDACTED_TOKEN>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <REDACTED>')
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^\s"',;]{6,}/gi, '$1=<REDACTED>')
    .replace(/(["']?(?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*)(["'][^"']*["']|[^\s"',;]+)/gi, '$1<REDACTED>')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '<REDACTED_KEY>');
}

function safeText(value) {
  return escapeHtml(redactSecrets(value));
}

function eventTitle(event) {
  if (!event || typeof event !== 'object') return 'event';
  return String(event.type ?? 'event');
}

function eventBody(event) {
  if (!event || typeof event !== 'object') return String(event ?? '');
  if (typeof event.text === 'string') return event.text;
  if (event.summary !== undefined) return JSON.stringify(event.summary, null, 2);
  if (event.data !== undefined) return JSON.stringify(event.data, null, 2);
  return JSON.stringify(event, null, 2);
}

function statusClass(status) {
  const value = String(status ?? 'unknown').toLowerCase();
  if (['completed', 'idle'].includes(value)) return 'ok';
  if (['error', 'context_exhausted'].includes(value)) return 'bad';
  if (['running', 'starting', 'interrupting'].includes(value)) return 'live';
  return 'muted';
}

function eventIdOf(event) {
  const value = event?.event_id;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 2147483647) return value;
  if (typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed <= 2147483647) return parsed;
  }
  return null;
}

function objectOf(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '');
}

function detailText(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function eventDetailSections(event) {
  const summary = objectOf(event?.summary) ?? {};
  const data = objectOf(event?.data) ?? {};
  const payload = objectOf(event?.payload) ?? {};
  const result = objectOf(event?.result) ?? {};
  const tool = objectOf(event?.tool) ?? {};
  const input = objectOf(firstDefined(event?.input, summary.input, data.input, payload.input, tool.input, event?.tool_input)) ?? {};
  const sections = [];
  const add = (label, value) => {
    if (value === undefined || value === null || value === '') return;
    sections.push({label, text: detailText(value)});
  };
  add('工具', firstDefined(event?.tool_name, summary.tool, summary.name, data.tool, data.name, tool.name));
  add('命令', firstDefined(
    event?.command, summary.command, summary.cmd, data.command, data.cmd,
    input.command, input.cmd, payload.command, tool.command,
  ));
  add('参数', firstDefined(
    event?.arguments, event?.args, summary.arguments, summary.args, data.arguments, data.args,
    input.arguments, input.args, payload.arguments, payload.args, tool.arguments, tool.args,
    event?.input, summary.input, data.input, payload.input,
  ));
  add('输入', firstDefined(event?.input, summary.input, data.input, payload.input));
  add('输出', firstDefined(
    event?.output, event?.stdout, summary.output, summary.stdout, data.output, data.stdout,
    payload.output, result.output, result.stdout, result.text, result.content, result.message,
  ));
  add('结果', firstDefined(event?.result, summary.result, data.result, payload.result));
  add('错误', firstDefined(event?.error, summary.error, data.error, payload.error, result.error));
  add('stderr', firstDefined(event?.stderr, summary.stderr, data.stderr, payload.stderr, result.stderr));
  if (sections.length === 0) add('事件', eventBody(event));
  return sections;
}

export function renderEventDetail({agentId, title, status, event = {}, eventId, capturedAt = new Date(), expiresAt = null, viewPath = '/trace/view/'}) {
  const id = eventId ?? eventIdOf(event) ?? '';
  const kind = eventTitle(event);
  const scope = event?.scope ? `<span class="scope">${safeText(event.scope)}</span>` : '';
  const rows = eventDetailSections(event).map(section => `<section class="detail-block">
  <h2>${safeText(section.label)}</h2>
  <pre>${safeText(section.text)}</pre>
</section>`).join('\n');
  const expiry = expiresAt
    ? `此详情页将于 ${safeText(new Date(expiresAt).toISOString())} 过期。Cookie 是短期 trace 能力凭据，不是账户凭据。`
    : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH 事件 #${safeText(id)} · ${safeText(title || agentId)}</title>
<style>
:root{color-scheme:dark;--bg:#0c1018;--panel:#121927;--line:#263247;--text:#e7ecf5;--muted:#94a3b8;--accent:#7aa2ff;--ok:#34d399;--bad:#fb7185;--live:#fbbf24}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(1200px 600px at 15% -10%,#1b2b4a 0%,var(--bg) 55%);color:var(--text);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1040px;margin:0 auto;padding:48px 24px 72px}header{border-bottom:1px solid var(--line);padding-bottom:26px;margin-bottom:30px}
.eyebrow{letter-spacing:.18em;text-transform:uppercase;color:var(--accent);font-size:12px;font-weight:700;margin:0 0 10px}
h1{font-size:clamp(28px,4vw,46px);line-height:1.08;margin:0 0 14px;letter-spacing:-.03em}
h2{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:0;padding:10px 14px;border-bottom:1px solid var(--line)}
.meta{color:var(--muted);margin:0;display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center}
code,.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
code{background:#0a0f18;border:1px solid var(--line);border-radius:6px;padding:2px 7px;color:#c7d2fe}
.status{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:999px;padding:4px 10px;font-size:12px;text-transform:uppercase;letter-spacing:.08em}
.status::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.status.ok{color:var(--ok)}.status.bad{color:var(--bad)}.status.live{color:var(--live)}.status.muted{color:var(--muted)}
.notice{border:1px solid var(--line);background:rgba(122,162,255,.08);border-radius:10px;padding:12px 14px;color:#cbd5e1;font-size:13px;margin:20px 0 0}
.back{display:inline-block;margin:0 0 22px;color:var(--accent);text-decoration:none;font-size:13px;font-weight:600}
.back:hover,.back:focus{text-decoration:underline}
.detail-block{background:linear-gradient(180deg,rgba(255,255,255,.025),rgba(255,255,255,0));border:1px solid var(--line);border-radius:12px;overflow:hidden;margin:0 0 14px}
.scope{color:var(--muted);margin-left:auto;text-transform:uppercase;letter-spacing:.08em;font-size:10px}
pre{margin:0;padding:14px;white-space:pre-wrap;overflow-wrap:anywhere;color:#dbe4f0;font:13px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}
footer{margin-top:34px;color:var(--muted);font-size:12px;border-top:1px solid var(--line);padding-top:16px}
</style>
</head>
<body>
<main>
<header>
  <a class="back" href="${safeText(viewPath)}">&larr; 返回 trace 快照</a>
  <p class="eyebrow">只读 DSH 事件详情</p>
  <h1>事件 #${safeText(id)} · ${safeText(kind)}</h1>
  <p class="meta"><span>Agent <code>${safeText(agentId)}</code></span><span class="status ${statusClass(status)}">${safeText(status || 'unknown')}</span>${scope}<span>捕获于 ${safeText(new Date(capturedAt).toISOString())}</span></p>
  <p class="notice">此详情由受信任且绑定所有者的回调获取，仅可读取，不能控制 Agent。${expiry ? ' ' + expiry : ''}</p>
</header>
${rows}
<footer>外部 DSH Agent 不是 Codex 原生子 Agent。这是真实的外部 DSH 事件详情，不是 Codex 子 Agent 面板。</footer>
</main>
</body>
</html>`;
}

export function renderTrace({agentId, title, status, events = [], capturedAt = new Date(), expiresAt = null, hasMore = false, nextCursor = null, selectedEventId = null, detailRef = null, viewPath = '/trace/view/'}) {
  const rows = events.map(event => {
    const id = event?.event_id ?? event?.seq ?? '';
    const actualId = eventIdOf(event);
    const kind = eventTitle(event);
    const body = eventBody(event);
    const scope = event?.scope ? `<span class="scope">${safeText(event.scope)}</span>` : '';
    const detail = detailRef && actualId !== null
      ? `<a class="detail-link" href="${safeText(viewPath)}event/${actualId}?ref=${encodeURIComponent(detailRef)}">查看详情</a>`
      : '';
    return `<li class="event">
  <div class="event-head"><span class="seq">#${safeText(id)}</span><span class="kind">${safeText(kind)}</span>${scope}${detail}</div>
  <pre>${safeText(body)}</pre>
</li>`;
  }).join('\n');
  const empty = events.length === 0
    ? '<p class="empty">此 Agent 尚无 trace 事件。请先运行 Agent，再重新请求 trace。</p>'
    : `<ol class="timeline">${rows}</ol>`;
  const expiry = expiresAt ? `此链接将于 ${safeText(new Date(expiresAt).toISOString())} 过期。URL 已换取短期 HttpOnly SameSite Cookie，不是账户凭据。` : '';
  const more = hasMore
    ? `<p class="notice">还有更多 DSH 事件。${nextCursor !== null && nextCursor !== undefined ? `下一个游标：<code>${safeText(nextCursor)}</code>。请再次调用 <code>dsh_trace</code>，并将 <code>after</code> 设为该游标。` : '未返回延续游标；请缩小请求范围或检查 <code>dsh_events</code>。'}</p>`
    : '';
  const selected = selectedEventId !== null && selectedEventId !== undefined
    ? `<p class="notice">已选择事件详情：<code>${safeText(selectedEventId)}</code>。</p>`
    : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH Trace · ${safeText(title || agentId)}</title>
<style>
:root{color-scheme:dark;--bg:#0c1018;--panel:#121927;--line:#263247;--text:#e7ecf5;--muted:#94a3b8;--accent:#7aa2ff;--ok:#34d399;--bad:#fb7185;--live:#fbbf24}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(1200px 600px at 15% -10%,#1b2b4a 0%,var(--bg) 55%);color:var(--text);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1040px;margin:0 auto;padding:48px 24px 72px}header{border-bottom:1px solid var(--line);padding-bottom:26px;margin-bottom:30px}
.eyebrow{letter-spacing:.18em;text-transform:uppercase;color:var(--accent);font-size:12px;font-weight:700;margin:0 0 10px}
h1{font-size:clamp(28px,4vw,46px);line-height:1.08;margin:0 0 14px;letter-spacing:-.03em}
.meta{color:var(--muted);margin:0;display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center}
code,.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
code{background:#0a0f18;border:1px solid var(--line);border-radius:6px;padding:2px 7px;color:#c7d2fe}
.status{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:999px;padding:4px 10px;font-size:12px;text-transform:uppercase;letter-spacing:.08em}
.status::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.status.ok{color:var(--ok)}.status.bad{color:var(--bad)}.status.live{color:var(--live)}.status.muted{color:var(--muted)}
.notice{border:1px solid var(--line);background:rgba(122,162,255,.08);border-radius:10px;padding:12px 14px;color:#cbd5e1;font-size:13px;margin:20px 0 0}
.timeline{list-style:none;margin:0;padding:0;display:grid;gap:14px}
.event{background:linear-gradient(180deg,rgba(255,255,255,.025),rgba(255,255,255,0));border:1px solid var(--line);border-radius:12px;overflow:hidden}
.event-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}
.seq{color:var(--muted)}.kind{color:#bfdbfe}.scope{color:var(--muted);margin-left:auto;text-transform:uppercase;letter-spacing:.08em;font-size:10px}
.detail-link{color:var(--accent);text-decoration:none;border:1px solid var(--line);border-radius:999px;padding:2px 9px;font-size:11px;font-weight:600;margin-left:auto}
.detail-link:hover,.detail-link:focus{text-decoration:underline;border-color:var(--accent)}
pre{margin:0;padding:14px;white-space:pre-wrap;overflow-wrap:anywhere;color:#dbe4f0;font:13px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}
.empty{border:1px dashed var(--line);border-radius:12px;padding:22px;color:var(--muted)}
footer{margin-top:34px;color:var(--muted);font-size:12px;border-top:1px solid var(--line);padding-top:16px}
</style>
</head>
<body>
<main>
<header>
  <p class="eyebrow">只读 DSH Trace</p>
  <h1>${safeText(title || agentId)}</h1>
  <p class="meta"><span>Agent <code>${safeText(agentId)}</code></span><span class="status ${statusClass(status)}">${safeText(status || 'unknown')}</span><span>${safeText(events.length)} 个事件</span><span>捕获于 ${safeText(new Date(capturedAt).toISOString())}</span></p>
  <p class="notice">已发布 DSH 0.7 运行时记录的事件快照。此页面只读、无需凭据，且不能控制 Agent。${expiry ? ' ' + expiry : ''}</p>
  ${more}
  ${selected}
</header>
${empty}
<footer>外部 DSH Agent 不是 Codex 原生子 Agent。此 trace 是外部 DSH 事件流的真实浏览器视图，不是 Codex 子 Agent 面板。</footer>
</main>
</body>
</html>`;
}

function isLoopback(address) {
  return typeof address === 'string' && LOOPBACK.test(address);
}

function eventPayloadList(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['events', 'items']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  if (payload.event && typeof payload.event === 'object') return [payload.event];
  const detail = objectOf(payload.detail);
  if (detail) return Array.isArray(detail.events) ? detail.events : [detail];
  if (eventIdOf(payload) !== null || ['type', 'summary', 'data', 'result', 'command'].some(key => key in payload)) return [payload];
  return [];
}

const COOKIE_PREFIX = 'dsh_trace_';
const VIEW_PREFIX = '/trace/view/';

function cookieNameFor(viewId) {
  return `${COOKIE_PREFIX}${viewId}`;
}

function viewPathFor(viewId) {
  return `${VIEW_PREFIX}${viewId}/`;
}

function cookieValue(header, name) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function sessionCookie(token, maxAgeSeconds, viewId) {
  return `${cookieNameFor(viewId)}=${token}; HttpOnly; SameSite=Strict; Path=${viewPathFor(viewId)}; Max-Age=${Math.max(1, maxAgeSeconds)}`;
}

function clearSessionCookie(viewId) {
  return `${cookieNameFor(viewId)}=; HttpOnly; SameSite=Strict; Path=${viewPathFor(viewId)}; Max-Age=0`;
}

export function createTraceService({ttlMs = 2 * 60 * 1000, maxUses = 20, maxTickets = 128, now = Date.now, render = renderTrace, renderDetail = renderEventDetail} = {}) {
  const tickets = new Map();
  const sessions = new Map();
  let server;
  let listening;
  let timer;

  function sweep() {
    const current = now();
    for (const [ticket, value] of tickets) {
      if (value.expiresAt <= current || value.revoked) tickets.delete(ticket);
    }
    for (const [token, value] of sessions) {
      if (value.expiresAt <= current || value.revoked) sessions.delete(token);
    }
    while (tickets.size > maxTickets) tickets.delete(tickets.keys().next().value);
    while (sessions.size > maxTickets) sessions.delete(sessions.keys().next().value);
  }

  function send(response, status, body, headers = {}, head = false) {
    response.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store, max-age=0',
      ...headers,
    });
    response.end(head ? '' : body);
  }

  async function handleDetail(request, response, viewId, eventIdText, head) {
    const token = cookieValue(request.headers?.cookie, cookieNameFor(viewId));
    const session = token ? sessions.get(token) : null;
    if (!session || session.viewId !== viewId) {
      send(response, 401, '<!doctype html><title>需要 Trace 访问权限</title><p>trace Cookie 缺失或无效。请打开新的 dsh_trace 链接，换取新的短期票据。</p>', {'Set-Cookie': clearSessionCookie(viewId)}, head);
      return;
    }
    if (session.revoked || session.expiresAt <= now() || session.uses >= maxUses) {
      sessions.delete(token);
      send(response, 410, '<!doctype html><title>Trace 已过期</title><p>此 trace 会话已过期、被撤销或达到查看次数上限。请再次调用 dsh_trace。</p>', {'Set-Cookie': clearSessionCookie(viewId)}, head);
      return;
    }
    const ref = new URL(request.url || '/', 'http://127.0.0.1').searchParams.get('ref');
    if (!session.detailRef || ref !== session.detailRef) {
      send(response, 403, '<!doctype html><title>详情访问被拒绝</title><p>此事件详情链接不属于当前 trace 会话。请用对应 Cookie 打开快照并使用其中的链接。</p>', {}, head);
      return;
    }
    const eventId = /^[1-9][0-9]{0,9}$/.test(eventIdText) ? Number(eventIdText) : null;
    if (!eventId || eventId > 2147483647 || !session.allowedEventIds.has(eventId) || typeof session.loadEvent !== 'function') {
      send(response, 404, '<!doctype html><title>未找到事件</title><p>此事件 ID 不在已认证的 trace 快照中，或详情不可用。</p>', {}, head);
      return;
    }
    session.uses += 1;
    let payload;
    try {
      payload = await session.loadEvent(eventId);
    } catch (error) {
      send(response, 502, `<!doctype html><title>事件详情不可用</title><p>受信任的事件回调失败：${safeText(error?.message ?? 'unknown error')}</p>`, {}, head);
      return;
    }
    const event = eventPayloadList(payload).find(candidate => eventIdOf(candidate) === eventId);
    if (!event) {
      send(response, 404, '<!doctype html><title>未找到事件</title><p>受信任的事件回调未返回此 Agent 的请求事件。</p>', {}, head);
      return;
    }
    const html = renderDetail({
      agentId: session.agentId,
      title: session.title,
      status: session.status,
      event,
      eventId,
      capturedAt: new Date(session.capturedAt),
      expiresAt: session.expiresAt,
      viewPath: viewPathFor(viewId),
    });
    send(response, 200, html, {}, head);
  }

  function handleRequest(request, response) {
    sweep();
    const head = request.method === 'HEAD';
    if (!isLoopback(request.socket?.remoteAddress)) {
      send(response, 403, '<!doctype html><title>禁止访问</title><p>此 trace 仅可通过本地回环接口访问。</p>', {}, head);
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      send(response, 405, '<!doctype html><title>不允许的方法</title><p>此 trace 只读。</p>', {Allow: 'GET, HEAD'}, false);
      return;
    }
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    const detailMatch = /^\/trace\/view\/([A-Za-z0-9_-]{22})\/event\/([^/]+)\/?$/.exec(pathname);
    if (detailMatch) {
      handleDetail(request, response, detailMatch[1], detailMatch[2], head).catch(error => {
        if (!response.headersSent) send(response, 500, `<!doctype html><title>事件详情失败</title><p>${safeText(error?.message ?? 'unknown error')}</p>`, {}, head);
        else if (!response.writableEnded) response.end();
      });
      return;
    }
    const bareView = /^\/trace\/view\/([A-Za-z0-9_-]{22})$/.exec(pathname);
    if (bareView) {
      send(response, 308, '<!doctype html><title>重定向</title><p>正在跳转到作用域内的 trace 视图。</p>', {Location: `${pathname}/`}, head);
      return;
    }
    const viewMatch = /^\/trace\/view\/([A-Za-z0-9_-]{22})\/?$/.exec(pathname);
    if (viewMatch) {
      const viewId = viewMatch[1];
      const token = cookieValue(request.headers?.cookie, cookieNameFor(viewId));
      const session = token ? sessions.get(token) : null;
      if (!session || session.viewId !== viewId) {
        send(response, 401, '<!doctype html><title>需要 Trace 访问权限</title><p>trace Cookie 缺失或无效。请打开新的 dsh_trace 链接，换取新的短期票据。</p>', {'Set-Cookie': clearSessionCookie(viewId)}, head);
        return;
      }
      if (session.revoked || session.expiresAt <= now() || session.uses >= maxUses) {
        sessions.delete(token);
        send(response, 410, '<!doctype html><title>Trace 已过期</title><p>此 trace 会话已过期、被撤销或达到查看次数上限。请再次调用 dsh_trace。</p>', {'Set-Cookie': clearSessionCookie(viewId)}, head);
        return;
      }
      session.uses += 1;
      send(response, 200, session.html, {}, head);
      return;
    }
    if (pathname === '/trace/view' || pathname === '/trace/view/' || /^\/trace\/event\//.test(pathname)) {
      send(response, 410, '<!doctype html><title>旧版链接已失效</title><p>此旧版 trace 链接已失效，请重新调用 dsh_trace。</p>', {}, head);
      return;
    }
    const prefix = '/trace/';
    if (!pathname.startsWith(prefix)) {
      send(response, 404, '<!doctype html><title>未找到</title><p>未知的 trace 端点。</p>', {}, head);
      return;
    }
    const ticket = pathname.slice(prefix.length);
    if (!TICKET.test(ticket)) {
      send(response, 404, '<!doctype html><title>未找到</title><p>未知或格式错误的 trace 票据。</p>', {}, head);
      return;
    }
    const value = tickets.get(ticket);
    if (!value || value.revoked || value.expiresAt <= now()) {
      tickets.delete(ticket);
      send(response, 410, '<!doctype html><title>Trace 已过期</title><p>此 trace 票据未知、已过期、已撤销或已兑换。请再次调用 dsh_trace 获取新的短期链接。</p>', {}, head);
      return;
    }
    // The ticket is single-use. The browser receives only a random HttpOnly
    // SameSite session cookie scoped to this view; the redirect target contains
    // no ticket. A second tab for another agent gets a different cookie name
    // and path, so the two sessions cannot overwrite each other.
    tickets.delete(ticket);
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, {
      agentId: value.agentId,
      owner: value.owner,
      viewId: value.viewId,
      html: value.html,
      expiresAt: value.expiresAt,
      uses: 0,
      revoked: false,
      title: value.title,
      status: value.status,
      capturedAt: value.capturedAt,
      detailRef: value.detailRef,
      allowedEventIds: value.allowedEventIds,
      loadEvent: value.loadEvent,
    });
    const maxAge = Math.max(1, Math.ceil((value.expiresAt - now()) / 1000));
    send(response, 303, '<!doctype html><title>Trace 就绪</title><p>继续前往只读 trace。</p>', {
      Location: viewPathFor(value.viewId),
      'Set-Cookie': sessionCookie(token, maxAge, value.viewId),
    }, head);
  }

  async function ensureServer() {
    if (listening) return listening;
    if (!server) server = createServer(handleRequest);
    listening = await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve(server.address());
      });
    });
    if (!timer) {
      timer = setInterval(sweep, Math.max(250, Math.min(ttlMs, 30000)));
      timer.unref?.();
    }
    return listening;
  }

  async function open({agentId, owner, title, status, events, hasMore = false, nextCursor = null, selectedEventId = null, loadEvent = null}) {
    if (typeof agentId !== 'string' || agentId.length === 0) throw new Error('A trace requires an agent id.');
    if (typeof owner !== 'string' || owner.length === 0) throw new Error('A trace requires an owning chat.');
    if (!Array.isArray(events)) throw new Error('Trace events must be an array.');
    if (loadEvent !== null && typeof loadEvent !== 'function') throw new Error('Trace event details require a trusted callback.');
    sweep();
    const address = await ensureServer();
    const ticket = randomBytes(32).toString('base64url');
    const viewId = randomBytes(16).toString('base64url');
    const viewPath = viewPathFor(viewId);
    const expiresAt = now() + ttlMs;
    const capturedAt = now();
    const allowedEventIds = new Set(events.map(eventIdOf).filter(id => id !== null));
    const detailRef = typeof loadEvent === 'function' ? randomBytes(18).toString('base64url') : null;
    const html = render({
      agentId,
      title: title || agentId,
      status,
      events,
      capturedAt: new Date(capturedAt),
      expiresAt,
      hasMore: Boolean(hasMore),
      nextCursor,
      selectedEventId,
      detailRef,
      viewPath,
    });
    tickets.set(ticket, {
      agentId,
      owner,
      viewId,
      html,
      expiresAt,
      revoked: false,
      title: title || agentId,
      status,
      capturedAt,
      detailRef,
      allowedEventIds,
      loadEvent,
    });
    sweep();
    return {
      url: `http://127.0.0.1:${address.port}/trace/${ticket}`,
      view_path: viewPath,
      expires_at: new Date(expiresAt).toISOString(),
      read_only: true,
    };
  }

  function revokeAgent(agentId) {
    let revoked = 0;
    for (const [ticket, value] of tickets) {
      if (value.agentId === agentId) {
        value.revoked = true;
        tickets.delete(ticket);
        revoked += 1;
      }
    }
    for (const [token, value] of sessions) {
      if (value.agentId === agentId) {
        value.revoked = true;
        sessions.delete(token);
        revoked += 1;
      }
    }
    return revoked;
  }

  function revokeOwner(owner) {
    let revoked = 0;
    for (const [ticket, value] of tickets) {
      if (value.owner === owner) {
        value.revoked = true;
        tickets.delete(ticket);
        revoked += 1;
      }
    }
    for (const [token, value] of sessions) {
      if (value.owner === owner) {
        value.revoked = true;
        sessions.delete(token);
        revoked += 1;
      }
    }
    return revoked;
  }

  async function close() {
    if (timer) clearInterval(timer);
    timer = undefined;
    tickets.clear();
    sessions.clear();
    if (server) {
      await new Promise(resolve => server.close(() => resolve())).catch(() => {});
      server = undefined;
      listening = undefined;
    }
  }

  return {open, revokeAgent, revokeOwner, close, handleRequest, sweep, tickets, sessions};
}
