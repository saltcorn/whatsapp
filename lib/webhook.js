const crypto = require("crypto");
const Table = require("@saltcorn/data/models/table");

const MESSAGE_EVENT = "WhatsAppMessage";
const STATUS_EVENT = "WhatsAppStatus";

/**
 * Is this request from Meta? Meta signs the exact body bytes with the app
 * secret and sends `X-Hub-Signature-256: sha256=<hex>`. Re-serialising the
 * parsed JSON would not reproduce those bytes, so this needs the raw body.
 *
 * @param {Buffer} rawBody - the request body as received
 * @param {string} header - the X-Hub-Signature-256 value
 * @param {string} appSecret - from App settings → Basic
 * @returns {boolean}
 */
const validSignature = (rawBody, header, appSecret) => {
  if (!rawBody || !header || !appSecret) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(String(header).trim());
  if (!m) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(m[1], "hex"));
};

/** Meta sends Unix seconds as a string. */
const toDate = (ts) => (ts ? new Date(Number(ts) * 1000) : null);

/**
 * The readable part of a message, whatever its type: the text, a caption,
 * the label of a tapped button, or the emoji of a reaction.
 */
const textOf = (m) => {
  const body = m[m.type] || {};
  switch (m.type) {
    case "text":
      return body.body;
    case "button":
      return body.text;
    case "interactive": {
      const reply = body.button_reply || body.list_reply || {};
      return reply.title;
    }
    case "reaction":
      return body.emoji;
    case "location":
      return [body.name, body.address].filter(Boolean).join(", ") || null;
    default:
      return body.caption;
  }
};

/** What a button or list reply carries back, for matching it in code. */
const replyIdOf = (m) => {
  if (m.type === "button") return (m.button || {}).payload;
  if (m.type === "interactive") {
    const i = m.interactive || {};
    return (i.button_reply || i.list_reply || {}).id;
  }
  return undefined;
};

/**
 * One incoming message, flattened into the event payload.
 *
 * @param {object} m - an entry of value.messages
 * @param {object[]} contacts - value.contacts, for the sender's profile name
 * @param {string} phoneNumberId - the business number it arrived at
 */
const messagePayload = (m, contacts, phoneNumberId) => {
  const contact = (contacts || []).find((c) => c.wa_id === m.from) || (contacts || [])[0] || {};
  const media = ["image", "document", "audio", "video", "sticker"].includes(m.type)
    ? m[m.type] || {}
    : {};
  const location = m.type === "location" ? m.location || {} : {};
  return {
    id: m.id,
    from: m.from,
    name: (contact.profile || {}).name || null,
    type: m.type,
    text: textOf(m) ?? null,
    reply_id: replyIdOf(m) ?? null,
    timestamp: toDate(m.timestamp),
    media_id: media.id || null,
    mime_type: media.mime_type || null,
    filename: media.filename || null,
    latitude: location.latitude ?? null,
    longitude: location.longitude ?? null,
    // a reply quotes a message; a reaction points at the one it reacts to
    context_id:
      (m.context || {}).id || (m.type === "reaction" ? (m.reaction || {}).message_id : null) || null,
    phone_number_id: phoneNumberId,
    raw: m,
  };
};

/**
 * One status update on a message you sent, flattened into the event payload.
 *
 * @param {object} s - an entry of value.statuses
 * @param {string} phoneNumberId - the business number that sent it
 */
const statusPayload = (s, phoneNumberId) => {
  const err = (s.errors || [])[0] || {};
  return {
    id: s.id,
    status: s.status,
    recipient: s.recipient_id,
    timestamp: toDate(s.timestamp),
    error_code: err.code ?? null,
    error_title: err.title || null,
    error_message: err.message || null,
    error_details: (err.error_data || {}).details || null,
    phone_number_id: phoneNumberId,
    raw: s,
  };
};

/**
 * Pull the messages and statuses for one business number out of a webhook
 * body. A Meta app can serve several numbers; entries for the others are
 * left alone.
 *
 * @param {object} body - the parsed webhook body
 * @param {string} phoneNumberId - the configured number
 * @returns {{messages: object[], statuses: object[], ignored: string[]}}
 *   ignored says what was skipped and why, for the log
 */
const extract = (body, phoneNumberId) => {
  const messages = [];
  const statuses = [];
  const ignored = [];
  if (!body || body.object !== "whatsapp_business_account") {
    ignored.push(`not a WhatsApp notification (object: ${(body && body.object) || "none"})`);
    return { messages, statuses, ignored };
  }
  for (const entry of body.entry || [])
    for (const change of entry.changes || []) {
      if (change.field !== "messages") {
        ignored.push(`field "${change.field}", not subscribed to by this plugin`);
        continue;
      }
      const value = change.value || {};
      const pnid = String((value.metadata || {}).phone_number_id || "");
      if (phoneNumberId && pnid !== String(phoneNumberId)) {
        ignored.push(
          `phone number ID ${pnid || "(none)"}, not the configured ${phoneNumberId}`,
        );
        continue;
      }
      for (const m of value.messages || [])
        messages.push(messagePayload(m, value.contacts, pnid));
      for (const s of value.statuses || []) statuses.push(statusPayload(s, pnid));
    }
  return { messages, statuses, ignored };
};

/**
 * Meta delivers at least once, so the same webhook can arrive twice. The
 * last few thousand keys are remembered, per process: enough to absorb
 * Meta's retries, which come within minutes.
 */
const SEEN_MAX = 2000;
const seen = new Set();
const firstTime = (key) => {
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
  return true;
};
const forgetSeen = () => seen.clear();

/**
 * Statuses can arrive out of order - "read" before "delivered" is common -
 * so a later status never overwrites a further one. "failed" is final.
 */
const STATUS_RANK = { sent: 1, delivered: 2, read: 3, failed: 4 };

/**
 * Update the row that recorded this message's id, if the plugin is set up
 * to track delivery status.
 *
 * @param {object} cfg - plugin configuration
 * @param {object} status - a statusPayload
 * @returns {Promise<boolean>} whether a row was updated
 */
const writeStatus = async (cfg, status) => {
  const { status_table, status_id_field, status_field, status_error_field } = cfg;
  if (!status_table || !status_id_field || !status_field) return false;
  // the state cache, or the database when the cache is not loaded
  const table =
    Table.findOne({ name: status_table }) || (await Table.find({ name: status_table }))[0];
  if (!table) return false;
  const row = await table.getRow({ [status_id_field]: status.id });
  if (!row) return false;
  const current = STATUS_RANK[row[status_field]] || 0;
  const next = STATUS_RANK[status.status] || 0;
  if (next < current) return false;
  const patch = { [status_field]: status.status };
  if (status_error_field && status.status === "failed")
    patch[status_error_field] = [
      status.error_code && `${status.error_code}`,
      status.error_title,
      status.error_details,
    ]
      .filter(Boolean)
      .join(": ");
  await table.updateRow(patch, row[table.pk_name || "id"]);
  return true;
};

/**
 * Fire the events for one webhook body, and track delivery status.
 *
 * @param {object} body - parsed webhook body
 * @param {object} cfg - plugin configuration
 * @param {Function} emit - (eventType, channel, payload) => void
 * @param {Function} [warn] - (message) => void, for a status that could not
 *   be written back; its event still fires
 * @returns {Promise<{messages: number, statuses: number, duplicates: number,
 *   ignored: string[]}>} how many fired, and what was skipped
 */
const handle = async (body, cfg, emit, warn = () => {}) => {
  const { messages, statuses, ignored } = extract(body, cfg.phone_number_id);
  let nm = 0;
  let ns = 0;
  let duplicates = 0;
  for (const m of messages) {
    if (!firstTime(`m:${m.id}`)) {
      duplicates += 1;
      continue;
    }
    emit(MESSAGE_EVENT, m.type, m);
    nm += 1;
  }
  for (const s of statuses) {
    if (!firstTime(`s:${s.id}:${s.status}`)) {
      duplicates += 1;
      continue;
    }
    try {
      await writeStatus(cfg, s);
    } catch (e) {
      warn(`could not record status ${s.status} for ${s.id}: ${e.message}`);
    }
    emit(STATUS_EVENT, s.status, s);
    ns += 1;
  }
  return { messages: nm, statuses: ns, duplicates, ignored };
};

/** One line for the log: what a notification fired, and what it skipped. */
const summarise = ({ messages, statuses, duplicates, ignored }) => {
  const parts = [`fired ${messages} WhatsAppMessage and ${statuses} WhatsAppStatus`];
  if (duplicates) parts.push(`skipped ${duplicates} already seen`);
  if (ignored.length) parts.push(`ignored ${ignored.join("; ")}`);
  return parts.join(", ");
};

module.exports = {
  MESSAGE_EVENT,
  STATUS_EVENT,
  validSignature,
  extract,
  handle,
  summarise,
  writeStatus,
  forgetSeen,
};
