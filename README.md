# sift

A [Spectrum](https://photon.codes/docs/spectrum-ts) project. Wired with: imessage.

## Environment

Before running, open `.env` and fill in the values:

From your project Settings on the [Photon dashboard](https://app.photon.codes):

- `PROJECT_ID`
- `PROJECT_SECRET`

## Run the iMessage worker

```sh
npm install
npm run start
```

`npm run start` connects the real Spectrum/iMessage worker and starts the reminder loop. Use
`npm run dev` only when you want that worker to restart after source changes.

## Run the browser demo locally

No Vercel or Railway deployment is required for local testing. The browser demo uses the same
Supabase and Anthropic server credentials as the worker, but it does not connect to Photon:

```sh
npm run demo:dev
```

Then open <http://localhost:3000/demo/>. The local server enables the demo with development-only
token secrets; it still needs the shared server values documented in `.env.example`. Apply
`supabase/schema.sql` once before testing a schema change.

## Landing page

The public landing page lives in [`web/`](./web) as a static file (`web/index.html`). Its preview
is scripted and makes no model calls; the dedicated `/demo/` route is the real interactive demo.
It is ported from the Claude Design source (`Sift Landing.dc.html`); the design file's
`support.js` runtime is a design-tool dependency and is deliberately not shipped.

Use `npm run demo:dev` to preview both surfaces with the correct local API routing.

## Where to go next

- [Spectrum docs](https://photon.codes/docs/spectrum-ts)
- Add more providers from `spectrum-ts/providers/*`.

## Phase 3 validation

See [PHASE3.md](./PHASE3.md) for the retrieve/plan architecture, verification commands, bounded live demo, and current limitations.

## Phase 4 validation

See [PHASE4.md](./PHASE4.md) for the proactive reminder loop, deterministic timing rules, real `remind:now` path, and live acceptance evidence.
