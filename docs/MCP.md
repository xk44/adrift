# Adrift MCP server

`scripts/adrift-mcp.mjs` is a stdio [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI
agents (Claude Code, Codex, any MCP client) list and run Adrift's tools, generate images and fetch the results. It
has no dependencies beyond Node 20+, speaks newline-delimited JSON-RPC 2.0 on stdin/stdout (logs go to stderr), and
never opens a port: it calls a running Adrift over HTTP.

## Setup

Start Adrift (`npm run dev`), then register the server with your client. Run these from the repository root, or use an
absolute path to the script.

Claude Code:

```bash
claude mcp add adrift -- node scripts/adrift-mcp.mjs
# another host / key:
claude mcp add adrift -e ADRIFT_URL=http://127.0.0.1:3000 -e ADMIN_API_KEY=... -- node scripts/adrift-mcp.mjs
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.adrift]
command = "node"
args = ["/path/to/adrift/scripts/adrift-mcp.mjs"]
env = { ADRIFT_URL = "http://127.0.0.1:3000" }
```

| Env             | Default                 | Meaning                                                                      |
|-----------------|-------------------------|------------------------------------------------------------------------------|
| `ADRIFT_URL`    | `http://127.0.0.1:3000` | Adrift base URL.                                                             |
| `ADMIN_API_KEY` | unset                   | Sent as `Authorization: Bearer`. Required when Adrift is not on loopback.     |

Without a key the server sends `Origin` (the `ADRIFT_URL` origin) and `X-Requested-With: XMLHttpRequest`, which
pass Adrift's CSRF check for a loopback dev server. With a key the Bearer token is used instead.

## Tools

| Tool             | What it does                                                                                       |
|------------------|----------------------------------------------------------------------------------------------------|
| `list_tools`     | Every runnable tool: id, name, category, summary, inputs, `vram`, `commercial`, `available`. Filters: `query`, `category`, `kind`, `available_only`. |
| `describe_tool`  | One tool plus `input_schema` (JSON Schema).                                                         |
| `run_tool`       | `{ tool_id, inputs }`: uploads file inputs, queues the job, returns `job_id`, `job_ids`, `run_id`.  |
| `generate_image` | `{ prompt, batch_size?, workflow_path? }` through the Create path (`/api/jobs/imagine`); inline flags (`--ar 16:9` ...) work. |
| `job_status`     | `queued` / `running` / `done` / `error` / `cancelled` / `missing` / `unknown` for up to 50 jobs.     |
| `wait_for_job`   | Polls until done or `timeout_seconds` (default 60, max 300); includes outputs when done.            |
| `get_outputs`    | Files of a finished job: `url`, `ref`, `local_path` (when ComfyUI is on this machine), `final` on the main result; text outputs. |
| `cancel_job`     | Removes a queued job or interrupts it.                                                             |

Tool ids are the Tools page card keys: `action:<id>` (tools run via `/api/jobs/action`, e.g. `action:upscale`) and
`catalog:<id>` (LoRA edit tools via `/api/jobs/tool`, see [tools-api.md](tools-api.md)). Bare ids also resolve.

File inputs (`image`, `video`, `second_image`, `images[]`, `mask`, `audio` ...) take an absolute local path, an http(s)
URL, or an Adrift ref such as `photo.png [input]` or a `ref` from `get_outputs`, so results chain into the next tool.
Everything is uploaded through `/api/comfy/upload` (32 MB max). Image sizes and clip duration/size are read from the
file header for the source run.

Typical flow:

```
list_tools {query:"upscale"}
describe_tool {tool_id:"action:upscale"}
run_tool {tool_id:"action:upscale", inputs:{image:"/abs/photo.png", options:{...}}}
wait_for_job {job_id:"..."}
```

Errors from Adrift (bad input, missing model, unreachable server) come back as tool results with `isError: true`
and the API's message; protocol errors use the JSON-RPC codes (-32700 parse, -32600 invalid request, -32601 unknown
method, -32602 unknown tool / bad arguments).

## Server endpoints it uses

- `GET /api/tools/agent`: the tool list above. Schemas are generated from the tool registries (`ACTION_TOOLS` in
  `src/lib/tools/toolsPage.ts`, `editToolRegistry.json`) by `src/lib/mcp/agentTools.ts`; badges come from the same
  rows as `docs/TOOLS.md`; availability is the Tools page's (packs, models, LoRAs, custom nodes).
- `POST /api/tools/agent/compile`: `{ toolId, text?, second_text?, options?, edit_lora?, edit_family?, second_ref?,
  extra_refs?, mask_refs?, audio_ref?, audio_seconds? }` → `{ action, params, overrides }`, the same request the
  Tools page builds (`buildActionRequest`). Invalid options answer 400 `BAD_INPUT`.
- Existing routes: `/api/comfy/upload`, `/api/jobs/seed-run`, `/api/jobs/action`, `/api/jobs/tool`,
  `/api/jobs/imagine`, `/api/comfy/prompt-status`, `/api/comfy/history/<id>`, `/api/jobs/cancel`,
  `/api/settings/dirs` (local paths, loopback only).

Not exposed: Describe (not a queued job), source fps for video tools (the graph default is used), the inpaint
painter's union mask on action tools, and hidden cards.
