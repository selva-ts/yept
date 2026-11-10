// Collection runner: sends every request under a collection or folder in tree order, one at a time, each through the
// normal pipeline (RunService.start: OAuth2, multipart, scripts and their bru.sendRequest calls, cookies, history).
// The environment is captured when the run starts, so switching the active one meanwhile changes nothing.
// A run can repeat the plan, once per row of a data file or a set number of times, with a wait between requests, and a
// finished run can be saved as a JUnit or HTML report built from redacted results.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import { runSequence } from '@yept/core/engine/runner/collection-runner';
import { dataFileInfo, readDataFile, type DataRow } from '@yept/core/engine/runner/data-file';
import { htmlReport, junitReport, type ReportStep, type RunReport } from '@yept/core/engine/runner/run-report';
import type { Workspace } from '@yept/core/engine/workspace/workspace';
import { cleanRunnerOptions, finishedStep, planRun, summarize, type DataFileInfo, type RunnerEvent, type RunnerOptions, type RunnerResult } from '@yept/core/shared/collection-run';
import type { RunResult, TreeNode } from '@yept/core/shared/model';
import type { RunScratch, RunService } from '@yept/core/services/run-service';
import type { AppHost } from '@yept/core/services/host';

export type ReportFormat = 'junit' | 'html';

/** Finished runs kept for export. */
const KEEP_REPORTS = 3;

export class CollectionRunService {
  /** One collection run at a time. */
  private current: { runnerId: string; ac: AbortController } | null = null;
  /** Data files chosen in a file dialog this session: a run reads only these. */
  private picked = new Set<string>();
  private reports = new Map<string, RunReport>();

  constructor(private ws: () => Workspace, private runs: RunService, private emit: (e: RunnerEvent) => void, private dialogs?: Pick<AppHost, 'openDialog' | 'saveDialog'>) {}

  /** Asks for a CSV or JSON data file and reads it. Null when the dialog is cancelled; a file that can't be used throws. */
  async pickDataFile(): Promise<DataFileInfo | null> {
    if (!this.dialogs) throw new Error('Choosing a data file is not available here');
    const r = await this.dialogs.openDialog({ title: 'Choose a data file (CSV or JSON)', properties: ['openFile'], filters: [{ name: 'Data files', extensions: ['csv', 'json'] }, { name: 'All files', extensions: ['*'] }] });
    const path = r.canceled ? undefined : r.filePaths[0];
    if (!path) return null;
    return this.useDataFile(path);
  }

  /** Reads a data file and lets runs use it. */
  async useDataFile(path: string): Promise<DataFileInfo> {
    const file = await readDataFile(path);
    this.picked.add(path);
    return dataFileInfo(path, file);
  }

  async start(runnerId: string, nodeId: string, options: RunnerOptions): Promise<RunnerResult> {
    if (this.current) throw new Error('A collection run is already going on. Wait for it to finish or cancel it.');
    const opts = cleanRunnerOptions(options);
    const ws = this.ws();
    const node = findNode(ws.snapshot().collections, nodeId);
    if (!node || node.kind === 'request') throw new Error('That folder or collection no longer exists');
    const collectionId = ws.collectionIdOf(nodeId);
    const environment = opts.environment ?? '';
    if (environment && !ws.getEnvironment(collectionId, environment)) throw new Error(`Environment not found: ${environment}`);
    let rows: DataRow[] | undefined;
    if (opts.dataFile) {
      if (!this.picked.has(opts.dataFile)) throw new Error('Choose the data file again.');
      // Read when the run starts, so an edit to the file since it was chosen is used.
      rows = (await readDataFile(opts.dataFile)).rows;
    }
    const iterations = rows ? rows.length : (opts.iterations ?? 1);
    const ac = new AbortController();
    this.current = { runnerId, ac };
    const scratch: RunScratch = { runtime: {}, session: {} };
    const historyErrors = new Map<string, string>();
    const redacted = new Map<string, RunResult>();
    const started = Date.now();
    try {
      const result = await runSequence(planRun(node), {
        stopOnFailure: opts.stopOnFailure,
        iterations,
        delayMs: opts.delayMs,
        signal: ac.signal,
        newRunId: () => randomUUID(),
        runStep: async (item, runId, iteration) => {
          // The saved request: unsaved edits in the app are not part of a collection run.
          const { doc, path } = ws.getRequest(item.requestId);
          const ctx = await ws.requestContext(item.requestId);
          const { result: r, historyError } = await this.runs.start(runId, { requestId: item.requestId, requestName: doc.name, requestPath: path, ctx }, doc, {
            environment, signal: ac.signal, scratch, data: rows?.[iteration - 1], onRedacted: (x) => redacted.set(runId, x)
          });
          if (historyError) historyErrors.set(runId, historyError);
          return r;
        },
        onStepStart: (index, step) => {
          let url = '';
          try { url = ws.getRequest(step.requestId).doc.url; } catch { /* reported when the step runs */ }
          this.emit({ runnerId, type: 'step-start', index, step, collectionId, environment, url });
        },
        onStepEnd: (index, step, result, error) => this.emit({ runnerId, type: 'step-end', index, step, result, error, historyError: historyErrors.get(step.runId) })
      });
      // The report is judged on the redacted results, so a secret in a test message or an error stays masked.
      const steps: ReportStep[] = result.steps.map((s) => {
        const r = s.runId ? redacted.get(s.runId) : undefined;
        if (!r) return s;
        return { ...finishedStep(s, r), url: r.request.url, requestHeaders: r.request.headers, responseHeaders: r.headers };
      });
      this.reports.set(runnerId, {
        name: node.name, kind: node.kind === 'collection' ? 'collection' : 'folder', environment, dataFile: opts.dataFile ? basename(opts.dataFile) : undefined,
        iterations, delayMs: opts.delayMs ?? 0, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, ended: result.ended, steps, summary: summarize(steps)
      });
      while (this.reports.size > KEEP_REPORTS) this.reports.delete(this.reports.keys().next().value!);
      return result;
    } finally {
      this.current = null;
    }
  }

  cancel(runnerId: string): void {
    if (this.current?.runnerId === runnerId) this.current.ac.abort();
  }

  /** A finished run's report as text. */
  report(runnerId: string, format: ReportFormat): string {
    const r = this.reports.get(runnerId);
    if (!r) throw new Error('This run is no longer available to export. Run it again.');
    return format === 'junit' ? junitReport(r) : htmlReport(r);
  }

  /** Asks where to save a finished run's report and writes it. Resolves the saved path, or null if cancelled. */
  async exportReport(runnerId: string, format: ReportFormat): Promise<string | null> {
    if (!this.dialogs) throw new Error('Saving a report is not available here');
    const text = this.report(runnerId, format);
    const r = this.reports.get(runnerId)!;
    const safe = r.name.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-').trim() || 'run';
    const opts = format === 'junit'
      ? { title: 'Export JUnit report', defaultPath: `${safe} results.xml`, filters: [{ name: 'JUnit XML', extensions: ['xml'] }] }
      : { title: 'Export HTML report', defaultPath: `${safe} report.html`, filters: [{ name: 'HTML', extensions: ['html'] }] };
    const saved = await this.dialogs.saveDialog(opts);
    if (saved.canceled || !saved.filePath) return null;
    await fs.writeFile(saved.filePath, text, 'utf8');
    return saved.filePath;
  }
}

function findNode(nodes: TreeNode[], id: string): TreeNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const c = n.children && findNode(n.children, id);
    if (c) return c;
  }
  return undefined;
}
