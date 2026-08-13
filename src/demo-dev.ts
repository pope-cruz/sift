import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

import { demoApp } from "../api/demo.ts";
import { db } from "./db.ts";

const port = Number(process.env.PORT ?? 3000);
const localApp = new Hono();

// Local-only defaults: production still requires explicit secrets and starts
// disabled. These values never leave the developer machine.
process.env.DEMO_ENABLED ??= "true";
process.env.DEMO_TOKEN_SECRET ??= "sift-local-demo-token-secret-not-for-production";
process.env.CRON_SECRET ??= "sift-local-cron-secret";

// The production deployment uses Vercel rewrites. Locally, serve the exact
// same files and Hono API directly so testing never requires linking a project.
localApp.all("/api/demo/*", (c) => {
  const url = new URL(c.req.url);
  url.searchParams.set("route", url.pathname.slice("/api/demo/".length));
  url.pathname = "/api/demo";
  return demoApp.fetch(new Request(url, c.req.raw));
});
localApp.route("/", demoApp);
localApp.use("/demo/*", serveStatic({ root: "./web" }));
localApp.get("/demo", serveStatic({ path: "./web/demo/index.html" }));
localApp.get("/", serveStatic({ path: "./web/index.html" }));

serve({ fetch: localApp.fetch, port }, (info) => {
  console.log(`Sift demo: http://localhost:${info.port}/demo/`);
});

void db.from("students").select("channel").limit(1).then(({ error }) => {
  if (!error) return;
  if (error.code === "42703" || error.code === "42P01") {
    console.error("Demo database setup needed: run supabase/schema.sql once in the Supabase SQL Editor.");
    return;
  }
  console.error("Demo database check failed. Verify the Supabase server credentials and connection.");
});
