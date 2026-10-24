const test = require("node:test");
const assert = require("node:assert");
const { graphFetch, describeError } = require("../lib/api");
const { CFG, fakeGraph, graphError } = require("./fake-graph");

const call = (fake, cfg = CFG) =>
  graphFetch("/messages", { cfg, fetchImpl: fake, body: { to: "1" } });

test("calls the phone number's endpoint with the token", async () => {
  const fake = fakeGraph();
  await call(fake);
  const [c] = fake.calls;
  assert.equal(c.url, "https://graph.facebook.com/v23.0/1234567890/messages");
  assert.equal(c.headers.Authorization, "Bearer tok");
  assert.equal(c.headers["Content-Type"], "application/json");
});

test("uses the default API version when none is set", async () => {
  const fake = fakeGraph();
  await call(fake, { ...CFG, api_version: "" });
  assert.equal(fake.calls[0].version, "v23.0");
});

test("refuses to call without credentials", async () => {
  const fake = fakeGraph();
  await assert.rejects(call(fake, { access_token: "tok" }), /not configured/);
  assert.equal(fake.calls.length, 0);
});

test("an expired token says how to get a permanent one", async () => {
  const fake = fakeGraph({
    failures: [graphError(401, 190, "Error validating access token")],
  });
  const err = await call(fake).catch((e) => e);
  assert.equal(err.code, 190);
  assert.match(err.message, /Error validating access token/);
  assert.match(err.message, /System User token/);
  assert.equal(fake.calls.length, 1, "a bad token is not retried");
});

test("a throughput limit is retried", async () => {
  const fake = fakeGraph({
    failures: [graphError(400, 130429, "Rate limit hit", { headers: { "retry-after": "0" } })],
  });
  const res = await call(fake);
  assert.equal(res.messages[0].id, "wamid.1");
  assert.equal(fake.calls.length, 2);
});

test("error_data.details is included, since message is often generic", () => {
  const msg = describeError(
    400,
    { error: { message: "(#132001) Template name does not exist in the translation", code: 132001, error_data: { details: "template name (hello) does not exist in en" } } },
    "/messages",
  );
  assert.match(msg, /does not exist in en/);
  assert.match(msg, /en_US is not en/);
});

test("webhook base URLs Meta cannot call are explained", () => {
  const { callbackProblem } = require("../lib/config");
  assert.equal(callbackProblem("https://example.com"), null);
  assert.equal(callbackProblem("https://abc.ngrok-free.app/"), null);
  assert.match(callbackProblem(""), /placeholder/);
  assert.match(callbackProblem("http://localhost:3000"), /cannot reach localhost/);
  assert.match(callbackProblem("https://127.0.0.1"), /cannot reach 127\.0\.0\.1/);
  assert.match(callbackProblem("http://192.168.1.20:3000"), /cannot reach/);
  assert.match(callbackProblem("http://example.com"), /only calls HTTPS/);
  assert.match(callbackProblem("not a url"), /not a valid URL/);
});
