const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const { routes, bus } = require("../lib/routes");
const webhook = require("../lib/webhook");

const [verify, receive] = routes;
const CFG = { phone_number_id: "1234567890", verify_token: "vt-1", app_secret: "s3cret" };

const withCfg = async (cfg, fn) => {
  const { getState } = require("@saltcorn/data/db/state");
  const cfgs = getState().plugin_cfgs;
  cfgs["@saltcorn/whatsapp"] = cfg;
  try {
    return await fn();
  } finally {
    delete cfgs["@saltcorn/whatsapp"];
  }
};

/** Just enough of an Express response to see what was sent. */
const fakeRes = () => {
  const res = { statusCode: null, body: null, contentType: null };
  res.status = (c) => ((res.statusCode = c), res);
  res.type = (t) => ((res.contentType = t), res);
  res.send = (b) => ((res.body = b), res);
  return res;
};

const post = (json, secret = "s3cret", sigOverride) => {
  const rawBody = Buffer.from(JSON.stringify(json));
  const sig =
    sigOverride ?? "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return { body: json, rawBody, get: (h) => (h.toLowerCase() === "x-hub-signature-256" ? sig : undefined) };
};

const INCOMING = {
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          field: "messages",
          value: {
            metadata: { phone_number_id: "1234567890" },
            messages: [{ from: "1", id: "r1", timestamp: "1", type: "text", text: { body: "hi" } }],
          },
        },
      ],
    },
  ],
};

const capture = async (fn) => {
  const real = bus.emit;
  const events = [];
  bus.emit = (type, channel, payload) => events.push({ type, channel, payload });
  try {
    await fn();
  } finally {
    bus.emit = real;
  }
  return events;
};

test("routes are registered without CSRF, which Meta cannot send", () => {
  assert.equal(verify.url, "/whatsapp/webhook");
  assert.equal(verify.method, "get");
  assert.equal(receive.method, "post");
  assert.ok(verify.noCsrf && receive.noCsrf);
});

test("verification echoes the challenge when the token matches", async () => {
  await withCfg(CFG, async () => {
    const res = fakeRes();
    await verify.callback(
      { query: { "hub.mode": "subscribe", "hub.verify_token": "vt-1", "hub.challenge": "12345" } },
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "12345");
    assert.equal(res.contentType, "text/plain");
  });
});

test("verification is refused with the wrong token, or none configured", async () => {
  for (const cfg of [CFG, { ...CFG, verify_token: "" }]) {
    await withCfg(cfg, async () => {
      const res = fakeRes();
      await verify.callback(
        { query: { "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "1" } },
        res,
      );
      assert.equal(res.statusCode, 403);
    });
  }
});

test("a signed notification is answered 200 and fires its events", async () => {
  webhook.forgetSeen();
  await withCfg(CFG, async () => {
    const res = fakeRes();
    const events = await capture(() => receive.callback(post(INCOMING), res));
    assert.equal(res.statusCode, 200);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "WhatsAppMessage");
  });
});

test("a notification with a bad signature is refused and fires nothing", async () => {
  webhook.forgetSeen();
  await withCfg(CFG, async () => {
    for (const req of [post(INCOMING, "not-the-secret"), post(INCOMING, "s3cret", "")]) {
      const res = fakeRes();
      const events = await capture(() => receive.callback(req, res));
      assert.equal(res.statusCode, 403);
      assert.equal(events.length, 0);
    }
  });
});

test("without an app secret every notification is refused", async () => {
  webhook.forgetSeen();
  await withCfg({ ...CFG, app_secret: "" }, async () => {
    const res = fakeRes();
    const events = await capture(() => receive.callback(post(INCOMING, ""), res));
    assert.equal(res.statusCode, 403);
    assert.equal(events.length, 0);
  });
});
