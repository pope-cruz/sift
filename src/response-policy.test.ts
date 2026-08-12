import assert from "node:assert/strict";
import { test } from "node:test";

import {
  confirmationFallback,
  validateConversationalEconomy,
} from "./response-policy.ts";

test("one-line completed actions remain one line", () => {
  assert.equal(
    validateConversationalEconomy({
      text: "Done — club meeting added for Sat, Aug 15.",
      mode: "mutation",
    }),
    null,
  );
});

test("internal narration and generic assistant closers are rejected systematically", () => {
  assert.match(
    validateConversationalEconomy({
      text: "I found two stored records. Would you like me to help planning?",
      mode: "answer",
    }) ?? "",
    /narrating storage|generic offer/i,
  );
});

test("answers lead with the answer instead of a formal preamble", () => {
  assert.match(
    validateConversationalEconomy({
      text: "Based on what I found, Project 1 is due Monday.",
      mode: "answer",
    }) ?? "",
    /lead with the answer/i,
  );
  assert.equal(
    validateConversationalEconomy({ text: "Project 1 is due Monday.", mode: "answer" }),
    null,
  );
});

test("planning needs a judgment rather than an inventory", () => {
  assert.match(
    validateConversationalEconomy({
      text: "Quiz Friday. Project Monday.",
      mode: "plan",
    }) ?? "",
    /recommendation/i,
  );
  assert.equal(
    validateConversationalEconomy({
      text: "I’d finish the quiz first, then give the project the weekend.",
      mode: "plan",
    }),
    null,
  );
});

test("quiet tone rejects hype, performative sign-offs, and invented countdowns", () => {
  for (const text of [
    "Start with the quiz, then crush it!",
    "Start with the quiz. Hit Juniper if you need focus. That’s your week.",
    "Start with the quiz — it’s only 3 days away.",
  ]) {
    assert.ok(validateConversationalEconomy({ text, mode: "plan" }));
  }
  assert.equal(
    validateConversationalEconomy({
      text: "I’d finish the quiz first, then use Juniper for the project session.",
      mode: "plan",
    }),
    null,
  );
});

test("answers and plans use memory without announcing it or exposing ISO dates", () => {
  assert.match(
    validateConversationalEconomy({
      text: "Juniper is saved if you need a place to work.",
      mode: "plan",
    }) ?? "",
    /do not announce/i,
  );
  assert.match(
    validateConversationalEconomy({ text: "Project 1 is due 2026-08-17.", mode: "answer" }) ?? "",
    /naturally/i,
  );
  assert.equal(
    validateConversationalEconomy({ text: "Project 1 is due Mon, Aug 17.", mode: "answer" }),
    null,
  );
});

test("questions appear only when clarification is required", () => {
  assert.match(
    validateConversationalEconomy({
      text: "Project 1 is due Monday. Want anything else?",
      mode: "answer",
    }) ?? "",
    /generic offer|question/i,
  );
  assert.equal(
    validateConversationalEconomy({
      text: "Juniper or Common Grounds — which one do you mean?",
      mode: "clarify",
      clarificationRequired: true,
    }),
    null,
  );
});

test("multi-turn answers cannot repeat a sentence the user just saw", () => {
  assert.match(
    validateConversationalEconomy({
      text: "Reading quiz is due Friday. Project 1 is due Monday.",
      mode: "answer",
      recentAssistantText: "Reading quiz is due Friday.",
    }) ?? "",
    /repeat/i,
  );
});

test("tool fallback uses the concrete action confirmation instead of recapping context", () => {
  assert.equal(
    confirmationFallback({
      completedTools: [{
        name: "save_note",
        result: JSON.stringify({
          ok: true,
          confirmation: "Done — club meeting added for Sat, Aug 15.",
        }),
      }],
    }),
    "Done — club meeting added for Sat, Aug 15.",
  );
});
