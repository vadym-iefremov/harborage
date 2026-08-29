#!/usr/bin/env node
import { runWrapper } from './wrapper.js';

runWrapper().catch(err => {
  console.error('[harborage] client wrapper failed to start:', err);
  process.exit(1);
});
