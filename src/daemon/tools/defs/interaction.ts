import type { Locator, Page } from 'playwright';
import * as z from 'zod/v4';

import { defineTool, defineTools, text, type ToolResult } from '../types.js';
import { pageId, sessionId } from './common.js';

/**
 * The handful of browser globals the in-page snippets in this file touch.
 *
 * The daemon's own tsconfig has no "dom" lib, and that is deliberate: it is a
 * Node process, and pulling the whole DOM in would let browser APIs leak into
 * daemon code unnoticed. Declaring exactly what these snippets use keeps them
 * type-checked without opening that door.
 */
interface PageElement {
  tagName: string;
  id: string;
  value?: string;
  textContent: string | null;
  matches(selector: string): boolean;
  // Loosely typed on purpose: the real DOM signature takes a Node, and the
  // test tsconfig does pull in lib.dom, so anything narrower stops these
  // callbacks type-checking under it.
  contains(other: any): boolean;
}
declare const document: { activeElement: PageElement | null };
declare const window: { innerWidth: number; innerHeight: number; devicePixelRatio: number };

/** The tags whose contents live in `.value` rather than in their child nodes. */
const formControlTags = ['INPUT', 'TEXTAREA', 'SELECT'];

/**
 * The select-all chord a real user would press on this machine. Derived
 * rather than hardcoded: Chromium binds select-all to Meta on macOS and to
 * Control everywhere else, and pressing the wrong one selects nothing at all,
 * silently turning a "replace" back into the append that `fill` exists to
 * prevent.
 */
const selectAllChord = `${process.platform === 'darwin' ? 'Meta' : 'Control'}+a`;

/** Playwright's navigation wait conditions, shared by navigate and reload. */
const waitUntil = z
  .enum(['load', 'domcontentloaded', 'networkidle', 'commit'])
  .optional()
  .describe('Playwright navigation wait condition. Defaults to "load".');

/** An offset inside an element, shared by click and hover: both take it or neither coordinate. */
const selectorPosition = {
  x: z
    .number()
    .optional()
    .describe('Horizontal offset in CSS pixels from the element\'s top-left corner. Must be given together with y.'),
  y: z
    .number()
    .optional()
    .describe('Vertical offset in CSS pixels from the element\'s top-left corner. Must be given together with x.')
};

/**
 * Whether the target is a form control. Form controls have a `.value` that
 * Playwright's `fill` sets atomically and correctly; anything else is edited
 * as content, which is where rich editors intercept the insertion.
 */
function isFormControl(locator: Locator): Promise<boolean> {
  return locator.evaluate((el: PageElement, tags: string[]) => tags.includes(el.tagName), formControlTags);
}

/**
 * What the field really holds right now: `.value` for a form control,
 * `textContent` for anything else. Two branches rather than one because a
 * Playwright selector is not always a CSS selector, so the selector case has
 * to go through a Locator, while the focused case has nothing to build one
 * from.
 */
function readFieldValue(page: Page, locator: Locator | null): Promise<string> {
  if (locator) {
    return locator.evaluate(
      (el: PageElement, tags: string[]) => (tags.includes(el.tagName) ? el.value ?? '' : el.textContent ?? ''),
      formControlTags
    );
  }
  return page.evaluate((tags: string[]) => {
    const el = document.activeElement;
    if (!el) return '';
    return tags.includes(el.tagName) ? el.value ?? '' : el.textContent ?? '';
  }, formControlTags);
}

/**
 * Replaces a field's contents for real.
 *
 * A contenteditable goes through actual keyboard events (focus, select-all,
 * delete, insert) rather than a plain insertion, because CodeMirror and
 * Monaco keep their own document model and treat an insertion as an insert at
 * their own cursor. That is how filling `{{ $json.mode }}` over `result`
 * produced `{{ $json.mode }}result`: the editor never saw the old text go
 * away. Deleting with a key press is what a human does, so the editor handles
 * it the way it handles a human.
 */
async function setFieldValue(page: Page, locator: Locator, value: string): Promise<void> {
  if (await isFormControl(locator)) {
    await locator.fill(value);
    return;
  }
  await locator.focus();

  // Select-all is scoped to whatever holds the caret, so pressing it while
  // focus never landed on the target would select the whole document and the
  // delete below would empty the page. Refuse loudly instead.
  const focused = await locator.evaluate((el: PageElement) => {
    const active = document.activeElement;
    return active !== null && (active === el || el.contains(active));
  });
  if (!focused) {
    throw new Error(
      'fill could not put focus inside the target element, so it stopped rather than pressing select-all against the whole document. Is the selector pointing at an input, a textarea, or a contenteditable?'
    );
  }

  await page.keyboard.press(selectAllChord);
  await page.keyboard.press('Delete');
  if (value.length > 0) {
    await page.keyboard.insertText(value);
  }
}

/**
 * Every tool that writes text reports what the field actually contains
 * afterwards, not merely that the write was attempted. A wrong result that
 * looks like a success is what let a QA agent draw conclusions about a value
 * it never set, so a mismatch is stated in the payload rather than left for
 * the caller to discover by reading the field back themselves.
 */
function writeResult(base: Record<string, unknown>, actual: string, matched: boolean, expectation: string): ToolResult {
  if (matched) {
    return text({ ...base, value: actual, matched: true });
  }
  return text({
    ...base,
    value: actual,
    matched: false,
    note:
      `The field does not contain what was expected. ${expectation} It now contains ${JSON.stringify(actual)}. ` +
      'The page may have rewritten, truncated or reformatted the input, or the write may have landed somewhere other than the intended element. Trust "value", not the request.'
  });
}

/**
 * Whether `actual` is `before` with `typed` inserted at one point in it.
 *
 * Typing goes in at the caret, and where the caret sits is the browser's call:
 * an input puts it after the existing text, a contenteditable before it. So a
 * flat `before + typed` comparison would report a mismatch for a perfectly
 * correct insertion. This still catches everything that matters: text the page
 * rewrote, truncated, or that never landed at all.
 */
function isInsertionOf(before: string, typed: string, actual: string): boolean {
  if (actual.length !== before.length + typed.length) return false;
  for (let i = 0; i <= before.length; i += 1) {
    if (before.slice(0, i) + typed + before.slice(i) === actual) return true;
  }
  return false;
}

/**
 * A document's identity: a number fixed for the life of one document. Needed
 * because `page.goto()` returning null does not by itself mean the document
 * survived. It is also null for `about:blank` and for non-HTTP schemes, where
 * a new document really was created.
 */
function documentIdentity(page: Page): Promise<number | null> {
  return page.evaluate(() => performance.timeOrigin).catch(() => null);
}

/** Tools that drive a tab: moving it somewhere and acting on the page. */
export const interactionTools = defineTools({
  navigate: defineTool({
    description:
      'Navigate a session\'s tab to a URL. A URL differing from the current one only in its hash is a SAME-DOCUMENT navigation: the browser changes the address but does not reload, so the JS context, in-page state (React state, timers, subscriptions) and the console buffer all survive. This tool does not quietly force a reload in that case, because navigating to a hash is a legitimate thing to test. It reports it instead: every result carries a "sameDocument" boolean, present in both the true and the false case, plus a note when it is true. Use reload when you need a real page load.',
    inputSchema: z.object({
      sessionId,
      pageId,
      url: z.string().describe('URL to navigate the tab to.'),
      waitUntil
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const before = await documentIdentity(target.page);
      const response = await target.page.goto(args.url, args.waitUntil ? { waitUntil: args.waitUntil } : undefined);
      const after = await documentIdentity(target.page);

      // A response means a document really was fetched and swapped in. A null
      // response is ambiguous on its own, so the identity check settles it.
      // When the identity is unreadable we say "same document", erring toward
      // warning the caller: a spurious warning costs one redundant reload, a
      // missed one costs a false pass.
      const sameDocument = response === null && (before === null || after === null || before === after);

      return text({
        pageId: target.pageId,
        url: target.page.url(),
        title: await target.page.title().catch(() => ''),
        sameDocument,
        ...(sameDocument
          ? {
              note:
                'Same-document navigation: the URL changed but the document was NOT reloaded. The JS context, in-page state and the console buffer all survive untouched, and nothing was re-fetched. Call reload if you need a real page load.'
            }
          : {})
      });
    }
  }),

  reload: defineTool({
    description:
      'Reload a session\'s tab: a real page load that discards the JS context, in-page state and everything the page had built up, and re-fetches the document. This is what navigate deliberately does not do when only the URL hash changes. The current URL, hash included, is kept.',
    inputSchema: z.object({
      sessionId,
      pageId,
      waitUntil
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const response = await target.page.reload(args.waitUntil ? { waitUntil: args.waitUntil } : undefined);
      return text({
        pageId: target.pageId,
        url: target.page.url(),
        title: await target.page.title().catch(() => ''),
        status: response?.status()
      });
    }
  }),

  click: defineTool({
    description:
      'Click an element in a session\'s tab with a real mouse press, at the element\'s centre by default. Pass x and y together to click a specific offset from the element\'s top-left corner, which is how you prove a dead band or an off-by-a-few-pixels hit area inside a control. Note that a right or middle click fires mousedown/mouseup/auxclick/contextmenu, not a click event.',
    inputSchema: z.object({
      sessionId,
      pageId,
      selector: z.string().describe('Playwright selector (CSS, text=, role=, etc.) of the element to click.'),
      ...selectorPosition,
      button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button to press. Defaults to "left".'),
      clickCount: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Number of clicks in one burst, e.g. 2 for a double click. Defaults to 1.')
    }),
    async handler(ctx, args) {
      if ((args.x === undefined) !== (args.y === undefined)) {
        throw new Error(
          'click needs both "x" and "y" to click a point inside the element, or neither to click its centre. Only one was given.'
        );
      }
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const position = args.x !== undefined && args.y !== undefined ? { x: args.x, y: args.y } : undefined;
      await target.page.click(args.selector, {
        ...(position ? { position } : {}),
        ...(args.button ? { button: args.button } : {}),
        ...(args.clickCount !== undefined ? { clickCount: args.clickCount } : {})
      });
      return text({
        ok: true,
        pageId: target.pageId,
        selector: args.selector,
        button: args.button ?? 'left',
        clickCount: args.clickCount ?? 1,
        ...(position ? { position } : {})
      });
    }
  }),

  fill: defineTool({
    description:
      'Set a field\'s contents in a session\'s tab, REPLACING whatever was there. Use type instead to append, or to fire per-character events. For an input, textarea or select this is Playwright\'s atomic fill. For a contenteditable, including rich editors like CodeMirror and Monaco, it focuses the element and replaces through real keyboard events (select-all, delete, insert), because those editors keep their own document model and treat a plain insertion as an insert at their cursor, appending onto the existing value instead of replacing it. Always reads the field back afterwards: the result carries "value" (what the field really contains now), "matched", and a "note" explaining the difference when they disagree.',
    inputSchema: z.object({
      sessionId,
      pageId,
      selector: z
        .string()
        .describe('Playwright selector of the field to fill: an input, textarea, select, or any contenteditable element.'),
      value: z.string().describe('Text the field should contain afterwards. An empty string clears it.')
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const locator = target.page.locator(args.selector);
      await setFieldValue(target.page, locator, args.value);
      const actual = await readFieldValue(target.page, locator);
      return writeResult(
        { pageId: target.pageId, selector: args.selector, requested: args.value },
        actual,
        actual === args.value,
        `Expected exactly ${JSON.stringify(args.value)}.`
      );
    }
  }),

  type: defineTool({
    description:
      'Type text into a session\'s tab character by character, with real key events, so per-character handlers, debounces, autocomplete and anything firing on a keystroke actually run. fill sets the value in one step and cannot exercise those. Does NOT clear the field first: it inserts at the caret, which is what a user typing does, so calling it twice types twice. Pass clear: true to replace the contents instead. Where the caret sits is the browser\'s call, not this tool\'s: focusing an input puts it after the existing text, focusing a contenteditable puts it before, so click the spot first if the insertion point matters. With no selector the keystrokes go to whatever currently has focus. Always reads the field back afterwards: the result carries "value" (what the field really contains now), "previousValue", "matched", and a "note" when what landed is not the typed text inserted into what was already there.',
    inputSchema: z.object({
      sessionId,
      pageId,
      selector: z
        .string()
        .optional()
        .describe('Playwright selector of the field to type into. Omit to type into whatever currently has focus.'),
      text: z.string().describe('Text to type, one character at a time.'),
      delay: z
        .number()
        .min(0)
        .optional()
        .describe('Milliseconds to pause between characters. Defaults to 0. Raise it to exercise debounces and in-flight state.'),
      clear: z
        .boolean()
        .optional()
        .describe('If true, clears the field before typing (default false: type appends at the caret, like a real user).')
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const locator = args.selector === undefined ? null : target.page.locator(args.selector);

      if (args.clear) {
        if (locator) {
          await setFieldValue(target.page, locator, '');
        } else {
          await target.page.keyboard.press(selectAllChord);
          await target.page.keyboard.press('Delete');
        }
      }

      const before = await readFieldValue(target.page, locator);
      const options = args.delay !== undefined ? { delay: args.delay } : undefined;
      if (locator) {
        await locator.pressSequentially(args.text, options);
      } else {
        await target.page.keyboard.type(args.text, options);
      }
      const actual = await readFieldValue(target.page, locator);

      // Typing inserts rather than replaces, so what to expect afterwards is
      // the previous contents with the typed text somewhere inside them, not
      // the typed text alone.
      return writeResult(
        {
          pageId: target.pageId,
          ...(args.selector !== undefined ? { selector: args.selector } : {}),
          typed: args.text,
          cleared: args.clear ?? false,
          previousValue: before
        },
        actual,
        isInsertionOf(before, args.text, actual),
        `Expected ${JSON.stringify(args.text)} inserted into the previous contents ${JSON.stringify(before)}.`
      );
    }
  }),

  press_key: defineTool({
    description:
      'Press a key in a session\'s tab, dispatching a real trusted key event. This is the only way to establish keyboard modality, which matters for accessibility checks: Chrome will not set :focus-visible on a button a script focused with .focus(), so a focus ring measured after a programmatic focus reports absent even when it is perfectly fine for a real user pressing Tab. Key syntax is Playwright\'s: Tab, Enter, Escape, ArrowDown, Backspace, a, Control+A, Shift+Tab. With no selector the key goes to whatever currently has focus. Returns where focus ended up and whether that element matches :focus-visible.',
    inputSchema: z.object({
      sessionId,
      pageId,
      key: z
        .string()
        .describe('Key or chord in Playwright syntax, e.g. "Tab", "Enter", "Escape", "ArrowDown", "Control+A", "Shift+Tab".'),
      selector: z
        .string()
        .optional()
        .describe('Playwright selector to press the key against. Omit to send it to whatever currently has focus.'),
      repeat: z.number().int().min(1).optional().describe('How many times to press the key. Defaults to 1.'),
      delay: z.number().min(0).optional().describe('Milliseconds to pause between repeats. Defaults to 0.')
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const repeat = args.repeat ?? 1;
      const locator = args.selector === undefined ? null : target.page.locator(args.selector);

      for (let i = 0; i < repeat; i += 1) {
        if (i > 0 && args.delay) {
          await new Promise(resolve => setTimeout(resolve, args.delay));
        }
        if (locator) {
          await locator.press(args.key);
        } else {
          await target.page.keyboard.press(args.key);
        }
      }

      const activeElement = await target.page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return null;
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id,
          text: (el.textContent ?? '').trim().slice(0, 80),
          focusVisible: el.matches(':focus-visible')
        };
      });

      return text({
        pageId: target.pageId,
        key: args.key,
        repeat,
        activeElement,
        focusVisible: activeElement?.focusVisible ?? false
      });
    }
  }),

  hover: defineTool({
    description:
      'Hover the mouse over an element in a session\'s tab, moving the real pointer to it. Synthetic pointerover/mouseover events dispatched from a script only exercise the page\'s own listeners: they cannot satisfy a CSS-only :hover rule, and they cannot open a tooltip that depends on real pointer geometry. This can. Pass x and y together to hover a specific offset from the element\'s top-left corner. Returns whether the element matches :hover afterwards.',
    inputSchema: z.object({
      sessionId,
      pageId,
      selector: z.string().describe('Playwright selector of the element to hover.'),
      ...selectorPosition
    }),
    async handler(ctx, args) {
      if ((args.x === undefined) !== (args.y === undefined)) {
        throw new Error(
          'hover needs both "x" and "y" to hover a point inside the element, or neither to hover its centre. Only one was given.'
        );
      }
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const position = args.x !== undefined && args.y !== undefined ? { x: args.x, y: args.y } : undefined;
      await target.page.hover(args.selector, position ? { position } : undefined);
      const hovering = await target.page
        .locator(args.selector)
        .evaluate((el: PageElement) => el.matches(':hover'))
        .catch(() => false);
      return text({
        pageId: target.pageId,
        selector: args.selector,
        hovering,
        ...(position ? { position } : {})
      });
    }
  }),

  resize: defineTool({
    description:
      'Resize a session\'s tab viewport. This sets the real Playwright viewport, so screenshots taken afterwards are captured at the new size. Resizing through raw CDP (Emulation.setDeviceMetricsOverride) instead changes window.innerWidth but leaves screenshots at the original viewport, which silently makes every responsive screenshot misleading. This tool cannot change deviceScaleFactor: Playwright fixes that per browser context when the context is created, so pass it to create_session instead. Returns the viewport read back from the page.',
    inputSchema: z.object({
      sessionId,
      pageId,
      width: z.number().int().min(1).describe('Viewport width in CSS pixels.'),
      height: z.number().int().min(1).describe('Viewport height in CSS pixels.')
    }),
    async handler(ctx, args) {
      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      await target.page.setViewportSize({ width: args.width, height: args.height });
      const measured = await target.page.evaluate(() => ({
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio
      }));
      return text({ pageId: target.pageId, width: args.width, height: args.height, ...measured });
    }
  }),

  wait_for: defineTool({
    description:
      'Wait for a condition in a session\'s tab, instead of sleeping for a guessed number of milliseconds. Give EITHER selector (with an optional state: visible, hidden, attached, detached) OR expression, a JavaScript expression polled until it is truthy. Exactly one of the two: passing both, or neither, is an error. Returns how long it actually waited, which is worth reading: a wait that returns in 0ms was already satisfied before you asked. On timeout it throws an error naming what it was waiting for and for how long, not a bare Playwright timeout.',
    inputSchema: z.object({
      sessionId,
      pageId,
      selector: z.string().optional().describe('Playwright selector to wait for. Mutually exclusive with "expression".'),
      state: z
        .enum(['visible', 'hidden', 'attached', 'detached'])
        .optional()
        .describe('State the selector must reach. Defaults to "visible". Only valid together with "selector".'),
      expression: z
        .string()
        .optional()
        .describe(
          'JavaScript expression evaluated in the page and polled until it is truthy, e.g. "document.querySelectorAll(\'.row\').length > 3". Mutually exclusive with "selector".'
        ),
      timeoutMs: z.number().int().min(1).optional().describe('How long to wait before giving up. Defaults to 10000.')
    }),
    async handler(ctx, args) {
      const hasSelector = args.selector !== undefined;
      const hasExpression = args.expression !== undefined;
      if (hasSelector === hasExpression) {
        throw new Error(
          `wait_for needs exactly one of "selector" or "expression": ${hasSelector ? 'both were given' : 'neither was given'}.`
        );
      }
      if (!hasSelector && args.state !== undefined) {
        throw new Error('wait_for\'s "state" describes a selector, so it is only valid together with "selector".');
      }

      const target = ctx.sessions.resolve(args.sessionId, args.pageId);
      const timeout = args.timeoutMs ?? 10_000;
      const state = args.state ?? 'visible';
      const waitedFor = hasSelector
        ? `selector ${JSON.stringify(args.selector)} to be ${state}`
        : `expression ${JSON.stringify(args.expression)} to be truthy`;
      const startedAt = Date.now();

      try {
        if (args.selector !== undefined) {
          await target.page.locator(args.selector).waitFor({ state, timeout });
        } else {
          await target.page.waitForFunction(args.expression as string, undefined, { timeout });
        }
      } catch (err) {
        const waitedMs = Date.now() - startedAt;
        // A bare Playwright timeout names the locator it gave up on and
        // nothing about what the caller was actually waiting for, so it gets
        // rewritten rather than passed through.
        if (err instanceof Error && err.name === 'TimeoutError') {
          throw new Error(`wait_for gave up after ${waitedMs}ms waiting for ${waitedFor}.`);
        }
        throw new Error(
          `wait_for failed after ${waitedMs}ms waiting for ${waitedFor}: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      return text({ pageId: target.pageId, satisfied: true, waitedMs: Date.now() - startedAt, waitedFor });
    }
  })
});
