# sift

A [Spectrum](https://photon.codes/docs/spectrum-ts) project. Wired with: imessage.

## Environment

Before running, open `.env` and fill in the values:

From your project Settings on the [Photon dashboard](https://app.photon.codes):

- `PROJECT_ID`
- `PROJECT_SECRET`

## Run

```sh
npm install
npm run start
```

## Landing page

The public landing page lives in [`web/`](./web) as a single self-contained static file
(`web/index.html`) — no build step, no dependencies, no network or model calls at runtime.
It is ported from the Claude Design source (`Sift Landing.dc.html`); the design file's
`support.js` runtime is a design-tool dependency and is deliberately not shipped.

Preview it locally:

```sh
python3 -m http.server 4321 --directory web
```

To deploy, publish `web/` as the static root on any static host (Vercel, Netlify, GitHub
Pages, Cloudflare Pages). The demo in the page is a scripted walkthrough — it is not wired
to the agent in `src/`.

## Where to go next

- [Spectrum docs](https://photon.codes/docs/spectrum-ts)
- Edit `src/index.ts` to replace the echo loop with real agent logic.
- Add more providers from `spectrum-ts/providers/*`.

## Phase 3 validation

See [PHASE3.md](./PHASE3.md) for the retrieve/plan architecture, verification commands, bounded live demo, and current limitations.

## Phase 4 validation

See [PHASE4.md](./PHASE4.md) for the proactive reminder loop, deterministic timing rules, real `remind:now` path, and live acceptance evidence.
