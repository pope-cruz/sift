import { waitUntil } from "@vercel/functions";

import { safeDiagnostic } from "./diagnostics.ts";

/**
 * Run background work without holding up the response. On Vercel, waitUntil
 * keeps the function alive until the work settles; elsewhere (Railway, the
 * local demo server) it no-ops and the promise simply runs in-process.
 *
 * Failures are logged, never surfaced: callers use this for housekeeping that
 * must not affect the request that happened to trigger it.
 */
export function defer(work: () => Promise<unknown>, label: string): void {
  const promise = work().catch((error) => {
    console.error(label, safeDiagnostic(error));
  });
  waitUntil(promise);
}
