# Interactive demo rollout

The browser demo and Spectrum worker share `processTurn`; they differ only at the transport and presentation boundaries.

## 1. Apply persistence changes

Run `supabase/schema.sql` against the target Supabase project. It is safe to re-run and adds:

- the `students.channel` isolation boundary;
- fixed-expiry anonymous sessions and persisted turn events;
- atomic session, upload-reservation, quota, and idempotency functions;
- temporary direct-upload rows for files larger than Vercel's function body limit.

The `attachments` bucket must remain private. Signed upload URLs are short-lived, opaque, and scoped to a random temporary path.

## 2. Configure server environments

Set the shared server values on both hosts:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ANTHROPIC_API_KEY`

Set only on Vercel:

- `DEMO_ENABLED=false` for the first deployment
- `DEMO_TOKEN_SECRET` (at least 32 random characters)
- `CRON_SECRET` (at least 16 random characters)

Set only on Railway:

- `PROJECT_ID`
- `PROJECT_SECRET`
- `DEMO_PHONE`

No Photon credential is required by the Vercel function bundle. Never expose the service-role, model, token, or cron secrets to browser-prefixed environment variables.

## 3. Deploy

Connect the repository root to Vercel. `vercel.json` serves the existing landing page, `/demo/`, the demo API, and the once-daily cleanup cron. Fluid Compute should be enabled; attachment turns are configured for a 300-second maximum.

Connect the same repository to Railway. `railway.json` starts only `npm run start`, which retains the always-on Spectrum loop and production reminder worker.

[Vercel Functions accept at most 4.5 MB request bodies](https://vercel.com/docs/functions/limitations#request-body-size), so browser files use an atomic quota reservation followed by a direct signed upload to Supabase. The turn function then downloads, signature-validates, and routes those bytes through the same ingest function as Spectrum. The public product limit remains 8 MB.

## 4. Bounded smoke test

Keep `DEMO_ENABLED=false` until all deployment health checks pass. Then enable it only for the smoke window and verify:

1. A new private browser session receives an anonymous token but no student UUID.
2. The deadline starter extracts dates, and a reload preserves the transcript.
3. The café starter is retrievable through a paraphrase.
4. The application starter creates a reminder; fast-forward delivers it once.
5. A second private browser session cannot see the first session.
6. Start over removes the transcript, database rows, persisted attachments, and temporary uploads.
7. Railway continues receiving Spectrum messages and its reminder query never selects `web_demo` students.
8. Anthropic spending limits and Vercel/Railway logs show the expected bounded traffic.

After the smoke session is deleted, enable the public demo by setting `DEMO_ENABLED=true` and redeploying the Vercel project.
