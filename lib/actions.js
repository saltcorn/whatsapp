const {
  get_async_expression_function,
} = require("@saltcorn/data/models/expression");
const File = require("@saltcorn/data/models/file");
const Role = require("@saltcorn/data/models/role");
const whatsapp = require("./whatsapp");
const phone = require("./phone");
const { liveCfg } = require("./config");

const NAMESPACE = "WhatsApp";

/** Cloud API limits, checked here so the error names the field to fix. */
const MAX_TEXT = 4096;
const MAX_CAPTION = 1024;

/**
 * Evaluate one of the action's JavaScript expressions against the row.
 *
 * Uses the same evaluator as the built-in row actions, so the bindings a user
 * already knows - the row's own fields, `user`, `$`-prefixed state - all work.
 *
 * @param {string} expr - the expression source
 * @param {object} ctx - { row, table, user }
 * @returns {Promise<*>} whatever the expression evaluates to
 */
const evalExpr = async (expr, { row, table, user }) => {
  if (!expr) return undefined;
  const fields =
    (table && table.fields) || Object.keys(row || {}).map((k) => ({ name: k }));
  const f = get_async_expression_function(expr, fields, { user, console });
  return await f(row || {}, user);
};

const codeField = (name, label, sublabel, table, extra = {}) => ({
  name,
  label,
  sublabel,
  input_type: "code",
  attributes: {
    mode: "application/javascript",
    compact: true,
    expression_type: "row",
    table: table && table.name,
    nojoins: true,
    user: true,
  },
  ...extra,
});

const resultVariable = (mode) =>
  mode === "workflow"
    ? [
        {
          name: "result_variable",
          label: "Result variable",
          sublabel: "Context variable to fill with { id, wa_id }",
          type: "String",
        },
      ]
    : [];

/** A table's fields of one type, as select options; empty outside a table. */
const fieldOptions = (table, pred) =>
  table && table.fields ? table.fields.filter(pred).map((f) => f.name) : [];

const isStringField = (f) => f.type && f.type.name === "String";

/** Optional: write the message id back to a column on the triggering row. */
const messageIdField = (table) => {
  const options = fieldOptions(table, isStringField);
  return options.length
    ? [
        {
          name: "message_id_field",
          label: "Save message ID to",
          sublabel:
            "Optional. Store the WhatsApp message ID (wamid) on the row, to " +
            "match delivery updates to it later.",
          type: "String",
          attributes: { options: ["", ...options] },
        },
      ]
    : [];
};

const writeBack = async (table, row, field, value) => {
  if (!field || !table || !row) return;
  const pk = table.pk_name || "id";
  if (row[pk] === undefined) return;
  await table.updateRow({ [field]: value }, row[pk]);
};

const toField = (table) =>
  codeField(
    "to_expr",
    "To",
    "Recipient phone number. Example: <code>phone</code> or " +
      "<code>'+14155550100'</code>. Numbers starting with 0 need a default " +
      "country code in the plugin configuration.",
    table,
    { required: true },
  );

const recipient = async (configuration, ctx) =>
  phone.normalise(
    await evalExpr(configuration.to_expr, ctx),
    liveCfg().default_country_code,
  );

/**
 * The action's return value, and the write-back every send shares.
 */
const finish = async (sent, { table, row, configuration }) => {
  await writeBack(table, row, configuration.message_id_field, sent.id);
  if (configuration.result_variable)
    return { [configuration.result_variable]: sent };
  // accepted, not delivered: delivery is only known later, from the webhook
  return { notify: `Message to +${sent.wa_id} accepted by WhatsApp` };
};

const textOf = (value, what, max) => {
  if (value === undefined || value === null || String(value) === "")
    throw new Error(`whatsapp: the ${what} expression produced no text.`);
  const s = String(value);
  if (s.length > max)
    throw new Error(
      `whatsapp: the ${what} is ${s.length} characters; WhatsApp allows ${max}.`,
    );
  return s;
};

/** Send free-form text. Only delivered inside the 24-hour customer window. */
const send_text = {
  description:
    "Send a WhatsApp text message. Only works within 24 hours of the " +
    "recipient's last message to you; use a template otherwise.",
  namespace: NAMESPACE,
  configFields: async ({ table, mode }) => [
    toField(table),
    codeField(
      "text_expr",
      "Text",
      "Example: <code>`Your order ${ref} has shipped`</code>. Up to 4096 " +
        "characters; WhatsApp formatting like *bold* and _italic_ works.",
      table,
      { required: true },
    ),
    {
      name: "preview_url",
      label: "Link preview",
      sublabel: "Show a preview of the first link in the text",
      type: "Bool",
    },
    ...messageIdField(table),
    ...resultVariable(mode),
  ],
  run: async ({ row, table, user, configuration }) => {
    const ctx = { row, table, user };
    const to = await recipient(configuration, ctx);
    const body = textOf(await evalExpr(configuration.text_expr, ctx), "text", MAX_TEXT);
    const sent = await whatsapp.sendMessage(to, "text", {
      body,
      preview_url: !!configuration.preview_url,
    });
    return await finish(sent, { table, row, configuration });
  },
};

/**
 * Template body parameters, from an array (positional, for {{1}}, {{2}}) or
 * an object (named, for {{name}}).
 */
const bodyParameters = (value) => {
  if (value === undefined || value === null) return [];
  const entries = Array.isArray(value)
    ? value.map((v, i) => [null, v, `{{${i + 1}}}`])
    : typeof value === "object"
      ? Object.entries(value).map(([k, v]) => [k, v, `{{${k}}}`])
      : null;
  if (!entries)
    throw new Error(
      "whatsapp: the parameters expression must give an array or an object.",
    );
  return entries.map(([name, v, label]) => {
    if (v === undefined || v === null || String(v) === "")
      throw new Error(
        `whatsapp: template parameter ${label} is empty. WhatsApp rejects ` +
          `empty parameters.`,
      );
    return { type: "text", ...(name ? { parameter_name: name } : {}), text: String(v) };
  });
};

/** Send an approved template. Works at any time. */
const send_template = {
  description:
    "Send an approved WhatsApp message template. Works at any time, " +
    "including to people who have never messaged you.",
  namespace: NAMESPACE,
  configFields: async ({ table, mode }) => [
    toField(table),
    {
      name: "template_name",
      label: "Template name",
      sublabel: "As shown in WhatsApp Manager, e.g. order_shipped",
      type: "String",
      required: true,
    },
    {
      name: "language",
      label: "Language",
      sublabel:
        "The template's language code, exactly as approved, e.g. en_US, en, fr",
      type: "String",
      required: true,
      default: "en_US",
    },
    codeField(
      "parameters_expr",
      "Body parameters",
      "Optional. An array for numbered placeholders, " +
        "<code>[name, ref]</code> fills {{1}} and {{2}}; an object for named " +
        "ones, <code>{customer: name}</code> fills {{customer}}.",
      table,
    ),
    codeField(
      "components_expr",
      "Components",
      "Optional, advanced. The full Cloud API <code>components</code> array, " +
        "for header, button or media parameters. Replaces Body parameters " +
        "when set.",
      table,
    ),
    ...messageIdField(table),
    ...resultVariable(mode),
  ],
  run: async ({ row, table, user, configuration }) => {
    const ctx = { row, table, user };
    const { template_name, language } = configuration;
    if (!template_name) throw new Error("whatsapp: no template name is set.");
    const to = await recipient(configuration, ctx);
    let components;
    if (configuration.components_expr) {
      components = await evalExpr(configuration.components_expr, ctx);
      if (!Array.isArray(components))
        throw new Error("whatsapp: the components expression must give an array.");
    } else {
      const parameters = bodyParameters(
        await evalExpr(configuration.parameters_expr, ctx),
      );
      components = parameters.length ? [{ type: "body", parameters }] : [];
    }
    const sent = await whatsapp.sendMessage(to, "template", {
      name: template_name.trim(),
      language: { code: (language || "en_US").trim() },
      ...(components.length ? { components } : {}),
    });
    return await finish(sent, { table, row, configuration });
  },
};

/**
 * Can this user read this Saltcorn file? Saltcorn's roles run from 1 (admin)
 * upwards, and a file is readable by its owner and by every role at or below
 * its min_role_read. With no user - a scheduled trigger - the action runs with
 * the authority of whoever configured it.
 */
const canRead = (file, user) =>
  !user ||
  user.role_id === 1 ||
  (file.user_id && file.user_id === user.id) ||
  (user.role_id || 100) <= (file.min_role_read || 1);

const MEDIA_TYPES = ["image", "document", "audio", "video", "sticker"];
/** Only these take a caption; WhatsApp rejects one on audio or a sticker. */
const CAPTIONED = new Set(["image", "document", "video"]);

/**
 * The WhatsApp message type for a MIME type. Images are JPEG or PNG only - a
 * GIF or SVG sent as an image is refused, but goes through as a document.
 */
const typeForMime = (mimetype) => {
  const m = (mimetype || "").toLowerCase();
  if (m === "image/jpeg" || m === "image/png") return "image";
  if (m === "image/webp") return "sticker";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  return "document";
};

const EXTENSION_MIME = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mp4: "video/mp4",
  "3gp": "video/3gpp",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  aac: "audio/aac",
  amr: "audio/amr",
  m4a: "audio/mp4",
};

const isUrl = (v) => typeof v === "string" && /^https?:\/\//i.test(v.trim());

/**
 * Resolve a media expression to what the message will carry: a link Meta
 * fetches itself, or the bytes of a file to upload.
 *
 * Accepts a public URL, a Saltcorn file path (the value of a File field), a
 * File object, or `{filename, content, mimetype}` with the bytes supplied
 * directly.
 *
 * @returns {Promise<{link?: string, file?: object, filename: string, mimetype: string}>}
 */
const loadMedia = async (value, user) => {
  if (!value) throw new Error("whatsapp: the media expression produced nothing to send.");
  if (isUrl(value)) {
    const link = value.trim();
    const filename = decodeURIComponent(new URL(link).pathname.split("/").pop() || "file");
    const ext = (filename.split(".").pop() || "").toLowerCase();
    return { link, filename, mimetype: EXTENSION_MIME[ext] || "" };
  }
  if (typeof value === "object" && value.content !== undefined) {
    const file = {
      filename: value.filename || "file",
      mimetype: value.mimetype || "application/octet-stream",
      content: Buffer.isBuffer(value.content) ? value.content : Buffer.from(String(value.content)),
    };
    return { file, filename: file.filename, mimetype: file.mimetype };
  }
  const found =
    typeof value === "object" && value.location ? value : await File.findOne(String(value));
  if (!found)
    throw new Error(`whatsapp: no file "${value}" to send. Check the file field or path.`);
  if (!canRead(found, user))
    throw new Error(`whatsapp: you do not have access to the file "${found.filename}".`);
  const mimetype = found.mime_super
    ? `${found.mime_super}/${found.mime_sub}`
    : "application/octet-stream";
  const file = { filename: found.filename, mimetype, content: await found.get_contents() };
  return { file, filename: file.filename, mimetype };
};

/** Send an image, document, audio clip, video or sticker. */
const send_media = {
  description:
    "Send a file or image over WhatsApp. Like text, only works within 24 " +
    "hours of the recipient's last message to you.",
  namespace: NAMESPACE,
  configFields: async ({ table, mode }) => [
    toField(table),
    codeField(
      "media_expr",
      "Media",
      "A File field, a file path, or a public https URL. Example: " +
        "<code>invoice_file</code> or <code>'https://example.com/a.pdf'</code>.",
      table,
      { required: true },
    ),
    {
      name: "media_type",
      label: "Send as",
      sublabel:
        "Automatic picks from the file type: JPEG and PNG as images, WebP as " +
        "a sticker, anything else WhatsApp cannot show inline as a document.",
      type: "String",
      required: true,
      attributes: { options: ["auto", ...MEDIA_TYPES] },
      default: "auto",
    },
    codeField(
      "caption_expr",
      "Caption",
      "Optional, up to 1024 characters. Ignored for audio and stickers, " +
        "which WhatsApp does not caption.",
      table,
    ),
    ...messageIdField(table),
    ...resultVariable(mode),
  ],
  run: async ({ row, table, user, configuration }) => {
    const ctx = { row, table, user };
    const to = await recipient(configuration, ctx);
    const media = await loadMedia(await evalExpr(configuration.media_expr, ctx), user);
    const chosen = configuration.media_type;
    const type = MEDIA_TYPES.includes(chosen) ? chosen : typeForMime(media.mimetype);

    const content = media.link
      ? { link: media.link }
      : { id: await whatsapp.uploadMedia(media.file) };
    if (type === "document") content.filename = media.filename;
    if (CAPTIONED.has(type) && configuration.caption_expr) {
      const caption = await evalExpr(configuration.caption_expr, ctx);
      if (caption !== undefined && caption !== null && String(caption) !== "")
        content.caption = textOf(caption, "caption", MAX_CAPTION);
    }

    const sent = await whatsapp.sendMessage(to, type, content);
    return await finish(sent, { table, row, configuration });
  },
};

const isFileField = (f) => f.type === "File" || (f.type && f.type.name === "File");

/** A file extension for a MIME type: "audio/ogg; codecs=opus" gives "ogg". */
const extensionFor = (mimetype) => {
  const sub = (mimetype || "").split(";")[0].split("/")[1] || "bin";
  const known = { jpeg: "jpg", mpeg: "mp3", plain: "txt", "vnd.ms-excel": "xls" };
  return known[sub] || sub.replace(/[^a-z0-9]+/gi, "").slice(0, 10) || "bin";
};

/** Save media someone sent you as a Saltcorn file. */
const download_media = {
  description:
    "Save an image, document, audio clip or video from an incoming WhatsApp " +
    "message as a Saltcorn file",
  namespace: NAMESPACE,
  configFields: async ({ table, mode }) => {
    const roles = await Role.find({}, { orderBy: "id" });
    const fileFields = fieldOptions(table, isFileField);
    return [
      codeField(
        "media_id_expr",
        "Media ID",
        "In a trigger on the WhatsAppMessage event this is <code>media_id</code>.",
        table,
        { required: true },
      ),
      codeField(
        "filename_expr",
        "File name",
        "Optional. Example: <code>filename</code>, which documents carry. " +
          "Without one, the file is named after the media ID.",
        table,
      ),
      {
        name: "min_role_read",
        label: "Readable by",
        sublabel: "The lowest role that can read the saved file",
        type: "String",
        required: true,
        attributes: {
          options: roles.map((r) => ({ label: r.role, name: String(r.id) })),
        },
        default: "1",
      },
      ...(fileFields.length
        ? [
            {
              name: "file_field",
              label: "Save file to",
              sublabel: "Optional. A File field on the row to store the file in.",
              type: "String",
              attributes: { options: ["", ...fileFields] },
            },
          ]
        : []),
      ...(mode === "workflow"
        ? [
            {
              name: "result_variable",
              label: "Result variable",
              sublabel: "Context variable to fill with { path, filename, mimetype }",
              type: "String",
            },
          ]
        : []),
    ];
  },
  run: async ({ row, table, user, configuration }) => {
    const ctx = { row, table, user };
    const mediaId = await evalExpr(configuration.media_id_expr, ctx);
    if (!mediaId) throw new Error("whatsapp: the media ID expression produced no ID.");
    const media = await whatsapp.downloadMedia(String(mediaId));
    const named = await evalExpr(configuration.filename_expr, ctx);
    const filename = named
      ? String(named)
      : `whatsapp-${mediaId}.${extensionFor(media.mimetype)}`;
    const file = await File.from_contents(
      filename,
      media.mimetype,
      media.content,
      user && user.id,
      parseInt(configuration.min_role_read, 10) || 1,
    );
    const saved = { path: file.path_to_serve, filename, mimetype: media.mimetype };
    if (configuration.file_field)
      await writeBack(table, row, configuration.file_field, saved.path);
    if (configuration.result_variable) return { [configuration.result_variable]: saved };
    return { notify: `Saved ${filename}` };
  },
};

module.exports = {
  whatsapp_send_text: send_text,
  whatsapp_send_template: send_template,
  whatsapp_send_media: send_media,
  whatsapp_download_media: download_media,
  // exported for tests
  _internal: { bodyParameters, typeForMime, loadMedia, canRead, extensionFor },
};
