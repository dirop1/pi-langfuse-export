import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { buildPlan, exportPlan, loadConfig, sanitize } from './core.mjs';

export default function langfuseExport(pi: ExtensionAPI) {
  registerLangfuseExport(pi);
}

export function registerLangfuseExport(pi: ExtensionAPI, commandName: 'langfuse-export' | 'langfuse-export-dev' = 'langfuse-export') {
  const help = `/${commandName} [--all] [--metadata-only] [--dry-run] [--yes]\nExports saved active-branch history (including before compaction). --all includes abandoned branches. Nothing is sent automatically. Config: working-directory export-langfuse-config.json > global file > LANGFUSE_* env vars.`;
  let busy = false;
  let generation = 0;
  let controller: AbortController | undefined;
  pi.on('session_shutdown', () => { generation++; controller?.abort(); });
  pi.registerCommand(commandName, {
    description: 'Manually export saved conversation to Langfuse (incremental; no background tracing)',
    handler: async (args, ctx) => {
      const flags = new Set(args.trim().split(/\s+/).filter(Boolean));
      if (flags.has('--help')) { ctx.ui.notify(help, 'info'); return; }
      if ([...flags].some((flag) => !['--all', '--metadata-only', '--dry-run', '--yes'].includes(flag))) { ctx.ui.notify(help, 'warning'); return; }
      if (busy) { ctx.ui.notify('A Langfuse export is already running.', 'warning'); return; }
      if (!ctx.hasUI && !flags.has('--yes') && !flags.has('--dry-run')) throw new Error('Non-interactive export requires --yes.');
      // Reject rather than waiting indefinitely while the user expects a snapshot.
      if (!ctx.isIdle()) { ctx.ui.notify(`Wait until Pi finishes, then run /${commandName} again.`, 'warning'); return; }
      busy = true;
      const current = generation;
      const sessionId = ctx.sessionManager.getSessionId();
      const isCurrent = () => generation === current && ctx.sessionManager.getSessionId() === sessionId;
      const abort = new AbortController();
      controller = abort;
      try {
        const config = await loadConfig(getAgentDir(), ctx.cwd, process.env, ctx.isProjectTrusted());
        if (!isCurrent()) return;
        if (flags.has('--metadata-only')) config.captureContent = false;
        const entries = flags.has('--all') ? ctx.sessionManager.getEntries() : ctx.sessionManager.getBranch();
        const plan = buildPlan({ sessionId, entries, header: ctx.sessionManager.getHeader(), name: ctx.sessionManager.getSessionName(), activeModel: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, api: ctx.model.api } : undefined, thinkingLevel: ctx.thinkingLevel, config, scope: flags.has('--all') ? 'all' : 'branch' });
        if (flags.has('--dry-run')) {
          ctx.ui.notify(`Dry run: ${plan.entities.length} candidate records; ${entries.length} saved entries; content ${config.captureContent ? 'included' : 'disabled'}. No network request or checkpoint write.`, 'info');
          return;
        }
        if (ctx.hasUI && !flags.has('--yes')) {
          const accepted = await ctx.ui.confirm('Export saved history to Langfuse?', `${entries.length} entries; ${flags.has('--all') ? 'ALL branches' : 'active branch'}; ${config.captureContent ? 'includes prompts, thinking, tool content and summaries, which may contain PII or secrets' : 'metadata only'}.\nDestination: ${config.baseUrl}\nOnly new or changed records are sent. Previously exported data is not deleted.`, { signal: abort.signal });
          if (!isCurrent() || !accepted) return;
        }
        ctx.ui.setStatus(commandName, 'Langfuse: exporting…');
        const result = await exportPlan({ plan, config, agentDir: getAgentDir(), signal: abort.signal, onProgress: (done: number, total: number) => { if (isCurrent()) ctx.ui.setStatus(commandName, `Langfuse: ${done}/${total}`); } });
        if (!isCurrent()) return;
        const traceUrl = `${config.baseUrl}/trace/${encodeURIComponent(result.traceId)}`;
        ctx.ui.notify(result.count ? `Langfuse export complete: ${result.count} new/updated records.\n${traceUrl}` : `Langfuse is up to date.\n${traceUrl}`, 'info');
      } catch (error) {
        if (!isCurrent()) return;
        // Never print remote response bodies or credentials in diagnostics.
        const safe = sanitize(error instanceof Error ? error.message : 'Unknown export error', [process.env.LANGFUSE_PUBLIC_KEY, process.env.LANGFUSE_SECRET_KEY]);
        if (!ctx.hasUI) throw new Error(`Langfuse export failed: ${safe}`);
        ctx.ui.notify(`Langfuse export failed: ${safe}`, 'error');
      } finally {
        busy = false;
        if (controller === abort) controller = undefined;
        if (isCurrent()) ctx.ui.setStatus(commandName, undefined);
      }
    },
  });
}
