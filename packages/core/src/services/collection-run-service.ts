// Collection runner: sends every request under a collection or folder in tree order, one at a time, each through the
// normal pipeline (RunService.start: OAuth2, multipart, scripts and their bru.sendRequest calls, cookies, history).
// The environment is captured when the run starts, so switching the active one meanwhile changes nothing.
import { randomUUID } from 'node:crypto';
import { runSequence } from '@yept/core/engine/runner/collection-runner';
import type { Workspace } from '@yept/core/engine/workspace/workspace';
import { planRun, type RunnerEvent, type RunnerOptions, type RunnerResult } from '@yept/core/shared/collection-run';
import type { TreeNode } from '@yept/core/shared/model';
import type { RunScratch, RunService } from '@yept/core/services/run-service';

export class CollectionRunService {
  /** One collection run at a time. */
  private current: { runnerId: string; ac: AbortController } | null = null;

  constructor(private ws: () => Workspace, private runs: RunService, private emit: (e: RunnerEvent) => void) {}

  async start(runnerId: string, nodeId: string, options: RunnerOptions): Promise<RunnerResult> {
    if (this.current) throw new Error('A collection run is already going on. Wait for it to finish or cancel it.');
    const ws = this.ws();
    const node = findNode(ws.snapshot().collections, nodeId);
    if (!node || node.kind === 'request') throw new Error('That folder or collection no longer exists');
    const collectionId = ws.collectionIdOf(nodeId);
    const environment = options.environment ?? '';
    if (environment && !ws.getEnvironment(collectionId, environment)) throw new Error(`Environment not found: ${environment}`);
    const ac = new AbortController();
    this.current = { runnerId, ac };
    const scratch: RunScratch = { runtime: {}, session: {} };
    const historyErrors = new Map<string, string>();
    try {
      return await runSequence(planRun(node), {
        stopOnFailure: options.stopOnFailure,
        signal: ac.signal,
        newRunId: () => randomUUID(),
        runStep: async (item, runId) => {
          // The saved request: unsaved edits in the app are not part of a collection run.
          const { doc, path } = ws.getRequest(item.requestId);
          const ctx = await ws.requestContext(item.requestId);
          const { result, historyError } = await this.runs.start(runId, { requestId: item.requestId, requestName: doc.name, requestPath: path, ctx }, doc, { environment, signal: ac.signal, scratch });
          if (historyError) historyErrors.set(runId, historyError);
          return result;
        },
        onStepStart: (index, step) => {
          let url = '';
          try { url = ws.getRequest(step.requestId).doc.url; } catch { /* reported when the step runs */ }
          this.emit({ runnerId, type: 'step-start', index, step, collectionId, environment, url });
        },
        onStepEnd: (index, step, result, error) => this.emit({ runnerId, type: 'step-end', index, step, result, error, historyError: historyErrors.get(step.runId) })
      });
    } finally {
      this.current = null;
    }
  }

  cancel(runnerId: string): void {
    if (this.current?.runnerId === runnerId) this.current.ac.abort();
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
