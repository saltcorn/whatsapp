const { GRAPH_BASE, liveCfg, credentials } = require("./config");

/** HTTP statuses worth trying again. */
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
/**
 * Graph error codes that mean "too fast, try again shortly": 4 is the app's
 * call limit, 80007 the WhatsApp Business Account's, 130429 the phone
 * number's messages-per-second throughput.
 */
const RETRY_CODES = new Set([4, 80007, 130429]);
const MAX_ATTEMPTS = 4;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with jitter, honouring Retry-After when Meta sets it. */
const backoffMs = (attempt, res) => {
  const header = res && res.headers && res.headers.get("retry-after");
  if (header) {
    const secs = parseInt(header, 10);
    if (!isNaN(secs)) return secs * 1000;
  }
  return Math.min(2 ** attempt * 500, 8000) + Math.floor(Math.random() * 250);
};

/**
 * What to do about each error code a send commonly meets. Meta's own message
 * says what went wrong; these say what to change.
 */
const ADVICE = {
  190:
    "The access token is invalid or has expired. A token from the API Setup " +
    "page lasts 24 hours; create a permanent System User token in Business " +
    "Settings and paste it into the plugin configuration.",
  10:
    "The access token lacks the whatsapp_business_messaging permission, or " +
    "was not given access to this WhatsApp Business Account.",
  200:
    "The access token lacks the whatsapp_business_messaging permission, or " +
    "was not given access to this WhatsApp Business Account.",
  100:
    "Meta rejected a parameter. Check the phone number ID in the plugin " +
    "configuration, and the template name and language if this was a " +
    "template.",
  131030:
    "The recipient is not on the test number's allowed list. Add it under " +
    "API Setup, or send from a registered business number.",
  131047:
    "More than 24 hours have passed since the recipient last messaged you. " +
    "Only an approved template can be sent outside that window.",
  131026:
    "The message could not be delivered. The number may not be on WhatsApp, " +
    "or the recipient has not accepted the latest terms.",
  131008: "A required part of the message is missing.",
  131009:
    "A value in the message is not valid - often a media link Meta cannot " +
    "download, or a file type WhatsApp does not accept.",
  131051: "WhatsApp does not support this message type.",
  131053:
    "Meta could not process the media. Check its type and size: images are " +
    "JPEG or PNG up to 5 MB, video and audio up to 16 MB, documents up to " +
    "100 MB.",
  131056:
    "Too many messages to this one recipient in a short time. Wait before " +
    "sending to them again.",
  132000:
    "The number of parameters does not match the placeholders in the " +
    "template.",
  132001:
    "No approved template has this name in this language. Check both " +
    "against WhatsApp Manager; language codes are exact (en_US is not en).",
  132005: "With its parameters filled in, the template text is too long.",
  132007: "The parameters break the template's format policy.",
  132012: "A parameter is in the wrong format for its placeholder.",
  133010:
    "The business phone number is not registered with the Cloud API. " +
    "Register it in WhatsApp Manager.",
  368:
    "The business account is temporarily blocked from sending for a policy " +
    "violation. See WhatsApp Manager.",
};

/**
 * Turn a Graph error body into a message that says what to fix.
 *
 * @param {number} status - HTTP status
 * @param {object} body - parsed response
 * @param {string} path - what was called, for the message
 * @returns {string}
 */
const describeError = (status, body, path) => {
  const err = (body && body.error) || {};
  const code = err.code;
  // Meta puts the specific reason in error_data.details; message is often
  // generic, e.g. "(#100) Invalid parameter"
  const details = err.error_data && err.error_data.details;
  const top = err.error_user_msg || err.message || `HTTP ${status}`;
  const detail = details && !top.includes(details) ? `${top}: ${details}` : top;
  const advice = ADVICE[err.error_subcode] || ADVICE[code];
  const ref = [code && `code ${code}`, err.fbtrace_id && `trace ${err.fbtrace_id}`]
    .filter(Boolean)
    .join(", ");
  return (
    `whatsapp: ${detail}${ref ? ` (${ref})` : ` (HTTP ${status})`} calling ` +
    `${path}.${advice ? ` ${advice}` : ""}`
  );
};

/**
 * One authenticated Graph API call, with retries on rate limits and outages.
 *
 * @param {string} path - below the node, e.g. "/messages"
 * @param {object} [opts]
 * @param {string} [opts.node] - the Graph node the path is under; default
 *   the configured phone number. A media id, to look media up
 * @param {string} [opts.method] - HTTP method, default POST
 * @param {object} [opts.body] - JSON request body
 * @param {Function} [opts.formData] - () => FormData, for uploads. A function
 *   because a FormData body cannot be sent twice, and a retry needs a fresh one
 * @param {object} [opts.cfg] - plugin configuration override, for tests
 * @param {Function} [opts.fetchImpl] - fetch override, for tests
 * @returns {Promise<object>} the parsed response
 */
const graphFetch = async (path, opts = {}) => {
  const { method = "POST", body, formData, node, cfg = liveCfg(), fetchImpl = fetch } = opts;
  const { token, phoneNumberId, version } = credentials(cfg);
  const url = `${GRAPH_BASE}/${version}/${encodeURIComponent(node || phoneNumberId)}${path}`;

  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        // FormData sets its own multipart content type, with the boundary
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(formData ? { body: formData() } : {}),
    });

    const text = await res.text();
    let json = {};
    if (text)
      try {
        json = JSON.parse(text);
      } catch (e) {
        json = {};
      }

    if (res.ok) return json;

    const code = json.error && json.error.code;
    lastErr = new Error(describeError(res.status, json, path));
    // callers branch on these rather than matching on the message text
    lastErr.status = res.status;
    lastErr.code = code;
    const retryable = RETRY_STATUS.has(res.status) || RETRY_CODES.has(code);
    if (!retryable || attempt === MAX_ATTEMPTS - 1) throw lastErr;
    await sleep(backoffMs(attempt, res));
  }
  throw lastErr;
};

module.exports = { graphFetch, describeError, RETRY_CODES };
