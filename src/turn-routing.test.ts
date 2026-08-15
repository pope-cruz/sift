import assert from "node:assert/strict";
import test from "node:test";

import { routeActiveTurn, type RoutingChannel } from "./turn-routing.ts";

function fakeChannel(events: string[]): RoutingChannel {
  return {
    send: async (text, options) => { events.push(`send:${text}${options?.transient ? ":transient" : ""}`); },
    responding: async (work) => { events.push("typing:start"); try { return await work(); } finally { events.push("typing:stop"); } },
  };
}

for (const transport of ["Spectrum", "web"] as const) {
  test(`${transport} adapter receives identical attachment routing`, async () => {
    const events: string[] = [];
    await routeActiveTurn({ text: "save this", attachmentCount: 1, channel: fakeChannel(events), ingest: async () => "Saved one deadline.", answer: async () => "unused" });
    assert.deepEqual(events, ["send:Sorting...:transient", "typing:start", "send:Saved one deadline.", "typing:stop"]);
  });

  test(`${transport} adapter receives identical text routing`, async () => {
    const events: string[] = [];
    await routeActiveTurn({ text: "what is next?", attachmentCount: 0, channel: fakeChannel(events), ingest: async () => "unused", answer: async () => "Project 1 is next." });
    assert.deepEqual(events, ["typing:start", "typing:stop", "send:Project 1 is next."]);
  });
}
