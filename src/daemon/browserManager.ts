import { chromium, type Browser } from 'playwright';

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

  constructor(private readonly debugPort: number) {}

  async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.launching) return this.launching;

    this.launching = chromium
      .launch({
        headless: true,
        chromiumSandbox: true,
        args: [`--remote-debugging-port=${this.debugPort}`]
      })
      .then(browser => {
        this.browser = browser;
        browser.on('disconnected', () => {
          if (this.browser === browser) this.browser = null;
        });
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
    this.browser = null;
    if (browser?.isConnected()) {
      await browser.close();
    }
  }
}
