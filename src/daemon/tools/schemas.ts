import { animationTools } from './defs/animation.js';
import { emulationTools } from './defs/emulation.js';
import { inspectTools } from './defs/inspect.js';
import { interactionTools } from './defs/interaction.js';
import { networkTools } from './defs/network.js';
import { sessionTools } from './defs/session.js';
import { storageTools } from './defs/storage.js';

/**
 * The single source of truth for every tool: its name, description, input
 * schema and handler all live together in one definition, in one of the
 * `defs/` modules. This file only composes those modules into one table.
 *
 * Both the daemon (which implements these tools for real) and the client
 * wrapper (which registers pass-through tools with the exact same shape, then
 * forwards each call to the daemon over HTTP) drive their registration from
 * this table, so the two can never silently drift apart. Adding a tool means
 * adding one entry to one `defs/` module: nothing else needs touching.
 */
export const toolDefs = {
  ...sessionTools,
  ...interactionTools,
  ...inspectTools,
  ...emulationTools,
  ...networkTools,
  ...storageTools,
  ...animationTools
};

export type ToolName = keyof typeof toolDefs;

export const toolNames = Object.keys(toolDefs) as ToolName[];

/** Per-tool Zod input schema, derived from `toolDefs`. */
export const toolInputSchemas = Object.fromEntries(
  toolNames.map(name => [name, toolDefs[name].inputSchema])
) as { [K in ToolName]: (typeof toolDefs)[K]['inputSchema'] };

/** Per-tool description string, derived from `toolDefs`. */
export const toolDescriptions = Object.fromEntries(
  toolNames.map(name => [name, toolDefs[name].description])
) as Record<ToolName, string>;
