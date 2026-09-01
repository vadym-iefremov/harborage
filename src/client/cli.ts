#!/usr/bin/env node
import { runGc } from './gc.js';
import { runWrapper } from './wrapper.js';

/**
 * With no arguments this is the MCP stdio server, which is how every MCP
 * client invokes it and the only behaviour that existed before. Anything else
 * is a subcommand.
 *
 * Nothing in the no-argument path may write to stdout: stdout is the MCP
 * transport, and one stray line on it corrupts the protocol stream. `gc`
 * writes to stdout freely, because it is never the stdio server.
 */
const [subcommand, ...rest] = process.argv.slice(2);

if (subcommand === undefined) {
  runWrapper().catch(err => {
    console.error('[harborage] client wrapper failed to start:', err);
    process.exit(1);
  });
} else if (subcommand === 'gc') {
  runGc(rest)
    .then(code => process.exit(code))
    .catch(err => {
      console.error('[harborage] gc failed:', err);
      process.exit(1);
    });
} else {
  console.error(
    `[harborage] unknown subcommand "${subcommand}".\n` +
      '\n' +
      'Usage:\n' +
      '  harborage             run the MCP stdio server (what an MCP client invokes)\n' +
      "  harborage gc          report which live processes on this machine are harborage's, and which are orphaned\n" +
      '  harborage gc --kill   also reap the orphaned ones, then verify by PID that they are gone\n'
  );
  process.exit(2);
}
