import assert from "node:assert/strict";
import test from "node:test";

import { isMissingSchemaFeature } from "./schema-compat.ts";

test("only recognized missing database features trigger compatibility mode", () => {
  assert.equal(isMissingSchemaFeature({ code: "PGRST204", message: "processing_status missing" }, ["processing_status"]), true);
  assert.equal(isMissingSchemaFeature({ code: "PGRST202", message: "claim_inbound_message not found" }, ["claim_inbound_message"]), true);
  assert.equal(isMissingSchemaFeature({ code: "42501", message: "permission denied" }, ["processing_status"]), false);
  assert.equal(isMissingSchemaFeature(new Error("network failed"), ["processing_status"]), false);
});
