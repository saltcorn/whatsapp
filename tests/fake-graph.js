/**
 * A small in-memory Cloud API, served through an injected fetch.
 *
 * Only /messages and /media are modelled. A test can queue error responses
 * with `failures`; each call takes the next one until they run out.
 */

const CFG = {
  access_token: "tok",
  phone_number_id: "1234567890",
  api_version: "v23.0",
};

const reply = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => (body === undefined ? "" : JSON.stringify(body)),
  arrayBuffer: async () => new TextEncoder().encode(body === undefined ? "" : String(body)).buffer,
});

/** A Graph error response, as Meta shapes it. */
const graphError = (status, code, message, extra = {}) =>
  reply(status, { error: { message, type: "OAuthException", code, fbtrace_id: "TR1", ...extra } }, extra.headers);

/**
 * @param {object} [state]
 * @param {object[]} [state.failures] - responses to give before succeeding
 */
const fakeGraph = (state = {}) => {
  const calls = [];
  const failures = [...(state.failures || [])];
  let n = 0;

  const impl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname === "lookaside.example") {
      calls.push({ path: "download", url, headers: init.headers });
      return reply(200, "MEDIA BYTES");
    }
    const [, version, phoneId, ...rest] = u.pathname.split("/");
    const path = `/${rest.join("/")}`;
    let body = init.body;
    if (body instanceof FormData) body = Object.fromEntries(body.entries());
    else
      try {
        body = JSON.parse(init.body);
      } catch (e) {}
    calls.push({ path, version, phoneId, method: init.method, headers: init.headers, body, url });

    if (failures.length) return failures.shift();
    if (path === "/messages") {
      n += 1;
      return reply(200, {
        messaging_product: "whatsapp",
        contacts: [{ input: body.to, wa_id: body.to }],
        messages: [{ id: `wamid.${n}` }],
      });
    }
    if (path === "/media") return reply(200, { id: "media-1" });
    if (path === "/" && init.method === "GET")
      return reply(200, {
        id: phoneId,
        url: `https://lookaside.example/whatsapp_business/attachments/?mid=${phoneId}`,
        mime_type: state.mime_type || "image/jpeg",
      });
    throw new Error(`fake-graph: no route for ${init.method} ${path}`);
  };
  impl.calls = calls;
  impl.to = (p) => calls.filter((c) => c.path === p);
  return impl;
};

/**
 * Run `fn` against a fake Cloud API, with the plugin configured.
 *
 * The actions call the API without a fetch parameter - they run inside
 * Saltcorn, not tests - so the global is swapped for the duration, and the
 * configuration is installed where liveCfg reads it.
 *
 * @param {object} state - see fakeGraph
 * @param {Function} fn - async ({ fake, cfg }) => *
 * @param {object} [cfgPatch] - overrides on CFG
 */
const withGraph = async (state, fn, cfgPatch = {}) => {
  const { getState } = require("@saltcorn/data/db/state");
  const cfgs = getState().plugin_cfgs;
  const cfg = { ...CFG, ...cfgPatch };
  cfgs["@saltcorn/whatsapp"] = cfg;
  const fake = fakeGraph(state);
  const realFetch = global.fetch;
  global.fetch = fake;
  try {
    return await fn({ fake, cfg });
  } finally {
    global.fetch = realFetch;
    delete cfgs["@saltcorn/whatsapp"];
  }
};

module.exports = { CFG, reply, graphError, fakeGraph, withGraph };
