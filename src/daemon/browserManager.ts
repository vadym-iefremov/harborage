import { chromium, type Browser } from 'playwright';

import { listChildPids } from '../shared/processInfo.js';

/**
 * Told which OS processes a browser launch created, and which a close
 * retired, so the daemon can write them into its owned-process ledger and
 * `harborage gc` can identify them later.
 *
 * A callback rather than the ledger itself, because this class has no business
 * knowing about config paths or JSON files, and because a failed ledger write
 * must never be able to fail a browser launch.
 */
export interface BrowserProcessObserver {
  onLaunched: (pids: number[]) => void;
  onClosed: (pids: number[]) => void;
}

/**
 * Owns the single Chromium process this daemon runs. Launched lazily, on
 * the first call to `getBrowser()`, not eagerly at daemon startup.
 *
 * Why lazy: the client wrapper's ensure-running step spawns the daemon
 * unconditionally whenever a Claude Code session opens the MCP connection,
 * whether or not that session ever actually calls a browser tool. Eagerly
 * launching Chromium on daemon boot would pay ~150-300MB of RAM and a
 * real startup delay for every session that just happens to have this MCP
 * server configured, even ones that never touch a browser. Launching on
 * first `create_session` means that cost is only ever paid by sessions that
 * actually use the pool; the very first `create_session` in a given daemon
 * lifetime just waits slightly longer.
 *
 * Two more decisions worth calling out:
 * - `chromiumSandbox: true` is passed explicitly. Playwright's own default
 *   for this option is `false` (it adds `--no-sandbox` itself unless told
 *   otherwise). Simply not passing `--no-sandbox` in `args` is NOT enough
 *   to keep the OS sandbox on, confirmed by directly inspecting the
 *   launched process's command line. This is the actual mechanism that
 *   satisfies "don't inherit @playwright/mcp's disabled-sandbox default".
 * - `--remote-debugging-port` is passed unconditionally at launch, because
 *   Chromium cannot open that port after the process has already started.
 *   escalate_session doesn't toggle it on later, it just queries
 *   `http://localhost:<debugPort>/json/list` for the page that's already
 *   there.
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  /**
   * The PIDs the current launch created, established by diffing this
   * process's own direct children across the launch.
   *
   * Playwright's `launch()` returns a `Browser`, not a handle on the OS
   * process behind it, so there is no supported way to ask it for a PID. The
   * diff is the honest substitute and it is sound provenance: whatever appears
   * as a new direct child of the daemon while the daemon is launching a
   * browser is a process the daemon started. It is not used to decide what to
   * kill during normal operation, only to write down what we own so cleanup
   * remains possible after this daemon is gone.
   */
  private launchedPids: number[] = [];

  constructor(
    private readonly debugPort: number,
    private readonly observer?: BrowserProcessObserver
  ) {}

  async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.launching) return this.launching;

    const before = this.observer ? new Set(await listChildPids(process.pid)) : null;

    this.launching = chromium
      .launch({
        headless: true,
        chromiumSandbox: true,
        args: [`--remote-debugging-port=${this.debugPort}`]
      })
      .then(async browser => {
        this.browser = browser;
        browser.on('disconnected', () => {
          if (this.browser === browser) this.browser = null;
        });
        if (before && this.observer) {
          const after = await listChildPids(process.pid);
          this.launchedPids = after.filter(pid => !before.has(pid));
          this.observer.onLaunched(this.launchedPids);
        }
        return browser;
      })
      .finally(() => {
        this.launching = null;
      });

    return this.launching;
  }

  isLaunched(): boolean {
    return this.browser?.isConnected() ?? false;
  }

  async close(): Promise<void> {
    const browser = this.browser;
    const pids = this.launchedPids;
    this.browser = null;
    this.launchedPids = [];
    if (browser?.isConnected()) {
      await browser.close();
    }
    // After the close, not before: the ledger's job is to name processes that
    // may still be out there, so an entry must not be dropped until the thing
    // it describes has actually been asked to go away.
    if (pids.length > 0) this.observer?.onClosed(pids);
  }
}
