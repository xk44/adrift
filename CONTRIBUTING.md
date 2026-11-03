# Contributing to Adrift

Thanks for helping. Bug reports, new tools and fixes are all welcome.

## Before you start

- Open an issue first for anything larger than a small fix, so we can agree on
  the approach before you write it.
- You do not need a GPU to work on the UI or the API. The mock ComfyUI in
  `scripts/mock-comfy/` serves recorded fixtures (see
  [Try it without a GPU](README.md#try-it-without-a-gpu-2-minutes)).

## Development

```bash
npm ci
npm run dev           # app on http://127.0.0.1:3000
npm run type-check    # tsc --noEmit
npm run test:unit     # vitest
```

Every pull request runs type-check, the unit tests and a production build in
CI (`.github/workflows/ci.yml`). Please run the first two locally before you
push.

## Adding or changing a tool

Each tool card runs a plain ComfyUI API-format workflow from
`public/workflows/packs/`. A new tool needs:

1. the workflow JSON (no absolute paths, no private model names);
2. its entry in `src/lib/tools/toolsPage.ts`;
3. its models in the model map, so the card can show what is missing
   (regenerate the docs with `npm run docs:tools` and `npm run docs:models`);
4. a test under `src/__tests__/` for any new request or parameter logic.

Only reference models and node packs that anyone can download, and record each
model's license; see [MODELS.md](MODELS.md) and
[docs/custom-nodes.md](docs/custom-nodes.md).

## What not to commit

- Model weights, generated images or video, or datasets.
- `.env` files, API keys or tokens.
- Personal paths, hostnames or IP addresses. Tests and examples use obvious
  placeholders instead.

## License

By contributing you agree that your contribution is released under the
[MIT License](LICENSE). Diffs under `docs/patches/` are the exception: they
modify third-party node packs and stay under each pack's own license.
