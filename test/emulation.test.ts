import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { BrowserManager } from '../src/daemon/browserManager.js';
import { createToolHandlers } from '../src/daemon/tools/handlers.js';
import { emulationTools } from '../src/daemon/tools/defs/emulation.js';
import { SessionStore } from '../src/daemon/sessions.js';
import { getFreePort, waitFor } from './helpers.js';

/**
 * A fixture whose CSS genuinely responds to the media features under test,
 * rather than only reporting them through matchMedia.
 *
 * That difference is the whole point: a page can answer
 * matchMedia('(prefers-color-scheme: dark)') correctly and still never
 * repaint, which is exactly the failure a light/dark QA pass exists to
 * catch. Every media assertion below therefore reads a computed style, not
 * just a media query.
 *
 * The page also echoes back the request headers the server actually
 * received, so a user-agent override can be checked on the wire and not only
 * in `navigator.userAgent`, and it schedules timers at page-script time so
 * the clock tool has something real to fast-forward into.
 */
function fixtureHtml(headers: Record<string, unknown>): string {
  return `<!doctype html>
<html>
<head>
<style>
  body { background-color: rgb(255, 255, 255); color: rgb(17, 17, 17); }
  #box { transition-duration: 2s; outline-style: solid; outline-width: 1px; }
  @media (prefers-color-scheme: dark) {
    body { background-color: rgb(0, 0, 0); color: rgb(238, 238, 238); }
  }
  @media (prefers-reduced-motion: reduce) {
    #box { transition-duration: 0s; }
  }
  @media (forced-colors: active) {
    #box { outline-width: 7px; }
  }
</style>
</head>
<body>
  <div id="box">box</div>
  <pre id="headers">${JSON.stringify(headers)}</pre>
<script>
  window.__requestHeaders = JSON.parse(document.getElementById('headers').textContent);
  window.__fired = [];
  // Scheduled while the document is parsing, so a clock installed after this
  // point has already missed it. That is the ordering trap the tool warns
  // about, and test 12 depends on it being real.
  setTimeout(function () { window.__fired.push('minute'); }, 60000);
  window.__loadedAt = Date.now();
</script>
</body>
</html>`;
}

let server: Server;
let baseUrl: string;
let browserManager: BrowserManager;
let sessions: SessionStore;
let handlers: ReturnType<typeof createToolHandlers>;

before(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(
      fixtureHtml({
        userAgent: req.headers['user-agent'] ?? null,
        acceptLanguage: req.headers['accept-language'] ?? null
      })
    );
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/`;

  browserManager = new BrowserManager(await getFreePort());
  sessions = new SessionStore(browserManager);
  handlers = createToolHandlers(sessions, {
    debugPort: await getFreePort(),
    screenshotCacheDir: '/dev/null/unused',
    screenshotCacheTtlMs: 1000
  });
});

after(async () => {
  await sessions.closeAll();
  await browserManager.close();
  await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
});

/** The `structuredContent` of a tool result, typed loosely: these tests assert on individual fields. */
function payload(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}

async function evaluate<T>(sessionId: string, expression: string): Promise<T> {
  const result = await handlers.evaluate({ sessionId, expression });
  return payload(result).result as T;
}

/** A fresh session already sitting on the fixture page. */
async function freshSession(): Promise<string> {
  const { sessionId } = await sessions.createSession();
  await handlers.navigate({ sessionId, url: baseUrl, settleMs: 0 });
  return sessionId;
}

/** What the page's own stylesheet actually resolved to, plus the media queries behind it. */
function styleProbe(sessionId: string): Promise<{
  background: string;
  transitionDuration: string;
  outlineWidth: string;
  dark: boolean;
  reduce: boolean;
  forced: boolean;
}> {
  return evaluate(
    sessionId,
    `({
      background: getComputedStyle(document.body).backgroundColor,
      transitionDuration: getComputedStyle(document.getElementById('box')).transitionDuration,
      outlineWidth: getComputedStyle(document.getElementById('box')).outlineWidth,
      dark: matchMedia('(prefers-color-scheme: dark)').matches,
      reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
      forced: matchMedia('(forced-colors: active)').matches
    })`
  );
}

// ---------------------------------------------------------------------------
// emulate_media
// ---------------------------------------------------------------------------

test('emulate_media dark actually repaints the page, and says what is in effect', async () => {
  const sessionId = await freshSession();

  const before_ = await styleProbe(sessionId);
  assert.equal(before_.background, 'rgb(255, 255, 255)', 'the fixture must start light, or the dark assertion proves nothing');

  const body = payload(await handlers.emulate_media({ sessionId, colorScheme: 'dark' }));

  const after_ = await styleProbe(sessionId);
  assert.equal(after_.background, 'rgb(0, 0, 0)', 'the page must really repaint dark, not merely answer matchMedia');
  assert.equal(after_.dark, true);

  const effective = body.effective as Record<string, unknown>;
  assert.equal(effective.colorScheme, 'dark', 'the result must report the state read back from the page');

  await sessions.releaseSession(sessionId);
});

test('emulate_media reduced motion collapses a real CSS transition', async () => {
  const sessionId = await freshSession();

  assert.equal((await styleProbe(sessionId)).transitionDuration, '2s');

  const body = payload(await handlers.emulate_media({ sessionId, reducedMotion: 'reduce' }));

  assert.equal((await styleProbe(sessionId)).transitionDuration, '0s', 'the transition must genuinely collapse');
  assert.equal((body.effective as Record<string, unknown>).reducedMotion, 'reduce');

  await sessions.releaseSession(sessionId);
});

test('emulate_media leaves an omitted feature alone and resets only the one told to reset', async () => {
  const sessionId = await freshSession();

  await handlers.emulate_media({ sessionId, colorScheme: 'dark', reducedMotion: 'reduce' });
  let probe = await styleProbe(sessionId);
  assert.equal(probe.dark, true);
  assert.equal(probe.reduce, true);

  // Omitting colorScheme and reducedMotion must not disturb them: this is the
  // "unset" half of the distinction the description spells out.
  await handlers.emulate_media({ sessionId, forcedColors: 'active' });
  probe = await styleProbe(sessionId);
  assert.equal(probe.dark, true, 'an omitted feature must be left exactly as it was');
  assert.equal(probe.reduce, true, 'an omitted feature must be left exactly as it was');
  assert.equal(probe.outlineWidth, '7px', 'forced-colors must really apply, not just match');

  // And "reset" must be reachable, must be per-feature, and must differ from
  // omitting: the other two overrides survive it untouched.
  const body = payload(await handlers.emulate_media({ sessionId, colorScheme: 'reset' }));
  probe = await styleProbe(sessionId);
  assert.equal(probe.dark, false, 'reset must drop the colour-scheme override back to the system default');
  assert.equal(probe.background, 'rgb(255, 255, 255)');
  assert.equal(probe.reduce, true, 'resetting one feature must not reset the others');
  assert.equal(probe.outlineWidth, '7px', 'resetting one feature must not reset the others');
  assert.equal((body.effective as Record<string, unknown>).reducedMotion, 'reduce');

  await sessions.releaseSession(sessionId);
});

test('emulate_media survives a real page load and does not leak into another session', async () => {
  const sessionId = await freshSession();
  const other = await freshSession();

  await handlers.emulate_media({ sessionId, colorScheme: 'dark' });
  await handlers.reload({ sessionId, settleMs: 0 });
  assert.equal((await styleProbe(sessionId)).background, 'rgb(0, 0, 0)', 'the override must outlive a document swap');

  assert.equal((await styleProbe(other)).background, 'rgb(255, 255, 255)', 'one session must not colour another');

  await sessions.releaseSession(sessionId);
  await sessions.releaseSession(other);
});

// ---------------------------------------------------------------------------
// set_user_agent
// ---------------------------------------------------------------------------

test('set_user_agent changes navigator.userAgent AND the outgoing header, and survives a navigation', async () => {
  const sessionId = await freshSession();

  const body = payload(await handlers.set_user_agent({ sessionId, userAgent: 'HarborageQA/1.0', acceptLanguage: 'fr-FR' }));
  assert.equal(body.userAgent, 'HarborageQA/1.0', 'the result must report the UA read back from the page');
  assert.equal(body.matched, true);

  assert.equal(await evaluate<string>(sessionId, 'navigator.userAgent'), 'HarborageQA/1.0');

  // The wire, not just the JS object: the fixture echoes what the server saw.
  await handlers.navigate({ sessionId, url: `${baseUrl}?again`, settleMs: 0 });
  const headers = await evaluate<{ userAgent: string; acceptLanguage: string }>(sessionId, 'window.__requestHeaders');
  assert.equal(headers.userAgent, 'HarborageQA/1.0', 'the override must reach the outgoing User-Agent header');
  assert.match(headers.acceptLanguage, /fr-FR/, 'acceptLanguage must reach the outgoing Accept-Language header');

  // And it must still be in force after that navigation, not silently reverted.
  assert.equal(await evaluate<string>(sessionId, 'navigator.userAgent'), 'HarborageQA/1.0');

  await sessions.releaseSession(sessionId);
});

test('set_user_agent reset restores the real browser identity, and one session cannot change another', async () => {
  const sessionId = await freshSession();
  const other = await freshSession();
  const realUa = await evaluate<string>(other, 'navigator.userAgent');

  await handlers.set_user_agent({ sessionId, userAgent: 'HarborageQA/2.0' });
  assert.equal(await evaluate<string>(other, 'navigator.userAgent'), realUa, 'a UA override must stay inside its own session');

  const body = payload(await handlers.set_user_agent({ sessionId, reset: true }));
  assert.equal(body.userAgent, realUa, 'reset must hand back the browser\'s genuine user agent');
  assert.equal(await evaluate<string>(sessionId, 'navigator.userAgent'), realUa);

  await sessions.releaseSession(sessionId);
  await sessions.releaseSession(other);
});

test('set_user_agent refuses an ambiguous call rather than guessing', async () => {
  const sessionId = await freshSession();
  await assert.rejects(() => handlers.set_user_agent({ sessionId }), /userAgent|reset/i);
  await assert.rejects(() => handlers.set_user_agent({ sessionId, userAgent: 'x', reset: true }), /userAgent|reset/i);
  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// set_timezone / set_locale
// ---------------------------------------------------------------------------

test('set_timezone really moves the page clock offset, survives navigation, and resets', async () => {
  const sessionId = await freshSession();

  const body = payload(await handlers.set_timezone({ sessionId, timezoneId: 'Asia/Tokyo' }));
  assert.equal(body.timezoneId, 'Asia/Tokyo', 'the result must report the timezone read back from the page');
  assert.equal(body.matched, true);

  const probe = await evaluate<{ tz: string; offset: number }>(
    sessionId,
    `({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone, offset: new Date('2024-01-15T12:00:00Z').getTimezoneOffset() })`
  );
  assert.equal(probe.tz, 'Asia/Tokyo');
  assert.equal(probe.offset, -540, 'the override must move real date arithmetic, not just the reported name');

  await handlers.navigate({ sessionId, url: `${baseUrl}?tz`, settleMs: 0 });
  assert.equal(
    await evaluate<string>(sessionId, 'Intl.DateTimeFormat().resolvedOptions().timeZone'),
    'Asia/Tokyo',
    'the override must outlive a navigation'
  );

  const reset = payload(await handlers.set_timezone({ sessionId, reset: true }));
  assert.notEqual(reset.timezoneId, 'Asia/Tokyo', 'reset must drop back to the machine timezone');

  await sessions.releaseSession(sessionId);
});

test('set_timezone rejects a bogus zone loudly instead of pretending', async () => {
  const sessionId = await freshSession();
  await assert.rejects(() => handlers.set_timezone({ sessionId, timezoneId: 'Not/AZone' }), /timezone/i);
  await sessions.releaseSession(sessionId);
});

test('set_locale changes Intl formatting and reports that navigator.language is untouched', async () => {
  const sessionId = await freshSession();

  const body = payload(await handlers.set_locale({ sessionId, locale: 'de-DE' }));
  assert.equal(body.locale, 'de-DE', 'the result must report the locale read back from the page');
  assert.equal(body.matched, true);

  const probe = await evaluate<{ locale: string; number: string; language: string }>(
    sessionId,
    `({ locale: Intl.DateTimeFormat().resolvedOptions().locale, number: new Intl.NumberFormat().format(1234.5), language: navigator.language })`
  );
  assert.equal(probe.locale, 'de-DE');
  assert.equal(probe.number, '1.234,5', 'the override must change real formatting, not just the reported name');

  // The honest half: Chromium's locale override does NOT move
  // navigator.language, and the tool has to say so rather than let an agent
  // assume it did.
  assert.equal(
    body.navigatorLanguage,
    probe.language,
    'the result must surface navigator.language so an agent sees it did not follow the locale'
  );

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// permissions, clipboard, geolocation
// ---------------------------------------------------------------------------

/** Round-trips the real async clipboard API, returning either the text read back or the error name. */
function clipboardRoundTrip(sessionId: string, value: string): Promise<string> {
  return evaluate(
    sessionId,
    `(async () => {
      try {
        await navigator.clipboard.writeText(${JSON.stringify(value)});
        return 'ok:' + (await navigator.clipboard.readText());
      } catch (err) {
        return 'err:' + err.name;
      }
    })()`
  );
}

test('grant_permissions makes a real clipboard write and read work, and clear_permissions takes it away', async () => {
  const sessionId = await freshSession();

  assert.equal(
    await clipboardRoundTrip(sessionId, 'before'),
    'err:NotAllowedError',
    'the fixture must start without clipboard access, or the grant proves nothing'
  );

  const body = payload(await handlers.grant_permissions({ sessionId, permissions: ['clipboard-read', 'clipboard-write'] }));
  const states = body.states as Record<string, string>;
  assert.equal(states['clipboard-read'], 'granted', 'the result must report the permission state queried from the page');

  assert.equal(await clipboardRoundTrip(sessionId, 'paste me'), 'ok:paste me', 'a real paste must now work');

  const cleared = payload(await handlers.clear_permissions({ sessionId }));
  assert.equal((cleared.states as Record<string, string>)['clipboard-read'], 'prompt', 'clearing must be reported, not assumed');
  assert.equal(await clipboardRoundTrip(sessionId, 'after'), 'err:NotAllowedError');

  await sessions.releaseSession(sessionId);
});

test('grant_permissions does not leak into another session', async () => {
  const sessionId = await freshSession();
  const other = await freshSession();

  await handlers.grant_permissions({ sessionId, permissions: ['clipboard-read', 'clipboard-write'] });
  assert.equal(await clipboardRoundTrip(other, 'nope'), 'err:NotAllowedError', 'a grant must stay inside its own session');

  await sessions.releaseSession(sessionId);
  await sessions.releaseSession(other);
});

test('set_geolocation puts real coordinates into navigator.geolocation once granted', async () => {
  const sessionId = await freshSession();

  // Ungranted: the tool must say it could not verify rather than claim success.
  const ungranted = payload(await handlers.set_geolocation({ sessionId, latitude: 35.6812, longitude: 139.7671 }));
  assert.equal(ungranted.verified, false, 'without the geolocation permission the tool cannot verify, and must admit it');
  assert.match(String(ungranted.note), /grant_permissions/, 'the note must point at the tool that fixes it');

  await handlers.grant_permissions({ sessionId, permissions: ['geolocation'] });
  const body = payload(await handlers.set_geolocation({ sessionId, latitude: 35.6812, longitude: 139.7671 }));
  assert.equal(body.verified, true);
  const position = body.position as { latitude: number; longitude: number };
  assert.equal(position.latitude, 35.6812, 'the coordinates must be read back out of the page, not echoed');
  assert.equal(position.longitude, 139.7671);

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// emulate_clock
// ---------------------------------------------------------------------------

test('emulate_clock fast_forward fires a timer scheduled a minute out, with no real time passing', async () => {
  const { sessionId } = await sessions.createSession();

  const installed = payload(await handlers.emulate_clock({ sessionId, action: 'install', time: '2024-03-01T10:00:00.000Z' }));
  assert.equal(installed.installed, true);

  await handlers.navigate({ sessionId, url: baseUrl, settleMs: 0 });
  assert.match(
    await evaluate<string>(sessionId, 'new Date().toISOString()'),
    /^2024-03-01T10:00:00/,
    'the page must be living at the installed time'
  );
  assert.deepEqual(await evaluate<string[]>(sessionId, 'window.__fired'), [], 'nothing is due yet');

  const startedAt = Date.now();
  const body = payload(await handlers.emulate_clock({ sessionId, action: 'fast_forward', ticks: 120000 }));
  const realElapsed = Date.now() - startedAt;

  assert.deepEqual(
    await evaluate<string[]>(sessionId, 'window.__fired'),
    ['minute'],
    'a timer scheduled 60s out must actually fire'
  );
  assert.ok(realElapsed < 5000, `fast_forward must not spend real time, took ${realElapsed}ms`);
  assert.match(String(body.pageTime), /^2024-03-01T10:02:00/, 'the result must report the page clock read back afterwards');

  await sessions.releaseSession(sessionId);
});

test('emulate_clock refuses to fast-forward a clock that was never installed', async () => {
  const sessionId = await freshSession();
  // Playwright silently no-ops here, which is the single worst outcome: the
  // agent concludes the timers do not fire.
  await assert.rejects(() => handlers.emulate_clock({ sessionId, action: 'fast_forward', ticks: 1000 }), /install/i);
  await sessions.releaseSession(sessionId);
});

test('emulate_clock warns when installed after the page already built its timers', async () => {
  const sessionId = await freshSession();

  const body = payload(await handlers.emulate_clock({ sessionId, action: 'install', time: '2024-03-01T10:00:00.000Z' }));
  assert.equal(body.installed, true);
  assert.match(String(body.note), /reload|before/i, 'a late install must warn, since existing timers stay real');

  // And the warning must be true: the already-scheduled timer really is out of reach.
  await handlers.emulate_clock({ sessionId, action: 'fast_forward', ticks: 120000 });
  assert.deepEqual(
    await evaluate<string[]>(sessionId, 'window.__fired'),
    [],
    'a timer created before the install is native and cannot be fast-forwarded'
  );

  await sessions.releaseSession(sessionId);
});

test('emulate_clock set_fixed_time freezes Date, and a clock stays inside its own session', async () => {
  const { sessionId } = await sessions.createSession();
  const other = await freshSession();

  await handlers.emulate_clock({ sessionId, action: 'install', time: '2024-03-01T10:00:00.000Z' });
  await handlers.navigate({ sessionId, url: baseUrl, settleMs: 0 });

  const body = payload(await handlers.emulate_clock({ sessionId, action: 'set_fixed_time', time: '2030-01-01T00:00:00.000Z' }));
  assert.match(String(body.pageTime), /^2030-01-01T00:00:00/);

  const first = await evaluate<number>(sessionId, 'Date.now()');
  await handlers.emulate_clock({ sessionId, action: 'run_for', ticks: 5000 });
  assert.equal(await evaluate<number>(sessionId, 'Date.now()'), first, 'a fixed time must not move');

  const otherYear = await evaluate<number>(other, 'new Date().getFullYear()');
  assert.ok(otherYear > 2024, `another session must keep the real clock, saw ${otherYear}`);

  await sessions.releaseSession(sessionId);
  await sessions.releaseSession(other);
});

test('emulate_clock requires the argument each action actually needs', async () => {
  const { sessionId } = await sessions.createSession();
  await assert.rejects(() => handlers.emulate_clock({ sessionId, action: 'set_fixed_time' }), /time/i);
  await assert.rejects(
    () => handlers.emulate_clock({ sessionId, action: 'install', time: 'not a date' }),
    /time|date/i
  );
  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// The persistent CDP session the overrides depend on
// ---------------------------------------------------------------------------

test('send_cdp_command does not knock out a live user agent or timezone override', async () => {
  const sessionId = await freshSession();

  await handlers.set_user_agent({ sessionId, userAgent: 'HarborageQA/3.0' });
  await handlers.set_timezone({ sessionId, timezoneId: 'Asia/Tokyo' });

  // send_cdp_command attaches its own CDP session and detaches it again, and
  // Chromium drops an emulation override when the session that SET it
  // detaches. If these two ever shared one session, this call would silently
  // revert both overrides, which is the exact failure this design exists to
  // avoid.
  await handlers.send_cdp_command({ sessionId, method: 'Page.getLayoutMetrics' });

  assert.equal(await evaluate<string>(sessionId, 'navigator.userAgent'), 'HarborageQA/3.0');
  assert.equal(await evaluate<string>(sessionId, 'Intl.DateTimeFormat().resolvedOptions().timeZone'), 'Asia/Tokyo');

  await sessions.releaseSession(sessionId);
});

test('a user agent override is scoped to its own tab, while a clock is scoped to the whole session', async () => {
  const { sessionId } = await sessions.createSession();
  await handlers.emulate_clock({ sessionId, action: 'install', time: '2024-03-01T10:00:00.000Z' });
  await handlers.navigate({ sessionId, url: baseUrl, settleMs: 0 });
  await handlers.set_user_agent({ sessionId, userAgent: 'HarborageQA/4.0' });

  await evaluate(sessionId, `window.open(${JSON.stringify(baseUrl)}, '_blank')`);
  await waitFor(async () => (payload(await handlers.list_tabs({ sessionId })).tabs as unknown[]).length > 1, {
    message: 'the second tab never registered'
  });

  const secondTab = await evaluate<string>(sessionId, 'navigator.userAgent');
  assert.notEqual(secondTab, 'HarborageQA/4.0', 'a per-tab CDP override must not reach a tab it was never set on');
  assert.match(
    await evaluate<string>(sessionId, 'new Date().toISOString()'),
    /^2024-03-01T10:00:00/,
    'the clock is installed on the browser context, so a tab opened later must inherit it'
  );

  await sessions.releaseSession(sessionId);
});

// ---------------------------------------------------------------------------
// Descriptions: the only documentation an agent ever reads
// ---------------------------------------------------------------------------

function describedFields(name: keyof typeof emulationTools): Record<string, string> {
  const shape = emulationTools[name].inputSchema.shape as Record<string, { description?: string }>;
  return Object.fromEntries(Object.entries(shape).map(([key, field]) => [key, field.description ?? '']));
}

test('no emulation tool description or field description contains an em-dash', () => {
  for (const [name, def] of Object.entries(emulationTools)) {
    assert.ok(!def.description.includes('—'), `${name}'s description still contains an em-dash`);
    for (const [field, description] of Object.entries(describedFields(name as keyof typeof emulationTools))) {
      assert.ok(!description.includes('—'), `${name}.${field}'s description still contains an em-dash`);
    }
  }
});

test('every field of every emulation tool is described', () => {
  for (const name of Object.keys(emulationTools) as (keyof typeof emulationTools)[]) {
    for (const [field, description] of Object.entries(describedFields(name))) {
      assert.ok(description.length > 0, `${name}.${field} has no .describe()`);
    }
  }
});

test('emulate_media spells out omit versus reset, and that matchMedia alone proves nothing', () => {
  const { description } = emulationTools.emulate_media;
  assert.match(description, /omit/i);
  assert.match(description, /reset/i);
  assert.match(description, /NOT the same|is NOT resetting|Omitting is NOT/i);
  // A page can answer the media query correctly and never repaint.
  assert.match(description, /computed style|screenshot/i);
  for (const field of ['colorScheme', 'reducedMotion', 'forcedColors', 'media'] as const) {
    assert.match(describedFields('emulate_media')[field], /reset/i, `${field} must explain its reset value`);
  }
});

test('set_user_agent says what it moves and that send_cdp_command cannot do the same job', () => {
  const { description } = emulationTools.set_user_agent;
  assert.match(description, /navigator\.userAgent/);
  assert.match(description, /User-Agent/i);
  assert.match(description, /header/i);
  assert.match(description, /send_cdp_command/);
  assert.match(description, /detach/i);
  assert.match(description, /survives?.*navigat|navigat.*surviv/i);
});

test('set_timezone and set_locale each say what they do NOT change', () => {
  assert.match(emulationTools.set_timezone.description, /does NOT change the locale/i);
  const locale = emulationTools.set_locale.description;
  assert.match(locale, /navigator\.language/);
  assert.match(locale, /does NOT/);
  assert.match(locale, /set_user_agent/);
});

test('grant_permissions names the clipboard case and says grants are additive', () => {
  const { description } = emulationTools.grant_permissions;
  assert.match(description, /clipboard-read/);
  assert.match(description, /clipboard-write/);
  assert.match(description, /NotAllowedError/);
  assert.match(description, /additive/i);
  assert.match(description, /clear_permissions/);
});

test('set_geolocation says it is inert without the permission', () => {
  const { description } = emulationTools.set_geolocation;
  assert.match(description, /grant_permissions/);
  assert.match(description, /geolocation/);
});

test('emulate_clock states the ordering constraint, its silence, its scope and that it cannot be undone', () => {
  const { description } = emulationTools.emulate_clock;
  assert.match(description, /SILENT|silently/i);
  assert.match(description, /before/i);
  assert.match(description, /install.*THEN navigate|THEN navigate/i);
  assert.match(description, /no uninstall/i);
  // Session-wide, not per tab: an agent that assumes per-tab will be surprised.
  assert.match(description, /every tab in this session/i);
  assert.match(description, /fast_forward/);
  assert.match(description, /run_for/);
});
