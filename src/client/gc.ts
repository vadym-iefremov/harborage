import { loadConfig, type Config } from '../shared/config.js';
import {
  liveOwnedProcesses,
  writeOwnedProcesses,
  type OwnedProcess,
  type OwnedProcessStatus
} from '../shared/ownedProcesses.js';
import { getProcessStartTime, listDescendantPids } from '../shared/processInfo.js';
import { pruneRegistryFile, readRegistry } from '../shared/registry.js';
import { checkHealth } from './daemonManager.js';

/**
 * One process `gc` has established, by provenance, that harborage owns, plus
 * the verdict on what should happen to it.
 *
 * `orphan` is the only verdict `--kill` acts on. It means: this process is
 * alive, harborage's own ledger says harborage started it, and the daemon
 * that started it is provably gone. Nothing else is ever reaped, however
 * suspicious it looks, because a cleanup tool that over-reaps on a machine
 * carrying somebody's real work is worse than the leak it was written for.
 */
export interface GcFinding {
  kind: 'daemon' | 'browser' | 'browser-descendant';
  pid: number;
  /** How harborage knows this process is its own. Never a name or command-line match. */
  provenance: string;
  verdict: 'serving' | 'owned-and-live' | 'orphan';
  detail: string;
}

export interface GcReport {
  /** Live processes attributable to harborage, with a verdict each. */
  findings: GcFinding[];
  /** Ledger entries whose process is gone: nothing to reap, just bookkeeping to drop. */
  staleLedgerEntries: number;
  /** Client-registry entries whose process is gone or whose PID has been reused. */
  staleRegistryEntries: number;
  /** Registered client wrappers still alive. */
  liveClients: number;
  /** Whether something is answering /health on the configured port. */
  daemonHealthy: boolean;
  /** PIDs actually signalled, present only when `--kill` was passed. */
  killed?: number[];
  /** PIDs that were signalled and were still alive afterwards. Non-empty here is a real problem. */
  survivedKill?: number[];
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Builds the report: what is alive that harborage owns, and which of it is
 * orphaned.
 *
 * Every finding here comes from one of exactly three sources of provenance:
 * a PID harborage's own daemon wrote into its ledger, a live descendant of
 * such a PID, or the client registry. There is no fourth source, and in
 * particular there is no matching on process names or command lines. That
 * restriction is not caution for its own sake: this runs on a shared machine
 * where a headless Chromium with a command line indistinguishable from
 * harborage's is far more likely to belong to the developer's own Playwright
 * run than to us.
 */
export async function collectGcReport(config: Config): Promise<GcReport> {
  const statuses = await liveOwnedProcesses(config.ownedProcessesPath);
  const daemonHealthy = await checkHealth(config, 1500);

  // The PID currently serving the configured port, if any, established by
  // asking it rather than by guessing. A daemon that answers /health is in
  // use, and gc never touches it.
  let servingPid: number | null = null;
  if (daemonHealthy) {
    try {
      const res = await fetch(`http://${config.host}:${config.port}/health`, { signal: AbortSignal.timeout(1500) });
      const body = (await res.json()) as { pid?: number };
      servingPid = typeof body.pid === 'number' ? body.pid : null;
    } catch {
      servingPid = null;
    }
  }

  const findings: GcFinding[] = [];
  const seen = new Set<number>();

  for (const status of statuses) {
    if (!status.alive) continue;
    const { entry } = status;
    seen.add(entry.pid);

    if (entry.pid === servingPid) {
      findings.push({
        kind: entry.kind,
        pid: entry.pid,
        provenance: 'recorded in harborage\'s own owned-process ledger',
        verdict: 'serving',
        detail: `answering /health on port ${config.port}; gc will not touch a daemon that is in use`
      });
      continue;
    }

    if (status.ownerAlive) {
      findings.push({
        kind: entry.kind,
        pid: entry.pid,
        provenance: 'recorded in harborage\'s own owned-process ledger',
        verdict: 'owned-and-live',
        detail: `the daemon that started it (pid ${entry.ownerPid}) is still running`
      });
      continue;
    }

    findings.push({
      kind: entry.kind,
      pid: entry.pid,
      provenance: 'recorded in harborage\'s own owned-process ledger',
      verdict: 'orphan',
      detail:
        `the daemon that started it (pid ${entry.ownerPid}) is gone; ` +
        `recorded ${Math.round((Date.now() - entry.recordedAt) / 1000)}s ago`
    });

    // Its children too, and only its children: a Chromium runs a GPU process,
    // a network service and a renderer per tab, none of which appear in the
    // ledger because the daemon never started them directly. Descent from a
    // PID we have already proven is ours is sound provenance for them.
    for (const child of await listDescendantPids(entry.pid)) {
      if (seen.has(child)) continue;
      seen.add(child);
      findings.push({
        kind: 'browser-descendant',
        pid: child,
        provenance: `a live descendant of pid ${entry.pid}, which the ledger records as harborage's`,
        verdict: 'orphan',
        detail: 'a helper process of an orphaned browser'
      });
    }
  }

  // A daemon that is serving but is not in the ledger. Two ways that happens:
  // it predates the ledger, or its start-time read failed and it declined to
  // write an unguarded PID. Either way, "something is answering harborage's
  // health endpoint on harborage's port" is provenance in its own right, and
  // leaving it out of the report would answer the operator's actual question
  // ("how much of this machine is harborage's right now") with a misleading
  // "none". It is reported as `serving`, which gc never reaps.
  if (servingPid !== null && !seen.has(servingPid)) {
    seen.add(servingPid);
    findings.push({
      kind: 'daemon',
      pid: servingPid,
      provenance: `answering harborage's /health endpoint on port ${config.port}`,
      verdict: 'serving',
      detail: 'not in the ledger, so it predates it or could not record itself; gc will not touch it either way'
    });
    for (const child of await listDescendantPids(servingPid)) {
      if (seen.has(child)) continue;
      seen.add(child);
      findings.push({
        kind: 'browser-descendant',
        pid: child,
        provenance: `a live descendant of pid ${servingPid}, the daemon serving port ${config.port}`,
        verdict: 'owned-and-live',
        detail: 'part of the running daemon\'s browser; it goes when the daemon does'
      });
    }
  }

  const registry = await readRegistry(config.registryPath);
  let liveClients = 0;
  for (const client of registry) {
    const live = await getProcessStartTime(client.pid);
    if (live !== null && live === client.startedAt) liveClients += 1;
  }

  return {
    findings,
    staleLedgerEntries: statuses.filter(s => !s.alive).length,
    staleRegistryEntries: registry.length - liveClients,
    liveClients,
    daemonHealthy
  };
}

/**
 * Drops ledger entries whose process is gone, so the file does not grow
 * forever. Touches nothing that is alive.
 */
async function pruneLedger(path: string, statuses: OwnedProcessStatus[]): Promise<void> {
  const survivors: OwnedProcess[] = statuses.filter(s => s.alive).map(s => s.entry);
  if (survivors.length !== statuses.length) {
    await writeOwnedProcesses(path, survivors);
  }
}

/**
 * Reaps the orphans in a report, by explicit PID, and then verifies by PID
 * that they are actually gone.
 *
 * The verification is not decoration. During the investigation that produced
 * this command, a `pkill -f 'node -e while(true){}'` silently matched nothing,
 * because `(true)` is a capture group and `{}` is a malformed quantifier, and
 * the `pgrep` used to check the result failed in exactly the same way and
 * reported zero remaining. Three processes were declared dead while they were
 * still spinning at 100% CPU. Anything that reports what it killed has to
 * confirm it against the process table afterwards, not against its own belief
 * about what its pattern meant.
 *
 * Children before parents, so a helper process cannot be re-parented and
 * missed while its browser is dying. SIGTERM first, then SIGKILL for whatever
 * is left, so a browser gets the chance to flush and close its profile
 * directory rather than leaving a corrupt one behind.
 */
export async function reapOrphans(config: Config, report: GcReport): Promise<GcReport> {
  const orphans = report.findings.filter(f => f.verdict === 'orphan');
  const order = [
    ...orphans.filter(f => f.kind === 'browser-descendant').map(f => f.pid),
    ...orphans.filter(f => f.kind !== 'browser-descendant').map(f => f.pid)
  ];

  const signalled: number[] = [];
  for (const pid of order) {
    try {
      process.kill(pid, 'SIGTERM');
      signalled.push(pid);
    } catch {
      // Already gone between the report and now. Not an error.
    }
  }

  if (signalled.length > 0) await sleep(1500);

  for (const pid of signalled) {
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch {
      // Not alive any more, which is the outcome we wanted.
    }
  }
  if (signalled.length > 0) await sleep(500);

  const survivedKill = signalled.filter(pid => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });

  await pruneLedger(config.ownedProcessesPath, await liveOwnedProcesses(config.ownedProcessesPath));
  await pruneRegistryFile(config.registryPath).catch(() => {
    // A registry that cannot be pruned is a cosmetic problem here: the daemon
    // prunes it on every sweep anyway.
  });

  return { ...report, killed: signalled, survivedKill };
}

function formatReport(config: Config, report: GcReport, killed: boolean): string {
  const lines: string[] = [];
  lines.push(`harborage gc  (state dir ${config.stateDir}, daemon port ${config.port})`);
  lines.push('');
  lines.push(
    report.daemonHealthy
      ? `Shared daemon: healthy on port ${config.port}.`
      : `Shared daemon: nothing answering on port ${config.port}.`
  );
  lines.push(`Registered client wrappers: ${report.liveClients} live, ${report.staleRegistryEntries} stale.`);
  lines.push('');

  if (report.findings.length === 0) {
    lines.push('No live processes are attributable to harborage.');
  } else {
    lines.push('Live processes harborage owns:');
    for (const finding of report.findings) {
      lines.push(`  [${finding.verdict}] pid ${finding.pid}  ${finding.kind}`);
      lines.push(`      why it is ours: ${finding.provenance}`);
      lines.push(`      ${finding.detail}`);
    }
  }

  const orphans = report.findings.filter(f => f.verdict === 'orphan');
  lines.push('');
  if (killed) {
    lines.push(`Reaped ${report.killed?.length ?? 0} orphaned process(es): ${report.killed?.join(', ') || 'none'}`);
    if (report.survivedKill && report.survivedKill.length > 0) {
      lines.push(`WARNING: still alive after SIGKILL, verified by PID: ${report.survivedKill.join(', ')}`);
    } else if ((report.killed?.length ?? 0) > 0) {
      lines.push('Verified by PID: all of them are gone.');
    }
  } else if (orphans.length > 0) {
    lines.push(`${orphans.length} orphaned process(es) found. Run "harborage gc --kill" to reap them.`);
  } else {
    lines.push('Nothing to reap.');
  }

  lines.push(`Dropped ${report.staleLedgerEntries} stale ledger entr(ies) from the record.`);
  lines.push('');
  lines.push(
    'gc only ever touches processes harborage recorded as its own, or live descendants of those, ' +
      'and never a daemon that is answering /health. It never matches on process names or command lines, ' +
      'so anything else on this machine that looks similar is left alone.'
  );
  return lines.join('\n');
}

/**
 * The `harborage gc` entrypoint.
 *
 * Without `--kill` it reports and changes nothing, which is the mode to reach
 * for first when a machine is unexpectedly hot and the question is what share
 * of it is harborage's fault. With `--kill` it additionally reaps the
 * processes it has classified as orphans, and verifies afterwards, by PID,
 * that they are gone.
 */
export async function runGc(argv: string[]): Promise<number> {
  const kill = argv.includes('--kill');
  const config = loadConfig();
  const report = await collectGcReport(config);
  const finalReport = kill ? await reapOrphans(config, report) : report;
  process.stdout.write(`${formatReport(config, finalReport, kill)}\n`);
  return finalReport.survivedKill && finalReport.survivedKill.length > 0 ? 1 : 0;
}
