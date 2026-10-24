const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const Table = require("@saltcorn/data/models/table");
const webhook = require("../lib/webhook");

const PNID = "1234567890";

/** A webhook body as Meta sends it, around one `value`. */
const body = (value, pnid = PNID) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "waba-1",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "15550000000", phone_number_id: pnid },
            ...value,
          },
        },
      ],
    },
  ],
});

const textMessage = (id = "wamid.in1") => ({
  contacts: [{ wa_id: "14155550100", profile: { name: "Ana" } }],
  messages: [
    { from: "14155550100", id, timestamp: "1792438895", type: "text", text: { body: "Hello" } },
  ],
});

const failedStatus = {
  statuses: [
    {
      id: "wamid.out1",
      status: "failed",
      timestamp: "1792438895",
      recipient_id: "14155550100",
      errors: [
        {
          code: 131031,
          title: "Business Account locked",
          message: "Business Account locked",
          error_data: { details: "Business account has been locked." },
        },
      ],
    },
  ],
};

const collect = () => {
  const events = [];
  const emit = (type, channel, payload) => events.push({ type, channel, payload });
  return { events, emit };
};

test("the signature is checked against the raw body and app secret", () => {
  const raw = Buffer.from('{"a":1}');
  const sig = "sha256=" + crypto.createHmac("sha256", "s3cret").update(raw).digest("hex");
  assert.equal(webhook.validSignature(raw, sig, "s3cret"), true);
  assert.equal(webhook.validSignature(raw, sig, "other"), false);
  assert.equal(webhook.validSignature(Buffer.from('{"a":2}'), sig, "s3cret"), false);
  assert.equal(webhook.validSignature(raw, "sha256=zz", "s3cret"), false);
  assert.equal(webhook.validSignature(raw, undefined, "s3cret"), false);
  assert.equal(webhook.validSignature(undefined, sig, "s3cret"), false);
});

test("an incoming text fires WhatsAppMessage on its type's channel", async () => {
  webhook.forgetSeen();
  const { events, emit } = collect();
  await webhook.handle(body(textMessage()), { phone_number_id: PNID }, emit);
  assert.equal(events.length, 1);
  const [e] = events;
  assert.equal(e.type, "WhatsAppMessage");
  assert.equal(e.channel, "text");
  const { raw, ...p } = e.payload;
  assert.deepEqual(p, {
    id: "wamid.in1",
    from: "14155550100",
    name: "Ana",
    type: "text",
    text: "Hello",
    reply_id: null,
    timestamp: new Date(1792438895000),
    media_id: null,
    mime_type: null,
    filename: null,
    latitude: null,
    longitude: null,
    context_id: null,
    phone_number_id: PNID,
  });
});

test("media, button and reaction messages carry what triggers need", async () => {
  webhook.forgetSeen();
  const { events, emit } = collect();
  await webhook.handle(
    body({
      contacts: [{ wa_id: "14155550100", profile: { name: "Ana" } }],
      messages: [
        {
          from: "14155550100", id: "w1", timestamp: "1", type: "document",
          document: { id: "media-9", mime_type: "application/pdf", filename: "a.pdf", caption: "Invoice" },
        },
        {
          from: "14155550100", id: "w2", timestamp: "1", type: "button",
          button: { text: "Yes", payload: "confirm" }, context: { id: "wamid.out1" },
        },
        {
          from: "14155550100", id: "w3", timestamp: "1", type: "reaction",
          reaction: { message_id: "wamid.out2", emoji: "👍" },
        },
      ],
    }),
    { phone_number_id: PNID },
    emit,
  );
  const [doc, btn, react] = events.map((e) => e.payload);
  assert.equal(doc.media_id, "media-9");
  assert.equal(doc.filename, "a.pdf");
  assert.equal(doc.text, "Invoice");
  assert.equal(btn.text, "Yes");
  assert.equal(btn.reply_id, "confirm");
  assert.equal(btn.context_id, "wamid.out1");
  assert.equal(react.text, "👍");
  assert.equal(react.context_id, "wamid.out2");
});

test("a failed status fires WhatsAppStatus on the failed channel, with the error", async () => {
  webhook.forgetSeen();
  const { events, emit } = collect();
  await webhook.handle(body(failedStatus), { phone_number_id: PNID }, emit);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "WhatsAppStatus");
  assert.equal(events[0].channel, "failed");
  const { raw, timestamp, ...p } = events[0].payload;
  assert.deepEqual(p, {
    id: "wamid.out1",
    status: "failed",
    recipient: "14155550100",
    error_code: 131031,
    error_title: "Business Account locked",
    error_message: "Business Account locked",
    error_details: "Business account has been locked.",
    phone_number_id: PNID,
  });
});

test("entries for another phone number are ignored", async () => {
  webhook.forgetSeen();
  const { events, emit } = collect();
  await webhook.handle(body(textMessage(), "999"), { phone_number_id: PNID }, emit);
  assert.equal(events.length, 0);
});

test("a webhook Meta delivers twice fires once", async () => {
  webhook.forgetSeen();
  const { events, emit } = collect();
  const cfg = { phone_number_id: PNID };
  await webhook.handle(body(textMessage("dup")), cfg, emit);
  await webhook.handle(body(textMessage("dup")), cfg, emit);
  assert.equal(events.length, 1);
});

/** A table of sent messages, as writeStatus sees it. */
const withStatusTable = async (rows, fn) => {
  const real = Table.findOne;
  const updates = [];
  Table.findOne = () => ({
    pk_name: "id",
    getRow: async (where) => rows.find((r) => r.wamid === where.wamid) || null,
    updateRow: async (patch, id) => {
      updates.push({ patch, id });
      Object.assign(rows.find((r) => r.id === id), patch);
    },
  });
  try {
    return await fn(updates);
  } finally {
    Table.findOne = real;
  }
};

const STATUS_CFG = {
  phone_number_id: PNID,
  status_table: "messages",
  status_id_field: "wamid",
  status_field: "status",
  status_error_field: "error",
};

const status = (id, s) => ({ statuses: [{ id, status: s, timestamp: "1", recipient_id: "1" }] });

test("statuses are written to the row with the message ID, and only move forward", async () => {
  webhook.forgetSeen();
  const rows = [{ id: 1, wamid: "wamid.a", status: null }];
  await withStatusTable(rows, async (updates) => {
    const { emit } = collect();
    await webhook.handle(body(status("wamid.a", "read")), STATUS_CFG, emit);
    // arrives late, after read
    await webhook.handle(body(status("wamid.a", "delivered")), STATUS_CFG, emit);
    assert.equal(rows[0].status, "read");
    assert.equal(updates.length, 1);
  });
});

test("a failure records its reason", async () => {
  webhook.forgetSeen();
  const rows = [{ id: 1, wamid: "wamid.out1", status: "sent" }];
  await withStatusTable(rows, async () => {
    await webhook.handle(body(failedStatus), STATUS_CFG, collect().emit);
    assert.equal(rows[0].status, "failed");
    assert.equal(rows[0].error, "131031: Business Account locked: Business account has been locked.");
  });
});

test("the event still fires when the status cannot be written", async () => {
  webhook.forgetSeen();
  const real = Table.findOne;
  Table.findOne = () => ({ getRow: async () => { throw new Error("no such column"); } });
  try {
    const { events, emit } = collect();
    const warnings = [];
    await webhook.handle(body(status("wamid.b", "sent")), STATUS_CFG, emit, (w) => warnings.push(w));
    assert.equal(events.length, 1);
    assert.match(warnings[0], /no such column/);
  } finally {
    Table.findOne = real;
  }
});

test("without a status table, nothing is written", async () => {
  assert.equal(await webhook.writeStatus({}, { id: "x", status: "sent" }), false);
});

test("what was skipped, and why, is reported for the log", async () => {
  webhook.forgetSeen();
  const cfg = { phone_number_id: PNID };
  const { emit } = collect();
  const other = await webhook.handle(body(textMessage("o1"), "123456123"), cfg, emit);
  assert.equal(
    webhook.summarise(other),
    "fired 0 WhatsAppMessage and 0 WhatsAppStatus, ignored phone number ID 123456123, not the configured 1234567890",
  );
  await webhook.handle(body(textMessage("d1")), cfg, emit);
  const again = await webhook.handle(body(textMessage("d1")), cfg, emit);
  assert.equal(webhook.summarise(again), "fired 0 WhatsAppMessage and 0 WhatsAppStatus, skipped 1 already seen");
  const notWa = await webhook.handle({ object: "page" }, cfg, emit);
  assert.match(webhook.summarise(notWa), /not a WhatsApp notification \(object: page\)/);
});
