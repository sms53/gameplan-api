"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../api/chat.js");

const TEST_SECRET = "unit-test-secret-not-for-deployment";

function preserveEnvironment(t, names) {
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

function makeResponse() {
  return {
    headers: {},
    statusCode: 200,
    body: undefined,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    }
  };
}

function validBody() {
  return { messages: [{ role: "user", content: "Synthetic Game Plan test prompt" }] };
}

async function invoke({ method = "POST", headers = {}, body = validBody() } = {}) {
  const response = makeResponse();
  await handler({ method, headers, body }, response);
  return response;
}

function authorizedHeaders(extra = {}) {
  return {
    "x-gameplan-internal-key": TEST_SECRET,
    "content-type": "application/json",
    ...extra
  };
}

test("rejects non-POST requests before provider access and emits no CORS header", async (t) => {
  preserveEnvironment(t, ["GAMEPLAN_INTERNAL_API_SECRET"]);
  process.env.GAMEPLAN_INTERNAL_API_SECRET = TEST_SECRET;
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls += 1; throw new Error("provider must not be called"); };
  t.after(() => { global.fetch = originalFetch; });

  const response = await invoke({ method: "GET", headers: {} });
  const options = await invoke({ method: "OPTIONS", headers: {} });
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.allow, "POST");
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  assert.equal(options.statusCode, 405);
  assert.equal(options.headers["access-control-allow-origin"], undefined);
  assert.equal(fetchCalls, 0);
});

test("fails closed when the server secret is missing", async (t) => {
  preserveEnvironment(t, ["GAMEPLAN_INTERNAL_API_SECRET"]);
  delete process.env.GAMEPLAN_INTERNAL_API_SECRET;
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls += 1; throw new Error("provider must not be called"); };
  t.after(() => { global.fetch = originalFetch; });

  const response = await invoke({ headers: authorizedHeaders() });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, { error: "Service unavailable" });
  assert.equal(fetchCalls, 0);
});

test("fails closed when the Anthropic key is missing", async (t) => {
  preserveEnvironment(t, ["GAMEPLAN_INTERNAL_API_SECRET", "ANTHROPIC_API_KEY"]);
  process.env.GAMEPLAN_INTERNAL_API_SECRET = TEST_SECRET;
  delete process.env.ANTHROPIC_API_KEY;
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls += 1; throw new Error("provider must not be called"); };
  t.after(() => { global.fetch = originalFetch; });

  const response = await invoke({ headers: authorizedHeaders() });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, { error: "Service unavailable" });
  assert.equal(fetchCalls, 0);
});

test("rejects missing and incorrect internal keys without provider access", async (t) => {
  preserveEnvironment(t, ["GAMEPLAN_INTERNAL_API_SECRET"]);
  process.env.GAMEPLAN_INTERNAL_API_SECRET = TEST_SECRET;
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls += 1; throw new Error("provider must not be called"); };
  t.after(() => { global.fetch = originalFetch; });

  const missing = await invoke({ headers: { "content-type": "application/json" } });
  const incorrect = await invoke({ headers: authorizedHeaders({ "x-gameplan-internal-key": "wrong" }) });
  assert.equal(missing.statusCode, 401);
  assert.equal(incorrect.statusCode, 401);
  assert.equal(fetchCalls, 0);
});

test("rejects a non-JSON content type before provider access", async (t) => {
  preserveEnvironment(t, ["GAMEPLAN_INTERNAL_API_SECRET"]);
  process.env.GAMEPLAN_INTERNAL_API_SECRET = TEST_SECRET;
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls += 1; throw new Error("provider must not be called"); };
  t.after(() => { global.fetch = originalFetch; });

  const response = await invoke({ headers: authorizedHeaders({ "content-type": "text/plain" }) });
  assert.equal(response.statusCode, 415);
  assert.equal(fetchCalls, 0);
});

test("rejects malformed JSON, unexpected fields, and invalid messages", async (t) => {
  preserveEnvironment(t, ["GAMEPLAN_INTERNAL_API_SECRET"]);
  process.env.GAMEPLAN_INTERNAL_API_SECRET = TEST_SECRET;
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls += 1; throw new Error("provider must not be called"); };
  t.after(() => { global.fetch = originalFetch; });

  const malformed = await invoke({ headers: authorizedHeaders(), body: null });
  const extraField = await invoke({ headers: authorizedHeaders(), body: { ...validBody(), model: "attacker-model" } });
  const invalidMessage = await invoke({ headers: authorizedHeaders(), body: { messages: [{ role: "system", content: "no" }] } });
  assert.equal(malformed.statusCode, 400);
  assert.equal(extraField.statusCode, 400);
  assert.equal(invalidMessage.statusCode, 400);
  assert.equal(fetchCalls, 0);
});

test("rejects oversized requests and prompts before provider access", async (t) => {
  preserveEnvironment(t, ["GAMEPLAN_INTERNAL_API_SECRET"]);
  process.env.GAMEPLAN_INTERNAL_API_SECRET = TEST_SECRET;
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls += 1; throw new Error("provider must not be called"); };
  t.after(() => { global.fetch = originalFetch; });

  const oversizedBody = await invoke({ headers: authorizedHeaders({ "content-length": String(32 * 1024 + 1) }) });
  const oversizedPrompt = await invoke({ headers: authorizedHeaders(), body: { messages: [{ role: "user", content: "x".repeat(24 * 1024 + 1) }] } });
  assert.equal(oversizedBody.statusCode, 413);
  assert.equal(oversizedPrompt.statusCode, 400);
  assert.equal(fetchCalls, 0);
});

test("uses server-owned model and token limit for one authenticated user prompt", async (t) => {
  preserveEnvironment(t, ["GAMEPLAN_INTERNAL_API_SECRET", "ANTHROPIC_API_KEY"]);
  process.env.GAMEPLAN_INTERNAL_API_SECRET = TEST_SECRET;
  process.env.ANTHROPIC_API_KEY = "unit-test-provider-key-not-real";
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async (url, options) => {
    fetchCalls += 1;
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    const sent = JSON.parse(options.body);
    assert.deepEqual(Object.keys(sent).sort(), ["max_tokens", "messages", "model"]);
    assert.equal(sent.model, "claude-sonnet-4-6");
    assert.equal(sent.max_tokens, 1200);
    assert.deepEqual(sent.messages, [{ role: "user", content: "Synthetic Game Plan test prompt" }]);
    return new Response(JSON.stringify({
      id: "provider-id-not-forwarded",
      usage: { input_tokens: 4 },
      content: [{ type: "text", text: "Synthetic generated Game Plan" }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => { global.fetch = originalFetch; });

  const response = await invoke({ headers: authorizedHeaders() });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { content: [{ type: "text", text: "Synthetic generated Game Plan" }] });
  assert.equal(fetchCalls, 1);
});

test("sanitizes provider failures without exposing provider details", async (t) => {
  preserveEnvironment(t, ["GAMEPLAN_INTERNAL_API_SECRET", "ANTHROPIC_API_KEY"]);
  process.env.GAMEPLAN_INTERNAL_API_SECRET = TEST_SECRET;
  process.env.ANTHROPIC_API_KEY = "unit-test-provider-key-not-real";
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ error: { message: "private provider diagnostic" } }), { status: 429 });
  t.after(() => { global.fetch = originalFetch; });

  const response = await invoke({ headers: authorizedHeaders() });
  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.body, { error: "Generation unavailable" });
  assert.equal(JSON.stringify(response.body).includes("private provider diagnostic"), false);
});

test("rejects an oversized provider response and returns no provider details", async (t) => {
  preserveEnvironment(t, ["GAMEPLAN_INTERNAL_API_SECRET", "ANTHROPIC_API_KEY"]);
  process.env.GAMEPLAN_INTERNAL_API_SECRET = TEST_SECRET;
  process.env.ANTHROPIC_API_KEY = "unit-test-provider-key-not-real";
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ content: [
    { type: "text", text: "x".repeat(65 * 1024) }
  ] }), { status: 200 });
  t.after(() => { global.fetch = originalFetch; });

  const response = await invoke({ headers: authorizedHeaders() });
  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.body, { error: "Generation unavailable" });
});
