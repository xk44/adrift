# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub's **Report a
vulnerability** button (Security tab → Advisories) on this repository. Do not
open a public issue for anything exploitable.

Include what you can of:

- the affected route, component or script and the commit you tested
- steps to reproduce, or a proof of concept
- the impact you expect (file read/write, code execution, data exposure, ...)

You should get a first response within a week. Fixes land on the default
branch; there are no separately maintained release branches, so only the
latest commit is supported.

## Threat model

Adrift is a **local-first, single-user** app: a Next.js server that drives a
ComfyUI instance on your own machine or network. It is not designed to be a
multi-tenant or internet-facing service.

What the server can do on behalf of whoever can reach its API:

- read and write files under the ComfyUI root (`input/`, `output/`, `models/`)
  and under `data/` in this app
- download model files from Hugging Face and Civitai into `models/`
- queue arbitrary workflows on ComfyUI
- install ComfyUI node packs through ComfyUI-Manager, including any public
  GitHub repository URL. **Installing a node pack runs its code.** Treat API
  access as equivalent to shell access on the GPU machine.
- import images from folders under `MOODBOARD_IMPORT_ROOT` (default: your home
  directory)

Because of that, access control is the main security boundary:

| Setting                         | Behaviour |
| ------------------------------- | --------- |
| `ADMIN_API_KEY` unset (default) | No authentication, so this mode is for one machine. `npm run dev` / `npm run start` listen on `127.0.0.1` only. Every `/api` request whose `Host` header is not `localhost`, `*.localhost`, `127.x.x.x` or `[::1]` gets 403, which blocks DNS rebinding and also LAN IPs and `*.local` names. Add other hostnames with `CJ_ALLOWED_HOSTS`. |
| `ADMIN_API_KEY` set             | Every API route except `/api/health` (without `?nodes=1`) and the login, logout and refresh endpoints needs `Authorization: Bearer <key>`, a signed session token, or the session cookie set by `/api/auth/login`. Any `Host` is accepted; credentials decide. |
| `CJ_HOST` not loopback          | Binding anywhere other than loopback (`CJ_HOST=0.0.0.0`, a LAN IP, `npm run dev -- -H ...`) without `ADMIN_API_KEY` is refused: `scripts/serve.mjs` will not start, the server exits at boot (`src/instrumentation.ts`), and every `/api` request gets 503 with a message saying what to set. |

Other protections that are always on:

- mutating requests (`POST`/`PUT`/`PATCH`/`DELETE`) need a same-origin
  `Origin`/`Referer` or `X-Requested-With: XMLHttpRequest`. A request with a
  **verified** bearer (the admin key, or an unexpired session token signed
  with `SESSION_SECRET`/`ADMIN_API_KEY`) skips that check; an unknown bearer
  does not (`src/middleware.ts`)
- CORS: `Access-Control-Allow-Origin` is sent only for the app's own origin
  and, exactly, the origin of `COMFY_HTTP_URL` (plus any exact origins in
  `CJ_COMFY_ORIGINS`). Other `localhost` ports get nothing
  (`src/lib/net/corsPolicy.ts`)
- file routes accept only validated names and resolve paths inside fixed
  roots. Moodboard image paths and the inpaint `workflow_path` (which must be
  a `.json` file under `public/workflows/` or a `saved:` workflow) resolve
  symlinks before the containment check, and errors don't echo file contents
- user-supplied image URLs (moodboards, describe, style references) are
  fetched through `src/lib/net/safeFetch.ts`: http(s) only, every address
  DNS returns is checked at connect time (loopback, private, link-local,
  cloud-metadata and `nip.io`-style names that resolve to them are refused),
  each redirect is re-checked, and size and time are capped. Only the exact
  host:port of the configured ComfyUI/StyleVault may be private
- Civitai model downloads take a model-version id and fetch the file URL
  Civitai's own API returns for it, not a URL from the request
- rate limits apply per route, including moodboards, describe, NEvo and the
  H3 warm toggle. `X-Forwarded-For` is ignored unless `TRUST_PROXY=1` (set it
  only behind a reverse proxy you run), so without a proxy all callers share
  one bucket per route; with it, limits are per client address
- `/api/h3-warm` answers only requests from this machine (loopback `Host`
  and forwarding headers) and starts the warm backend at most once a minute
- the ComfyUI proxy forwards only an allowlisted set of ComfyUI endpoints and
  never forwards the app's cookies or auth headers
- child processes (Blender, `dns-sd`, the ComfyUI start script) are spawned
  with argument arrays, never through a shell
- no secrets are exposed to the browser: the only `NEXT_PUBLIC_*` values are
  the ComfyUI WebSocket URL, the default pack id, the public repo URL, an
  optional abuse-report URL and feature flags

## Running it safely

1. **Stay on localhost.** `npm run dev` and `npm run start` bind to
   `127.0.0.1`. To reach Adrift from another device, set `ADMIN_API_KEY`
   first, then `CJ_HOST=0.0.0.0` (or a specific address) in `.env.local`, or
   pass `npm run dev -- -H <address>` for one run.

   The Docker setup publishes Adrift on `127.0.0.1` (`BIND_ADDR`) and
   ComfyUI on `127.0.0.1` (`COMFY_BIND_ADDR`, keep it there). Inside the
   container the server listens on all interfaces, so if you change
   `BIND_ADDR`, set `ADMIN_API_KEY` too: without it, requests that don't use
   a `localhost` name are refused.

2. **Set `ADMIN_API_KEY`** (a long random string, for example
   `openssl rand -hex 32`) before you let anything other than your own browser
   reach the server: phones on your Wi-Fi, other machines, containers,
   tunnels.
3. **Never expose Adrift or ComfyUI directly to the internet.** ComfyUI has no
   authentication of its own. For remote use, tunnel over SSH or a private VPN
   rather than forwarding ports.
4. **Keep ComfyUI on `127.0.0.1`** and pass `--enable-cors-header` with just
   the origin you open Adrift on (`scripts/start-comfyui.sh` does this).
   ComfyUI has no login, so never expose its port on a LAN or the internet;
   for a ComfyUI on another machine, forward its port over SSH.
5. **Review node packs before installing them.** The Manager tab blocks a list
   of known-malicious packs, but any GitHub URL you install runs with your
   user's permissions.
6. On macOS, when `CJ_HOST` is a non-loopback address (which requires
   `ADMIN_API_KEY`), the server advertises itself over Bonjour (`_cj._tcp`)
   so the companion app can find it. On the default `127.0.0.1` it
   advertises nothing.

## Secrets

- Keep keys in `.env.local` (git-ignored). Never commit `.env*` files other
  than `.env.example`.
- A Civitai key saved from the settings page is encrypted (AES-256-GCM)
  with a random local key that sits next to it in owner-only (`0600`) files.
  That protects against accidental copies of the config file, not against
  someone who can read your home directory.
- Model and workflow files you download are third-party content. Prefer
  `.safetensors` over pickle-based formats (`.ckpt`, `.pt`, `.bin`), which can
  run code when loaded.

## Out of scope

- Attacks that require API access when `ADMIN_API_KEY` is unset and the
  attacker can already reach the port (this is the documented no-auth mode)
- Vulnerabilities in ComfyUI, third-party node packs or model files; report
  those upstream
- Denial of service against a local GPU queue
