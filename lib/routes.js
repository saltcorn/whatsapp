const crypto = require("crypto");
const Trigger = require("@saltcorn/data/models/trigger");
const { getState } = require("@saltcorn/data/db/state");
const webhook = require("./webhook");
const { liveCfg, WEBHOOK_PATH } = require("./config");

/** Swapped out in tests, so events can be seen without a database. */
const bus = {
  emit: (eventType, channel, payload) =>
    Trigger.emitEvent(eventType, channel || null, {}, payload),
};

const log = (msg) => {
  try {
    getState().log(2, `whatsapp webhook: ${msg}`);
  } catch (e) {}
};

/** Who sent a request, so the log shows whether it was Meta. */
const caller = (req) => {
  const ua = (req.get && req.get("user-agent")) || "unknown client";
  const ip = req.ip || (req.headers && req.headers["x-forwarded-for"]) || "unknown address";
  return `${ip}, ${ua}`;
};

/** Compare without leaking, through timing, how much of the token matched. */
const sameToken = (a, b) => {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

/**
 * Meta's subscription check: it sends the verify token you gave it, and
 * expects the challenge echoed back as plain text.
 */
const verify = {
  url: WEBHOOK_PATH,
  method: "get",
  noCsrf: true,
  callback: async (req, res) => {
    const q = req.query || {};
    const expected = liveCfg().verify_token;
    log(`verification request from ${caller(req)}`);
    if (
      q["hub.mode"] === "subscribe" &&
      expected &&
      q["hub.verify_token"] &&
      sameToken(q["hub.verify_token"], expected)
    ) {
      log("verification accepted");
      res.type("text/plain").status(200).send(String(q["hub.challenge"] || ""));
      return;
    }
    log(
      q["hub.mode"] !== "subscribe"
        ? `verification refused: hub.mode is "${q["hub.mode"] || ""}", not "subscribe"`
        : expected
          ? "verification refused: the verify token does not match"
          : "verification refused: no verify token is saved in the plugin configuration",
    );
    res.status(403).send("Forbidden");
  },
};

/**
 * Notifications from Meta. Registered with noCsrf because Meta has no
 * Saltcorn CSRF token to send; the signature takes its place.
 *
 * Answers 200 before firing the events. Meta waits only a few seconds, and
 * retries anything slower - which would fire the same events again.
 */
const receive = {
  url: WEBHOOK_PATH,
  method: "post",
  noCsrf: true,
  callback: async (req, res) => {
    const cfg = liveCfg();
    log(`notification from ${caller(req)}`);
    if (!cfg.app_secret) {
      log("request refused: no app secret is configured");
      res.status(403).send("Forbidden");
      return;
    }
    const signature = req.get("x-hub-signature-256");
    if (!webhook.validSignature(req.rawBody, signature, cfg.app_secret)) {
      log(
        !signature
          ? "request refused: no X-Hub-Signature-256 header, so it is not from Meta"
          : !req.rawBody
            ? "request refused: the body was not JSON, so its signature cannot be checked"
            : "request refused: the signature does not match the app secret",
      );
      res.status(403).send("Forbidden");
      return;
    }
    res.status(200).send("OK");
    try {
      log(webhook.summarise(await webhook.handle(req.body, cfg, bus.emit, log)));
    } catch (e) {
      log(e.message);
    }
  },
};

module.exports = { routes: [verify, receive], bus };
