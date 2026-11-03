# mock-comfy: click every tool without a GPU

A fixture-backed stand-in for ComfyUI plus a headless crawl of the Tools hub.
No model ever runs: a queued job plays about 2 s of fake progress and returns
a bundled sample from `public/tool-previews/` (a still, or a clip for video
tools). The crawl fails any non-GET request in the browser before it leaves.

```bash
cd adrift

# 1. Mock ComfyUI (127.0.0.1 only). --fake-root writes zero-byte placeholder
#    weights so every tool reports "installed".
node scripts/mock-comfy/server.mjs --port 18999 --fake-root /tmp/mock-comfy-root &

# 2. Dev server wired to the mock (all backend URLs point at it).
MOCK_PORT=18999 PORT=3100 FAKE_ROOT=/tmp/mock-comfy-root scripts/mock-comfy/dev.sh &

# 3. Crawl: hub + every card's runner (?tool=<key>) at 1440 and 390 px.
node scripts/mock-comfy/crawl.mjs --base http://127.0.0.1:3100 --port 9300 \
  --widths 1440,390 --out /tmp/crawl-report.json
```

| Mock endpoint                                                         | Source                                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `GET /object_info`, `/object_info/<class>`                            | every `src/__tests__/fixtures/*objectInfo*.json` + `comfy-contract/object_info.json` |
| `GET /models`, `/models/<folder>`                                     | weight names the pack graphs in `public/workflows/packs` reference                   |
| `GET /queue`, `/system_stats`, `/features`, `/embeddings`, `/history` | empty / recorded `comfy-contract` fixtures                                           |
| `WS /ws`                                                              | handshake, `status`, and the fake run's `progress` / `executed` messages             |
| `POST /prompt`                                                        | fake run; the result (a `public/tool-previews/` file) lands in `/history`            |
| `GET /view`                                                           | serves that sample file                                                              |
| `POST /upload/image`, `/interrupt`, `/free`, `/queue`                 | accepted, nothing stored                                                             |
| any other POST/PUT/DELETE                                             | `503`                                                                                |

The crawl reports, per page and width: `console.error`, uncaught exceptions,
React error fallbacks ("could not load"), the Next dev error overlay, HTTP
errors other than the mock's 503s, failed fetches, non-GET requests fired on
load, and horizontal overflow (with the widest offending elements). It opens
runners by URL only and never clicks Run / Generate / Queue; `--click` instead
opens each card from the hub and returns via "All tools" (the path a judge
takes). For the "ComfyUI not running yet" state, start `dev.sh` with a
`MOCK_PORT` nothing listens on. `--only a,b`
limits it to some cards; `--shots DIR` saves a screenshot per page. Exit code
is 1 when any page has findings. Needs Node >= 22 and a Chrome, Brave or
Chromium binary (`CRAWL_BROWSER=/path/to/chrome` to pick one).
