# fm-server

OpenAI-compatible HTTP server for Apple Foundation Models on macOS. Drop it into any Node.js app or point an OpenAI client at `http://*********:<port>/v1` to run inference on-device or via Private Cloud Compute.

## Overview

fm-server exposes a small, OpenAI-shaped HTTP surface over Apple's Foundation Models:

- **`system`** — On-device `SystemLanguageModel` via [`javascript-apple-fm-sdk`](https://github.com/tariqwest/javascript-apple-fm-sdk) (in-process FFI)
- **`pcc`** — Private Cloud Compute `PrivateCloudComputeLanguageModel` via [`fm-access-pcc`](https://github.com/tariqwest/fm-access-PCC) (wraps the macOS `fm` CLI / `fm serve`)

**Endpoints**

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Liveness check (no auth) |
| `GET` | `/v1/models` | List available models and supported parameters |
| `POST` | `/v1/chat/completions` | Chat completion (streaming and non-streaming) |

**Capabilities**

- Bearer-token auth on all routes except `/health`
- Server-sent events streaming (`stream: true`)
- Tool calling with optional stdio MCP server injection
- Structured output via `response_format` (`json_object`, `json_schema`)
- Per-request session lifecycle with automatic cleanup

## Models

| Model ID | Backend | Requirements |
|----------|---------|--------------|
| `system` | On-device `SystemLanguageModel` | macOS 26+, Apple Silicon, Apple Intelligence enabled |
| `pcc` | Private Cloud Compute via `fm` CLI | macOS 27+, `fm` CLI at `/usr/bin/fm` |

Requests with any other model ID are rejected with `400`.

## When to use what

fm-server sits between the in-process TypeScript SDK and Swift-first tooling. Pick the layer that matches the job:

| Need | Use |
|------|-----|
| Call Foundation Models from Node/TS in-process (sessions, tools, guided generation, token APIs) | [`javascript-apple-fm-sdk`](https://github.com/tariqwest/javascript-apple-fm-sdk) |
| OpenAI-compatible HTTP for existing clients, Homebrew service, MCP tool injection, `system` + `pcc` in one process | **This package (`fm-server`)** |
| PCC-only library access or Terminal-hosted `fm serve` without the full OpenAI server | [`fm-access-pcc`](https://github.com/tariqwest/fm-access-PCC) (also the PCC backend under fm-server) |
| Swift CLI, adapters, or a browser workbench UI | [`afm`](https://github.com/rudrankriyam/Foundation-Models-Framework-CLI) (`afm serve`, `afm serve --ui`) |

**Guidance**

- Prefer **fm-server** when you want drop-in OpenAI client compatibility on macOS without embedding the SDK yourself.
- Prefer the **SDK** when you own the process and want the lowest-latency on-device path and full session/tool APIs.
- Prefer **fm-access-pcc** when you only need PCC (or system via `fm`) as a library and will host your own HTTP surface—or when debugging the serve-socket path used by fm-server's `pcc` model.
- Prefer **afm** for Swift-native workflows and UI; fm-server does not reimplement `afm serve --ui`. Point advanced UI users there rather than expecting a workbench in this repo.
- On-device **adapters** and Foundation Lab–style bridges belong in the Swift/`afm` world until `foundation-models-c` exposes them; do not expect them from fm-server's N-API path. **PCC** in fm-server goes through `fm-access-pcc` (CLI/`fm serve`), not C FFI.

## Related projects

fm-server is one layer in a small Foundation Models ecosystem. Rough relationship:

```text
apple/python-apple-fm-sdk (+ foundation-models-c)     ← upstream / parent ABI & API shape
        │
        ▼
javascript-apple-fm-sdk                              ← sibling: on-device TS/JS SDK (N-API)
        │
        ├──────────────────────┐
        ▼                      ▼
   fm-server  ◄──── fm-access-pcc                    ← siblings: OpenAI HTTP+CLI vs PCC/fm lib
        │
        ▼
   Homebrew tap / embedding apps                     ← downstream consumers of this package

overlap / inspiration (not dependencies):
  afm (Swift CLI + serve + UI)
  fm-acp (ACP stdio adapter over fm serve / afm / system)
  apple-on-device-ai (earlier Node bindings + Vercel AI SDK patterns)
```

### Parent / upstream

| Project | Role relative to fm-server |
|---------|----------------------------|
| [apple/python-apple-fm-sdk](https://github.com/apple/python-apple-fm-sdk) | **Parent upstream** for on-device semantics. Official Python bindings and in-tree `foundation-models-c`; the TS SDK aims at parity with this surface. fm-server does not depend on it directly. |
| Apple Foundation Models / Apple Intelligence | Platform parent: on-device `SystemLanguageModel` and PCC capability on supported macOS. |

### Siblings (same author stack)

| Project | Role relative to fm-server |
|---------|----------------------------|
| [javascript-apple-fm-sdk](https://github.com/tariqwest/javascript-apple-fm-sdk) | **Sibling dependency** — in-process on-device SDK (`system` backend). Pinned via GitHub release tarball. |
| [fm-access-PCC](https://github.com/tariqwest/fm-access-PCC) (`fm-access-pcc`) | **Sibling dependency** — library for `fm` / Terminal-hosted `fm serve`, including PCC. Powers the `pcc` backend. Pinned via GitHub release tarball. |
| [fm-acp](https://github.com/tariqwest/fm-acp) | **Sibling product** — ACP stdio adapter over Apple FM paths (`fm serve`, afm, system). Overlaps in “make FM usable from agents,” but different protocol (ACP vs OpenAI HTTP). Not a runtime dependency of fm-server. |

### This package and downstream

| Project | Role |
|---------|------|
| **fm-server** (this repo) | OpenAI-compatible HTTP server + CLI composing the on-device SDK and `fm-access-pcc`. |
| [tariqwest/homebrew-tap](https://github.com/tariqwest/homebrew-tap) | **Downstream distribution** — `fm-server` formula and launchd service. |
| Apps / agents using `baseURL` → `…/v1` | **Downstream consumers** — any OpenAI-compatible client pointed at fm-server. |

There is no separate “child library” extracted from this repo; the public npm-style surface *is* `fm-server` (`startServer`, `createApp`, CLI).

### Overlapping / inspiration (external)

| Project | Relationship |
|---------|----------------|
| [afm](https://github.com/rudrankriyam/Foundation-Models-Framework-CLI) (Foundation-Models-Framework-CLI) | **Primary product overlap** — Swift CLI, OpenAI-compatible `afm serve`, schema/tool UX, browser workbench (`serve --ui`), adapters/bridge direction. Inspiration for serve/CLI shape; fm-server is the JS-native counterpart for HTTP + Homebrew, not a reimplementation of the workbench or Swift bridge. |
| [apple-on-device-ai](https://github.com/Meridius-Labs/apple-on-device-ai) | **Inspiration / prior art** — earlier Node bindings and Vercel AI SDK provider patterns. Useful design reference; not an upstream ABI we track (prefer Apple `foundation-models-c` via `javascript-apple-fm-sdk`). |
| macOS `/usr/bin/fm` | System CLI used by `fm-access-pcc` (and thus fm-server `pcc`); not a separate open-source project. |

## Requirements

- macOS 26 (Tahoe) or later (macOS 27+ for PCC)
- Apple Silicon (M1+)
- Apple Intelligence enabled in System Settings
- Node.js 20+
- Dependencies are pinned to GitHub **release tarballs** (`javascript-apple-fm-sdk@v0.1.0`, `fm-access-pcc@v0.2.0`)

## Install

```bash
npm install fm-server
# or
pnpm add fm-server
```

From source:

```bash
git clone https://github.com/tariqwest/fm-server.git
cd fm-server
pnpm install   # pulls https://github.com/tariqwest/javascript-apple-fm-sdk/releases/download/v0.1.0/javascript-apple-fm-sdk-0.1.0.tgz
               # and https://github.com/tariqwest/fm-access-PCC/releases/download/v0.2.0/fm-access-pcc-0.2.0.tgz
pnpm run build
```

Optional local overrides (sibling checkouts) still work if you point package.json
back to `link:../…` or set `JS_APPLE_FM_SDK_PATH` / `FM_ACCESS_PCC_PATH` for release packaging.

Homebrew:

```bash
brew tap tariqwest/tap
brew install fm-server
```

## Quick start

Embed the server in a Node.js process:

```typescript
import { startServer } from "fm-server";

const server = await startServer({
  port: 11434,
  host: "127.0.0.1",
  token: "sk-apple-11434",
});

// Server is listening — point any OpenAI client here:
//   baseURL: http://127.0.0.1:11434/v1
//   apiKey:  sk-apple-11434

await server.stop();
```

Or mount the Hono app in your own HTTP stack:

```typescript
import { createApp, InferenceService } from "fm-server";

const inference = InferenceService.create();
const app = createApp({ inference, token: "sk-apple-11434" });

// app.fetch is a standard Request → Response handler
```

### Chat completion

```bash
curl -X POST http://*********:11434/v1/chat/completions \
  -H "Authorization: Bearer *************" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "system",
    "messages": [{"role": "user", "content": "Say hi."}]
  }'
```

### Private Cloud Compute

```bash
curl -X POST http://*********:11434/v1/chat/completions \
  -H "Authorization: Bearer *************" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "pcc",
    "messages": [{"role": "user", "content": "Explain quantum computing."}]
  }'
```

### Streaming

```bash
curl -N -X POST http://127.0.0.1:11434/v1/chat/completions \
  -H "Authorization: Bearer sk-apple-11434" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "system",
    "stream": true,
    "messages": [{"role": "user", "content": "Count to five."}]
  }'
```

### Streaming tool calls

Client-supplied tools are returned for the client to execute, in both streaming and
non-streaming requests. For example:

```bash
curl -N http://127.0.0.1:11434/v1/chat/completions \
  -H "Authorization: Bearer sk-apple-11434" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "system",
    "stream": true,
    "messages": [{"role": "user", "content": "Read package.json and list the available scripts."}],
    "tools": [{"type": "function", "function": {
      "name": "read",
      "description": "Read a project file.",
      "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}
    }}]
  }'
```

Following the [OpenAI streaming format](https://developers.openai.com/api/docs/guides/function-calling#streaming),
tool calls arrive in `choices[0].delta.tool_calls`, each with an `index`, `id`,
`type: "function"`, and `function: { name, arguments }`. Arguments are JSON strings.
The final choice has `finish_reason: "tool_calls"`, followed by `data: [DONE]`.
To continue, append the assistant's `tool_calls` (without the stream-only `index`)
and a `role: "tool"` message with the matching `tool_call_id` and tool result to
the next request's `messages`. Repeat for each step of an agent workflow.

This applies to both `system` and `pcc`. Tool-enabled streams buffer model output
until generation finishes, then emit either validated calls or ordinary text.
Requests without active tools continue streaming text incrementally.

For `system`, native guided generation constrains the response to an answer or
up to eight calls to the supplied functions. Names and argument strings stay
paired in nested objects; arguments are then validated against each function's
JSON Schema. Prior user messages, assistant calls, and tool results are restored
as native Foundation Models transcript entries rather than system instructions.
OpenCode and other clients still execute their own tools; fm-server does not
register native callbacks that execute client-supplied functions on the server.

PCC retains text-based tool detection and history folding. Single objects, arrays,
and nested OpenAI `function` objects are normalized; missing IDs are generated.
Both paths reject unavailable functions, duplicate call IDs, malformed arguments,
and arguments that violate the supplied schema. The schema validator supports
JSON Schema draft-07, 2019-09, and 2020-12; `format` annotations are not enforced.
Invalid client schemas and orphan native-history tool results return 400.

An invalid tool attempt or structured decoding failure gets **one corrective
retry** before any calls are emitted or MCP tools are executed. A second failure
returns a `server_error`: HTTP 500 for a non-streaming request, or an SSE error
followed by `[DONE]` after streaming headers have been sent. Invalid attempts
aren't silently displayed as assistant text. Usage combines completed attempts;
failed generations without usable output do not expose token counts.

`tool_choice: "none"` disables tool instructions, guided generation, and
conversion. `"auto"` is the default and permits text answers. `"required"` and
forced choices require a valid call; forced choices restrict the supplied tool
set to the selected function. Missing tools or an unknown forced name return 400.
Clients must still apply their permissions and validate tool actions before
execution. Correct names and argument shapes do not guarantee a correct action,
a complete task, or freedom from repeated calls. The model's context window and
output-token limit still apply to guided responses.

The pinned SDK 0.1.0 needs repairs for transcript restoration, nested generation
schemas, and aborting generation. pnpm applies the checked-in SDK patch; npm
applies the same patch in postinstall using macOS's `/usr/bin/patch`. Install
scripts must be enabled for npm, or run `node scripts/patch-sdk.js` explicitly.
Release bundles vendor the already-patched SDK. No on-device subprocess inference
backend is used.

Regression tests use fake inference and mock SDK bindings, including retries,
JSON Schema validation, cleanup, cancellation, native history, multiple calls,
and a complete `read → bash → read` loop. Live on-device checks executed the
three calls and returned a final answer after receiving their results; that run
batched the calls in one response. An OpenCode v2.0.26 check also executed `read`
and displayed the available scripts as ordinary assistant text. These are smoke
checks, not guarantees of autonomous coding-agent performance.

### Structured output

```bash
curl -X POST http://127.0.0.1:11434/v1/chat/completions \
  -H "Authorization: Bearer sk-apple-11434" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "system",
    "response_format": {
      "type": "json_schema",
      "json_schema": {
        "name": "person",
        "schema": {
          "type": "object",
          "properties": {
            "name": {"type": "string"},
            "age": {"type": "integer"}
          },
          "required": ["name", "age"]
        }
      }
    },
    "messages": [{"role": "user", "content": "Alice, age 30"}]
  }'
```

## Configuration

`startServer` accepts:

| Option | Default | Description |
|--------|---------|-------------|
| `port` | `11434` | Listen port |
| `host` | `127.0.0.1` | Bind address |
| `token` | `null` | Bearer token; omit or set `null` to disable auth |
| `mcpServers` | `[]` | Stdio MCP servers whose tools are injected when the client sends none |
| `debug` | no-op | Log callback |

> **Auth note:** `startServer` defaults `token` to `null` (auth off) so embedders opt in explicitly. The `fm-server serve` CLI defaults to `sk-apple-11434` (auth on) and honors the `FM_SERVER_TOKEN` env var.

MCP server spec:

```typescript
await startServer({
  port: 11434,
  token: "sk-apple-11434",
  mcpServers: [
    { command: "python3", args: ["/path/to/mcp_server.py"] },
  ],
});
```

When MCP tools are injected, detected tool calls are executed automatically and the model is re-prompted for a final answer.

## Supported request parameters

**Accepted:** `temperature`, `max_tokens`, `seed`, `stream`, `stream_options`, `tools`, `tool_choice`, `response_format`

**Rejected with 400:** `logprobs`, `n` (unless `1`), `stop`, `presence_penalty`, `frequency_penalty`, image content

## Architecture

```
HTTP client
  → Hono (app.ts)
       → ChatRequestValidator
       → ContextManager        # fold messages → (instructions, prompt)
       → Session.open(backend)
            ├─ onDevice:
            │    → InferenceService
            │         → javascript-apple-fm-sdk (in-process FFI)
            │              → SystemLanguageModel
            └─ privateCloudCompute:
                 → PccInferenceService
                      → fm-access-pcc → fm serve / /usr/bin/fm CLI
                           → PrivateCloudComputeLanguageModel
```

The adapter layer in `src/server/sdk/` maps OpenAI parameters to `GenerationOptions`, SDK errors to `AfmError`, and streaming snapshots to SSE deltas (on-device path).

The PCC adapter in `src/server/pcc/` wraps `fm-access-pcc`'s `respond()` function, converting its output to the same `InferenceRespondResult`/`InferenceStreamEvent` shapes.

| Module | Role |
|--------|------|
| `ModelProvider` | Model lifecycle, availability, context size, token counting |
| `GenerationMapper` | OpenAI params → `GenerationOptions` |
| `SdkErrorMapper` | SDK errors → `AfmError` |
| `InferenceService` | On-device: open, respond, stream, shutdown |
| `PccInferenceService` | PCC: respond, stream (via fm-access-pcc) |

## Project layout

```
fm-server/
├── src/server/       HTTP routes, SDK adapter, PCC adapter, MCP, validators
│   ├── sdk/          On-device inference (javascript-apple-fm-sdk)
│   ├── pcc/          PCC inference (fm-access-pcc)
│   ├── session/      Backend-dispatching session wrapper
│   └── ...
├── test/             unit and e2e tests
└── scripts/release.js
```

## Development

Bun is the primary runtime for scripts and tests. Node works via **tsx** without a compile step; published packages still ship compiled `dist/` for plain Node.

```bash
pnpm install
bun run start -- --help          # CLI via Bun (TypeScript source)
bun run start:node -- --help     # CLI via Node + tsx (no tsc)
bun run serve:dev                # serve from TypeScript
bun test                         # bun:test
bun run typecheck                # tsc --build (also emits dist/)
bun run build                    # same as typecheck with composite project
```

E2E tests require native `javascript-apple-fm-sdk` bindings and are skipped automatically when unavailable. They prefer `dist/cli/main.js` when present, otherwise spawn `tsx src/entry.ts`.

## Public API

Exported from the package root:

```typescript
import {
  startServer,
  createApp,
  InferenceService,
  Session,
  AfmError,
  ModelAvailability,
  McpStdioClient,
} from "fm-server";
```

See `src/server/index.ts` for the full export list.

## Background service (Homebrew)

The Homebrew formula registers a launchd service that keeps the server running in your login session (required for Apple Intelligence access):

```bash
brew services start fm-server
brew services info fm-server
```

Logs: `/opt/homebrew/var/log/fm-server.log`

## License

MIT
