import * as z from 'zod/v4';

/**
 * Field schemas shared by several tools. They live here so a field that means
 * the same thing in two tools is described identically in both, and so a
 * reworded description lands everywhere at once.
 */

export const sessionId = z.string().min(1).describe('Session id returned by create_session.');

export const pageId = z
  .string()
  .optional()
  .describe('Tab id from list_tabs. Defaults to the session\'s most recently active tab.');

export const clear = z
  .boolean()
  .optional()
  .describe('If true, clears the returned entries from the buffer after reading them (default false: peek without clearing).');
