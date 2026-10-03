# pi-langfuse-export

Export **saved Pi conversations** to Langfuse on demand. One command, no background tracing, no automatic uploads, no runtime dependencies.

Useful when you work offline, cannot reach Langfuse, or want to decide whether a conversation is safe to export **after** it happened. Resume an old session with `pi -c` or `/resume`, then run `/langfuse-export`.

## Install

From npm:

```sh
pi install npm:pi-langfuse-export
```

From GitHub:

```sh
pi install git:github.com/dirop1/pi-langfuse-export
```

From a local checkout:

```sh
pi install /path/to/pi-langfuse-export
```

Requires Node.js 22+ and Pi. Package metadata includes `pi-package` for discovery in the [Pi package gallery](https://pi.dev/packages).

## Usage

```text
/langfuse-export
/langfuse-export --dry-run
/langfuse-export --all
/langfuse-export --metadata-only
/langfuse-export --yes
/langfuse-export --help
```

By default, exports the **current branch's full saved history**, including entries before compaction. `--all` explicitly includes alternative/abandoned branches. The command asks for confirmation before uploading; `--yes` deliberately bypasses it and is required for non-interactive uploads. Wait until the agent is idle before exporting.

`--dry-run` builds the candidate records without network requests or checkpoint writes. It reports candidate counts, not the incremental count. The footer shows progress; a notification reports completion, an already-up-to-date state, or an error. Successful exports and already-up-to-date notifications include the full trace URL (`<baseUrl>/trace/<traceId>`), using Langfuse's trace-link route. No model call is made.

## Configuration

Configuration is read on each invocation. Precedence per field, highest first:

1. `export-langfuse-config.json` in the current working directory, **only when Pi trusts the project**.
2. `export-langfuse-config.json` in Pi's global agent directory (normally `~/.pi/agent`).
3. Environment variables.
4. Defaults.

```json
{
  "baseUrl": "https://cloud.langfuse.com",
  "publicKey": "pk-lf-...",
  "secretKey": "sk-lf-...",
  "captureContent": true
}
```

Keep credential files outside version control and restrict permissions to `0600`. Malformed/inaccessible configuration fails safely instead of silently falling back to another destination. Global and project files are not modified by this extension.

| Field | Environment | Default |
|---|---|---|
| `publicKey` | `LANGFUSE_PUBLIC_KEY` | Required |
| `secretKey` | `LANGFUSE_SECRET_KEY` | Required |
| `baseUrl` | `LANGFUSE_BASE_URL`, then `LANGFUSE_HOST`, then `LANGFUSE_BASEURL` | `https://cloud.langfuse.com` |
| `environment` | `LANGFUSE_TRACING_ENVIRONMENT` | Unset |
| `release` | `LANGFUSE_RELEASE` | Unset |
| `userId` | `LANGFUSE_USER_ID` | Unset |
| `captureContent` | — | `true` |

Use your region's Langfuse Cloud endpoint or your self-hosted endpoint. HTTPS is recommended; HTTP exposes credentials and conversation data in transit. Redirects are refused to avoid forwarding credentials elsewhere.

## Feature and limitation: saved history only

The extension does not need to have been installed when the conversation happened. This enables offline work and retrospective export, but **cannot reconstruct data Pi never saved**.

| Exported when present | Not reconstructed |
|---|---|
| User messages, assistant text and thinking | Exact provider request payload/system prompt for each historical call |
| Tool calls, arguments, outputs, details and errors | Exact generation/tool duration, time to first token |
| Historical model/provider/API and response identifiers | HTTP responses, headers and retries |
| Reported token usage and costs, including cache buckets | Historical Git state |
| Saved compaction/branch summaries, labels, model/thinking changes and custom messages | Transient tool progress |

Assistant messages become Langfuse generations; tools become child spans; other saved conversation entries become events under a single session trace. Missing fields are omitted; unknown saved entry types are preserved as events. Tool arguments are those saved in the assistant's call, not guaranteed to include later runtime mutations. Saved timestamps are source timestamps, **not fabricated execution timings**. Tool results carrying nested LLM usage retain it in metadata rather than being counted as a second generation.

The **model active at export time** is stored as `pi.export.active_model` on the trace, with `pi.export.thinking_level` and the upload timestamp `pi.export.exported_at`. It is explicitly separate from each generation's historical model: switching models before export does not rewrite history. If the active model is unavailable, it is omitted rather than guessed.

Image bytes, embedded base64 data URLs, opaque continuity signatures, and internal extension-state entries are excluded. Full textual saved content is retained rather than silently truncated. A single event exceeding 3 MB is rejected with a useful error; use metadata-only export or review the large saved content. This does not upload external files referenced by tool output paths.

## Incremental export and offline recovery

Trace and observation IDs are deterministic from the Pi session ID and saved entry IDs. Running the command again sends only new/changed records and updates the same trace. An unfinished tool later receiving a result updates its existing span. `/fork` and `/clone` have different session IDs and therefore separate traces.

Successful acknowledgements are persisted under `<agent-directory>/pi-langfuse-export-state/`, keyed by endpoint, public project key and session ID. State survives restart, `pi -c` and `/resume`; no credentials or conversation bodies are saved there. A change of destination creates a separate checkpoint. A changed export-time model updates trace metadata even when no new messages exist.

The public Langfuse ingestion API is used directly with Basic authentication and explicit per-event acknowledgement checks, including partial HTTP 207 responses. Errors do not terminate Pi. Accepted entries are checkpointed; retry uploads rejected/unacknowledged records. If the server accepted a request but the response was lost, retry uses the same **entity IDs** to upsert rather than create duplicate observations. A successful acknowledgement means accepted for ingestion, not necessarily already visible in the UI.

Each request has a 30-second timeout. Batches contain at most 50 events and approximately 3 MB. There is no automatic retry or upload on shutdown. A session shutdown/reload cancels pending network work. A lock prevents simultaneous exports for the same session/destination. After an abnormal process crash, if no export process is still running, remove the matching `.json.lock` file from the state directory and retry. Never remove a live lock.

## Privacy

**Manual does not mean anonymized.** Content may include PII, source code, credentials, shell output, custom-message details and compaction summaries. Review your session and destination before confirming. Configured Langfuse keys are masked, but this is **not a general secret or PII scanner**.

`--metadata-only` or `"captureContent": false` omits message/tool/summary bodies. Operational metadata such as session/header paths, entry identifiers, models and usage remains. Trace visibility defaults to non-public, subject to your Langfuse project's access controls.

If you decide a conversation should never be exported, simply do not run the command. If sensitive data was already exported, disabling capture or rerunning the command **does not guarantee its removal**; delete it in Langfuse and review retention/backups. Changing scope or returning to an earlier branch does not delete previously exported observations. Checkpoint files are local operational state, not a privacy eraser.

## Development

```sh
npm test
npm run check
npm pack --dry-run --ignore-scripts
```

Tests use synthetic conversations and mocked ingestion responses; they do not contact Langfuse. Pi loads the TypeScript entrypoint directly; no build or dependency installation is needed.

To develop alongside the installed npm package, use a separate local loader in `~/.pi/agent/extensions/langfuse-export-dev.ts` instead of installing the checkout directly:

```ts
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerLangfuseExport } from '/path/to/pi-langfuse-export/src/index.ts';

export default function (pi: ExtensionAPI) {
  registerLangfuseExport(pi, 'langfuse-export-dev');
}
```

After `/reload`, the npm package provides `/langfuse-export` and this loader provides `/langfuse-export-dev`, with separate status indicators. Direct checkout installs still use `/langfuse-export`; command renaming is explicit, not inferred from the installation path. Both commands use the same configuration, trace IDs and checkpoints: the development command performs real uploads unless `--dry-run` is used.

## Acknowledgements and license

Inspired by the detailed capture schema of [narumiruna/pi-extensions — pi-langfuse](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-langfuse). This is an independent saved-history exporter, not a realtime tracing fork or dependency.

MIT. See [LICENSE](./LICENSE).
