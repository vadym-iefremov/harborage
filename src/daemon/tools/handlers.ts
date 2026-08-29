import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { SessionStore } from '../sessions.js';
import type { ToolName, toolInputSchemas } from './schemas.js';

import * as z from 'zod/v4';

type Args<T extends ToolName> = z.infer<(typeof toolInputSchemas)[T]>;

/** A tool result content block, matching what `@modelcontextprotocol/server` expects back from a handler. */
type ContentBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type ToolResult = { content: ContentBlock[]; structuredContent?: unknown; isError?: boolean };

function text(value: unknown): ToolResult {
  const asText = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text: asText }], structuredContent: typeof value === 'string' ? undefined : value };
}

/** What createToolHandlers needs from the daemon's Config, kept narrow so tests can pass a minimal subset. */
export interface ToolHandlerConfig {
  debugPort: number;
  screenshotCacheDir: string;
  screenshotCacheTtlMs: number;
}

/**
 * Builds the tool handler functions, closing over one daemon's
 * `SessionStore` + the handful of config values a few tools need directly
 * (the CDP debug port for escalate_session, the screenshot cache directory
 * and TTL for screenshot's `mode: 'cached'`). Kept separate from tool
 * *registration* (see `server.ts`) so the actual browser-driving logic has
 * no dependency on the MCP SDK's types.
 */
export function createToolHandlers(sessions: SessionStore, config: ToolHandlerConfig) {
  const { debugPort, screenshotCacheDir, screenshotCacheTtlMs } = config;

  return {
    async create_session({ storageState }: Args<'create_session'>): Promise<ToolResult> {
      const { sessionId, pageId } = await sessions.createSession(storageState);
      return text({ sessionId, pageId });
    },

    async navigate({ sessionId, pageId, url, waitUntil }: Args<'navigate'>): Promise<ToolResult> {
      const target = sessions.resolve(sessionId, pageId);
      await target.page.goto(url, waitUntil ? { waitUntil } : undefined);
      return text({ pageId: target.pageId, url: target.page.url(), title: await target.page.title().catch(() => '') });
    },

    async click({ sessionId, pageId, selector }: Args<'click'>): Promise<ToolResult> {
      const target = sessions.resolve(sessionId, pageId);
      await target.page.click(selector);
      return text({ ok: true, pageId: target.pageId });
    },

    async fill({ sessionId, pageId, selector, value }: Args<'fill'>): Promise<ToolResult> {
      const target = sessions.resolve(sessionId, pageId);
      await target.page.fill(selector, value);
      return text({ ok: true, pageId: target.pageId });
    },

    async evaluate({ sessionId, pageId, expression }: Args<'evaluate'>): Promise<ToolResult> {
      const target = sessions.resolve(sessionId, pageId);
      const result = await target.page.evaluate(expression);
      return text({ pageId: target.pageId, result });
    },

    async snapshot({ sessionId, pageId }: Args<'snapshot'>): Promise<ToolResult> {
      const target = sessions.resolve(sessionId, pageId);
      const snapshot = await target.page.locator('body').ariaSnapshot({ mode: 'ai' });
      return text({ pageId: target.pageId, url: target.page.url(), snapshot });
    },

    async list_tabs({ sessionId }: Args<'list_tabs'>): Promise<ToolResult> {
      const tabs = await sessions.listTabs(sessionId);
      return text({ tabs });
    },

    async screenshot({ sessionId, pageId, fullPage, mode }: Args<'screenshot'>): Promise<ToolResult> {
      const target = sessions.resolve(sessionId, pageId);
      const buffer = await target.page.screenshot({ fullPage: fullPage ?? false, type: 'png' });

      if (mode === 'cached') {
        await mkdir(screenshotCacheDir, { recursive: true });
        const cacheId = randomUUID();
        const filePath = join(screenshotCacheDir, `${cacheId}.png`);
        await writeFile(filePath, buffer);
        return text({
          pageId: target.pageId,
          mode: 'cached',
          cacheId,
          path: filePath,
          sizeBytes: buffer.length,
          expiresAt: new Date(Date.now() + screenshotCacheTtlMs).toISOString()
        });
      }

      // Default: inline base64 only, never written to disk.
      return { content: [{ type: 'image', data: buffer.toString('base64'), mimeType: 'image/png' }] };
    },

    async export_state({ sessionId }: Args<'export_state'>): Promise<ToolResult> {
      const target = sessions.resolve(sessionId);
      const storageState = await target.session.context.storageState();
      return text({ storageState });
    },

    async escalate_session({ sessionId, pageId, reason }: Args<'escalate_session'>): Promise<ToolResult> {
      const target = sessions.resolve(sessionId, pageId);
      console.error(`[harborage] escalate_session ${sessionId}/${target.pageId}: ${reason}`);

      const cdpSession = await target.session.context.newCDPSession(target.page);
      let targetId: string;
      try {
        const info = await cdpSession.send('Target.getTargetInfo');
        targetId = (info as { targetInfo: { targetId: string } }).targetInfo.targetId;
      } finally {
        await cdpSession.detach().catch(() => {});
      }

      const listUrl = `http://localhost:${debugPort}/json/list`;
      const response = await fetch(listUrl);
      if (!response.ok) {
        throw new Error(`Could not reach the remote debugging endpoint at ${listUrl} (HTTP ${response.status}).`);
      }
      const targets = (await response.json()) as { id: string; webSocketDebuggerUrl: string; devtoolsFrontendUrl?: string; url: string }[];
      const match = targets.find(t => t.id === targetId);
      if (!match) {
        throw new Error(`Target ${targetId} for session ${sessionId} was not found at ${listUrl}.`);
      }

      return text({
        sessionId,
        pageId: target.pageId,
        webSocketDebuggerUrl: match.webSocketDebuggerUrl,
        devtoolsFrontendUrl: match.devtoolsFrontendUrl,
        url: match.url
      });
    },

    async release_session({ sessionId }: Args<'release_session'>): Promise<ToolResult> {
      await sessions.releaseSession(sessionId);
      return text({ ok: true, sessionId });
    },

    async list_sessions(): Promise<ToolResult> {
      return text({ sessions: sessions.listSessions() });
    },

    async read_console({ sessionId, pageId, clear }: Args<'read_console'>): Promise<ToolResult> {
      const messages = sessions.getConsoleMessages(sessionId, pageId, clear ?? false);
      return text({ messages });
    },

    async list_network_requests({ sessionId, pageId, clear }: Args<'list_network_requests'>): Promise<ToolResult> {
      const requests = sessions.getNetworkEntries(sessionId, pageId, clear ?? false);
      return text({ requests });
    },

    async send_cdp_command({ sessionId, pageId, method, params }: Args<'send_cdp_command'>): Promise<ToolResult> {
      const target = sessions.resolve(sessionId, pageId);
      const cdpSession = await target.session.context.newCDPSession(target.page);
      try {
        // `method` is a runtime string, not one of Playwright's literal CDP
        // method types — this is deliberately the agent-facing "raw" escape
        // hatch, so the cast is the point, not a workaround. Called directly
        // on `cdpSession` (not detached into a standalone function) so its
        // internal `this` binding stays intact.
        const result = await cdpSession.send(method as Parameters<typeof cdpSession.send>[0], params as never);
        return text({ sessionId, pageId: target.pageId, method, result });
      } finally {
        await cdpSession.detach().catch(() => {});
      }
    }
  } satisfies Record<ToolName, (args: never) => Promise<ToolResult>>;
}
