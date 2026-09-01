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
  .describe(
    'Tab id from list_tabs. Defaults to the session\'s active tab (call select_tab to change which one that is). ' +
      'Passing pageId targets this one call only: it does not make that tab the new default for later calls that ' +
      'omit pageId, so a one-off screenshot or read of a background tab never silently redirects everything after ' +
      'it. Use select_tab when you actually want to switch. ' +
      'A pageId this session has never issued is an ERROR, not an empty result: a mistyped tab id used to come ' +
      'back from the buffered reads as total 0, dropped 0, which reads exactly like a tab that was simply quiet. ' +
      'A tab that has since been CLOSED is still a valid id for those reads, though, since its buffered console ' +
      'and network output outlives it and reading a popup after it has gone is the whole point of buffering.'
  );

export const clear = z
  .boolean()
  .optional()
  .describe(
    'If true, removes the entries this call returned from the buffer after reading them (default false: peek without clearing). '  +
      'Only what the filters actually matched is removed, so narrowing a read by tab or by content never silently discards entries you did not see.'
  );
