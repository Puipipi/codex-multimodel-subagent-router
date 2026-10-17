import assert from 'node:assert/strict';
import http from 'node:http';
import {createTraceService, escapeHtml, renderTrace} from '../scripts/plugin-trace.mjs';

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
const equal = (actual, expected, message) => { assert.equal(actual, expected, message); checks += 1; };
const match = (value, pattern, message) => { assert.match(value, pattern, message); checks += 1; };
const doesNotMatch = (value, pattern, message) => { assert.doesNotMatch(value, pattern, message); checks += 1; };

function request(url, {method = 'GET', headers = {}} = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(url, {method, headers}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8')}));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

function cookiePair(setCookie) {
  return setCookie.split(';')[0];
}

function firstDetailHref(body) {
  return body.match(/href="([^"]*\/trace\/view\/[^"]+\/event\/[^"]+)"/)?.[1] ?? null;
}

async function exchange(url) {
  const response = await request(url);
  const setCookie = response.headers['set-cookie']?.[0] ?? '';
  return {
    response,
    setCookie,
    cookie: setCookie ? cookiePair(setCookie) : '',
    location: response.headers.location ?? '',
    viewUrl: response.headers.location ? new URL(response.headers.location, url).href : null,
    ticket: url.split('/').pop(),
  };
}

equal(escapeHtml(`<script>&"'</script>`), '&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;', 'HTML escaping covers tags, ampersands, and quotes');
const staticPage = renderTrace({agentId: '<agent>', title: '<title>', status: 'completed', events: [], hasMore: true, nextCursor: '<cursor>', selectedEventId: '<event>'});
match(staticPage, /&lt;agent&gt;/, 'static rendering escapes the agent id');
match(staticPage, /下一个游标：<code>&lt;cursor&gt;<\/code>/, 'static rendering escapes the continuation cursor');
match(staticPage, /已选择事件详情：<code>&lt;event&gt;<\/code>/, 'static rendering escapes the selected event id');
match(staticPage, /只读 DSH Trace/, 'static rendering uses Chinese user-visible labels');

const FAKE_AWS_KEY = ['AKIA', 'TESTNOTAREALKEY0'].join('');

const clock = {value: Date.now()};
const trace = createTraceService({ttlMs: 60_000, maxUses: 2, now: () => clock.value});
try {
  const opened = await trace.open({
    agentId: 'A1',
    owner: 'owner-hash',
    title: '<img src=x onerror=alert(1)>',
    status: 'running',
    events: [
      {event_id: 1, seq: 1, type: 'assistant/final', text: '<script>alert("x")</script> & "quoted"'},
      {event_id: 2, seq: 2, type: 'tool/call', summary: {command: 'curl -H "Authorization: Bearer sk-test-NOTAREALKEY000000"', path: '<repo>/a&b'}},
      {event_id: 3, seq: 3, type: 'descendant/progress', scope: 'descendant', text: `${FAKE_AWS_KEY} and token=supersecretvalue`},
    ],
    hasMore: true,
    nextCursor: 1328,
    selectedEventId: 2,
  });
  match(opened.url, /^http:\/\/127\.0\.0\.1:\d+\/trace\/[A-Za-z0-9_-]{43}$/, 'the exchange URL is loopback-only and carries an unguessable ticket');
  doesNotMatch(opened.url, /(?:sk-|ghp_|Bearer|token=|authorization|api[_-]?key)/i, 'the exchange URL contains no credential material');
  equal(opened.read_only, true, 'the trace is explicitly read-only');
  ok(opened.expires_at, 'the trace reports its expiry');
  match(opened.view_path, /^\/trace\/view\/[A-Za-z0-9_-]{22}\/$/, 'the view path is scoped per trace view');

  const first = await exchange(opened.url);
  equal(first.response.status, 303, 'a valid ticket is exchanged with a redirect');
  match(first.setCookie, /HttpOnly/, 'the session cookie is HttpOnly');
  match(first.setCookie, /SameSite=Strict/, 'the session cookie is SameSite=Strict');
  match(first.setCookie, /Path=\/trace\/view\/[A-Za-z0-9_-]{22}\//, 'the session cookie is scoped to its own view path');
  match(first.setCookie, /Max-Age=\d+/, 'the session cookie is short-lived');
  equal(first.cookie.startsWith('dsh_trace_'), true, 'the cookie uses a per-view trace cookie name');
  ok(!first.cookie.endsWith(first.ticket), 'the cookie value is not the URL ticket');
  doesNotMatch(first.setCookie, /sk-|Bearer|authorization/i, 'the cookie contains no credential material');
  equal(first.location, opened.view_path, 'the redirect target is ticket-free and view-scoped');
  ok(!first.location.includes(first.ticket), 'the resulting URL removes the ticket');

  const noCookie = await request(first.viewUrl);
  equal(noCookie.status, 401, 'the ticket-free view requires the HttpOnly cookie');
  match(noCookie.headers['set-cookie']?.[0] ?? '', /Max-Age=0/, 'a missing session receives a clearing cookie');

  const page = await request(first.viewUrl, {headers: {cookie: first.cookie}});
  equal(page.status, 200, 'the cookie renders the trace');
  match(page.headers['content-type'], /text\/html/, 'the trace is HTML');
  match(page.headers['content-security-policy'], /default-src 'none'/, 'scripts and external resources are blocked');
  ok(!page.headers['set-cookie'], 'the rendered page sets no additional cookie');
  match(page.headers['cache-control'], /no-store/, 'the trace is not cached');
  ok(page.body.includes('&lt;script&gt;alert'), 'event content is escaped');
  doesNotMatch(page.body, /<script>alert/, 'raw event markup never reaches the page');
  ok(page.body.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the title is escaped');
  doesNotMatch(page.body, /sk-test-NOTAREALKEY/, 'API key material is redacted');
  doesNotMatch(page.body, /supersecretvalue/, 'token assignments are redacted');
  doesNotMatch(page.body, new RegExp(FAKE_AWS_KEY), 'AWS access key material is redacted');
  ok(page.body.includes('只读 DSH Trace'), 'the page states its read-only nature in Chinese');
  ok(page.body.includes('不是 Codex 子 Agent 面板'), 'the page states the native-child limitation in Chinese');
  ok(page.body.includes('下一个游标'), 'the page exposes the real continuation cursor');
  ok(page.body.includes('已选择事件详情'), 'the page exposes the selected event detail marker');
  ok(!page.body.includes(first.ticket), 'the ticket is not embedded in the page body');

  const reused = await exchange(opened.url);
  equal(reused.response.status, 410, 'the exchange ticket is single-use');

  const headOpened = await trace.open({agentId: 'A-head', owner: 'owner-hash', status: 'running', events: []});
  const head = await request(headOpened.url, {method: 'HEAD'});
  equal(head.status, 303, 'HEAD exchange is supported');
  equal(head.body, '', 'HEAD exchange sends no body');
  match(head.headers['set-cookie']?.[0] ?? '', /HttpOnly/, 'HEAD exchange still sets the session cookie');
  const postOpened = await trace.open({agentId: 'A-post', owner: 'owner-hash', status: 'running', events: []});
  const post = await request(postOpened.url, {method: 'POST'});
  equal(post.status, 405, 'the trace exchange is read-only');
  equal(post.headers.allow, 'GET, HEAD', 'the allowed methods are explicit');

  const missing = await request(opened.url.replace(/\/trace\/.*$/, '/trace/not-a-ticket'));
  equal(missing.status, 404, 'a malformed ticket is not found');
  const unknown = await request(opened.url.replace(/[A-Za-z0-9_-]{43}$/, 'A'.repeat(43)));
  equal(unknown.status, 410, 'an unknown ticket is expired');
  const noEndpoint = await request(opened.url.replace(/\/trace\/.*$/, '/'));
  equal(noEndpoint.status, 404, 'the root has no control surface');

  equal(trace.revokeAgent('A1'), 1, 'terminal cleanup revokes the exchanged session');
  equal((await request(first.viewUrl, {headers: {cookie: first.cookie}})).status, 401, 'a revoked session is rejected');

  const limited = await trace.open({agentId: 'A2', owner: 'owner-hash', title: 'second', status: 'completed', events: []});
  const limitedExchange = await exchange(limited.url);
  equal(limitedExchange.response.status, 303, 'a second trace exchanges normally');
  equal((await request(limitedExchange.viewUrl, {headers: {cookie: limitedExchange.cookie}})).status, 200, 'a fresh session is valid');
  equal((await request(limitedExchange.viewUrl, {headers: {cookie: limitedExchange.cookie}})).status, 200, 'the session allows its bounded number of views');
  equal((await request(limitedExchange.viewUrl, {headers: {cookie: limitedExchange.cookie}})).status, 410, 'the session stops after its view limit');

  const expiring = await trace.open({agentId: 'A3', owner: 'other-owner', title: 'expires', status: 'running', events: []});
  const expiringExchange = await exchange(expiring.url);
  clock.value += 120_000;
  equal((await request(expiringExchange.viewUrl, {headers: {cookie: expiringExchange.cookie}})).status, 401, 'an expired session is rejected');
  const expiredTicket = await trace.open({agentId: 'A4', owner: 'other-owner', title: 'expired ticket', status: 'running', events: []});
  clock.value += 120_000;
  equal((await exchange(expiredTicket.url)).response.status, 410, 'an expired exchange ticket is rejected');

  const detailTrace = createTraceService({ttlMs: 60_000, maxUses: 10, now: () => clock.value});
  try {
    const detailCalls = [];
    const detailEvent = {
      event_id: 11,
      seq: 1,
      type: 'tool/call',
      scope: 'root',
      summary: {
        tool: 'shell',
        command: 'npm test -- --runInBand',
        args: {cwd: '<repo>&a', api_key: 'json-secret-value'},
      },
      result: {output: '<b>ok</b> sk-test-NOTAREALKEY000000', exit_code: 0},
    };
    const detailOpened = await detailTrace.open({
      agentId: 'D1',
      owner: 'owner-hash',
      title: 'detail agent',
      status: 'running',
      events: [detailEvent],
      loadEvent: async eventId => {
        detailCalls.push(eventId);
        return {events: [{...detailEvent, event_id: eventId}]};
      },
    });
    const detailExchange = await exchange(detailOpened.url);
    const detailPage = await request(detailExchange.viewUrl, {headers: {cookie: detailExchange.cookie}});
    equal(detailPage.status, 200, 'an authenticated snapshot renders detail links');
    const href = firstDetailHref(detailPage.body);
    ok(href, 'an event with an actual event_id gets a clickable detail link');
    ok(href.startsWith(`${detailOpened.view_path}event/11?ref=`), 'the detail link is same-origin and uses the actual event id');
    equal(new URL(href, detailExchange.viewUrl).pathname, `${detailOpened.view_path}event/11`, 'the detail link path contains only the view scope and event id');
    ok(!href.includes('owner-hash'), 'the detail link contains no chat ownership hash');
    ok(!href.includes(detailExchange.ticket), 'the detail link contains no exchange ticket');
    const detailUrl = new URL(href, detailExchange.viewUrl).href;
    equal((await request(detailUrl)).status, 401, 'detail requires the HttpOnly cookie');
    const detail = await request(detailUrl, {headers: {cookie: detailExchange.cookie}});
    equal(detail.status, 200, 'the cookie opens the event detail');
    match(detail.body, /npm test -- --runInBand/, 'the detail renders the tool command');
    match(detail.body, /&lt;repo&gt;&amp;a/, 'the detail escapes and shows command arguments');
    match(detail.body, /&lt;b&gt;ok&lt;\/b&gt;/, 'the detail escapes result output');
    doesNotMatch(detail.body, /<b>ok<\/b>/, 'raw result markup is never emitted');
    doesNotMatch(detail.body, /sk-test-NOTAREALKEY000000/, 'the detail redacts credentials');
    doesNotMatch(detail.body, /json-secret-value/, 'the detail redacts JSON credential fields');
    ok(detail.body.includes(`href="${detailOpened.view_path}"`), 'the detail exposes a same-origin back link to its scoped snapshot');
    ok(detail.body.includes('只读 DSH 事件详情'), 'the detail uses Chinese user-visible labels');
    equal(detailCalls.length, 1, 'the trusted callback is called once for the clicked event');
    equal(detailCalls[0], 11, 'the trusted callback receives the actual event id');
    const ref = new URL(detailUrl).searchParams.get('ref');
    const absent = new URL(`event/999?ref=${encodeURIComponent(ref)}`, detailExchange.viewUrl).href;
    equal((await request(absent, {headers: {cookie: detailExchange.cookie}})).status, 404, 'an event id outside the snapshot fails');
    const malformed = new URL(`event/not-a-number?ref=${encodeURIComponent(ref)}`, detailExchange.viewUrl).href;
    equal((await request(malformed, {headers: {cookie: detailExchange.cookie}})).status, 404, 'a malformed event id fails');
    const tampered = new URL(`event/11?ref=tampered`, detailExchange.viewUrl).href;
    equal((await request(tampered, {headers: {cookie: detailExchange.cookie}})).status, 403, 'a detail link from another session is rejected');
    equal((await request(detailUrl, {method: 'POST', headers: {cookie: detailExchange.cookie}})).status, 405, 'the detail endpoint is read-only');
    const back = await request(detailExchange.viewUrl, {headers: {cookie: detailExchange.cookie}});
    equal(back.status, 200, 'the back link returns the authenticated snapshot');

    const otherOpened = await detailTrace.open({
      agentId: 'D2',
      owner: 'other-owner',
      title: 'other detail agent',
      status: 'completed',
      events: [{event_id: 21, type: 'tool/call', summary: {command: 'other-session-secret'}}],
      loadEvent: async eventId => ({events: [{event_id: eventId, type: 'tool/call', summary: {command: 'other-session-secret'}}]}),
    });
    const otherExchange = await exchange(otherOpened.url);
    const otherPage = await request(otherExchange.viewUrl, {headers: {cookie: otherExchange.cookie}});
    const otherHref = new URL(firstDetailHref(otherPage.body), otherExchange.viewUrl).href;
    const crossCookie = await request(otherHref, {headers: {cookie: detailExchange.cookie}});
    equal(crossCookie.status, 401, 'one view cookie cannot open another view detail link');
    doesNotMatch(crossCookie.body, /other-session-secret/, 'cross-session denial leaks no detail data');
    equal((await request(detailUrl, {headers: {cookie: otherExchange.cookie}})).status, 401, 'another view cookie cannot use the first detail link');
    ok(!otherPage.body.includes('other-owner'), 'the snapshot body does not expose the ownership hash');

    const noIdOpened = await detailTrace.open({
      agentId: 'D3',
      owner: 'owner-hash',
      status: 'running',
      events: [{seq: 21, type: 'tool/call', summary: {command: 'no event id'}}],
      loadEvent: async () => ({events: []}),
    });
    const noIdExchange = await exchange(noIdOpened.url);
    const noIdPage = await request(noIdExchange.viewUrl, {headers: {cookie: noIdExchange.cookie}});
    doesNotMatch(noIdPage.body, /\/trace\/event\/21\?/, 'a seq value is not treated as an actual event id');
  } finally {
    await detailTrace.close();
  }

  const tabs = createTraceService({ttlMs: 60_000, maxUses: 10, now: () => clock.value});
  try {
    const tabA = await tabs.open({
      agentId: 'TAB-A', owner: 'owner-tab', title: 'tab-A-title', status: 'running',
      events: [{event_id: 101, type: 'assistant/final', text: 'tab-A-snapshot'}],
      loadEvent: async eventId => ({events: [{event_id: eventId, type: 'tool/call', summary: {command: 'echo tab-A-detail'}}]}),
    });
    const tabB = await tabs.open({
      agentId: 'TAB-B', owner: 'owner-tab', title: 'tab-B-title', status: 'running',
      events: [{event_id: 202, type: 'assistant/final', text: 'tab-B-snapshot'}],
      loadEvent: async eventId => ({events: [{event_id: eventId, type: 'tool/call', summary: {command: 'echo tab-B-detail'}}]}),
    });
    const exchangeA = await exchange(tabA.url);
    const exchangeB = await exchange(tabB.url);
    ok(exchangeA.cookie !== exchangeB.cookie, 'each trace tab receives its own cookie value');
    match(exchangeA.setCookie, new RegExp(`Path=${tabA.view_path.replaceAll('/', '\\/')}`), 'tab A cookie is scoped to tab A path');
    match(exchangeB.setCookie, new RegExp(`Path=${tabB.view_path.replaceAll('/', '\\/')}`), 'tab B cookie is scoped to tab B path');
    ok(exchangeA.cookie !== exchangeB.cookie && exchangeA.cookie.startsWith('dsh_trace_') && exchangeB.cookie.startsWith('dsh_trace_'),
      'both tab cookies use per-view names');
    const pageA = await request(exchangeA.viewUrl, {headers: {cookie: exchangeA.cookie}});
    const pageB = await request(exchangeB.viewUrl, {headers: {cookie: exchangeB.cookie}});
    equal(pageA.status, 200, 'the first trace tab remains usable after the second tab opens');
    equal(pageB.status, 200, 'the second trace tab opens independently');
    ok(pageA.body.includes('tab-A-title') && !pageA.body.includes('tab-B-title'), 'tab A shows only its own snapshot');
    ok(pageB.body.includes('tab-B-title') && !pageB.body.includes('tab-A-title'), 'tab B shows only its own snapshot');
    const againA = await request(exchangeA.viewUrl, {headers: {cookie: exchangeA.cookie}});
    equal(againA.status, 200, 'opening tab B does not overwrite tab A cookie');
    ok(againA.body.includes('tab-A-title'), 'tab A still renders its own agent after tab B exchange');
    const hrefA = new URL(firstDetailHref(pageA.body), exchangeA.viewUrl).href;
    const hrefB = new URL(firstDetailHref(pageB.body), exchangeB.viewUrl).href;
    const detailA = await request(hrefA, {headers: {cookie: exchangeA.cookie}});
    const detailB = await request(hrefB, {headers: {cookie: exchangeB.cookie}});
    equal(detailA.status, 200, 'tab A detail page works');
    equal(detailB.status, 200, 'tab B detail page works');
    match(detailA.body, /echo tab-A-detail/, 'tab A detail shows its own event');
    match(detailB.body, /echo tab-B-detail/, 'tab B detail shows its own event');
    doesNotMatch(detailA.body, /tab-B-detail/, 'tab A detail does not leak tab B data');
    doesNotMatch(detailB.body, /tab-A-detail/, 'tab B detail does not leak tab A data');
    equal((await request(hrefB, {headers: {cookie: exchangeA.cookie}})).status, 401,
      'tab A cookie cannot open tab B detail');
    equal((await request(hrefA, {headers: {cookie: exchangeB.cookie}})).status, 401,
      'tab B cookie cannot open tab A detail');
    equal((await request(new URL('/trace/view', exchangeA.viewUrl))).status, 410, 'the unscoped legacy view path is retired');
  } finally {
    await tabs.close();
  }

  const isolated = created => {
    let status;
    let body;
    created.handleRequest(
      {method: 'GET', url: '/trace/x', socket: {remoteAddress: '10.0.0.8'}},
      {writeHead: code => { status = code; }, end: value => { body = value; }},
    );
    return {status, body};
  };
  const remote = isolated(trace);
  equal(remote.status, 403, 'non-loopback browsers are rejected');
  match(remote.body, /回环/, 'the rejection explains the loopback boundary in Chinese');

  await trace.close();
  equal(trace.tickets.size, 0, 'closing the service drops all tickets');
  equal(trace.sessions.size, 0, 'closing the service drops all sessions');
} finally {
  await trace.close();
}

console.log(`PASS ${checks} plugin trace assertions`);
