const crypto = require("crypto");
const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Table = require("@saltcorn/data/models/table");
const { getState } = require("@saltcorn/data/db/state");
const { a, div, p, ol, li, strong, code } = require("@saltcorn/markup/tags");

const actions = require("./lib/actions");
const { routes } = require("./lib/routes");
const { MESSAGE_EVENT, STATUS_EVENT } = require("./lib/webhook");
const { DEFAULT_API_VERSION, WEBHOOK_PATH, callbackProblem } = require("./lib/config");

const DEVELOPERS_URL = "https://developers.facebook.com/";
const BUSINESS_SETTINGS_URL = "https://business.facebook.com/latest/settings";

/**
 * The Meta side of the setup, short enough to follow beside the form. The
 * README has the long version and the troubleshooting.
 *
 * Returned as an array: Form renders an array blurb verbatim, where a single
 * string is wrapped in a <p>.
 */
const setupBlurb = () => [
  div(
    { class: "mb-3" },
    p("This plugin needs two values from Meta: a phone number ID and an access token."),
    ol(
      li(
        "On ",
        a({ href: DEVELOPERS_URL, target: "_blank" }, "Meta for Developers"),
        ", go to ",
        strong("My Apps → Create App"),
        ". Under ",
        strong("Use cases"),
        ", choose ",
        strong("Connect with customers through WhatsApp"),
        " (recommended). Another option is ",
        strong("Other"),
        " with the app type ",
        strong("Business"),
        ", then ",
        strong("Set up"),
        " on WhatsApp. Either way, pick or create a business portfolio.",
      ),
      li(
        "Follow the WhatsApp setup Meta shows in the app. Copy the ",
        strong("Phone Number ID"),
        " shown next to the test number under ",
        strong("WhatsApp → Step 1. Try it out"),
        ".",
      ),
      li(
        "In ",
        a({ href: BUSINESS_SETTINGS_URL, target: "_blank" }, "Business settings"),
        ", go to ",
        strong("Users → System users"),
        ". Add a system user. Under ",
        strong("Assign assets"),
        ", give it full control of the app and the WhatsApp account. Then click ",
        strong("Generate token"),
        " with ",
        code("whatsapp_business_messaging"),
        " and ",
        code("whatsapp_business_management"),
        ", and choose an expiry of ",
        strong("Never"),
        ". The token from ",
        strong("Generate token"),
        " on the WhatsApp setup pages expires within about a day.",
      ),
    ),
    p(
      { class: "text-muted" },
      "Text and media are only delivered within 24 hours of the recipient's " +
        "last message to you. To start a conversation, send an approved " +
        "template.",
    ),
  ),
];

/** The URL to give Meta, or a placeholder showing its shape. */
const callbackUrl = () => {
  let base = "";
  try {
    base = (getState().getConfig("base_url", "") || "").replace(/\/+$/, "");
  } catch (e) {}
  return {
    url: `${base || "https://your-saltcorn-host"}${WEBHOOK_PATH}`,
    problem: callbackProblem(base),
  };
};

const webhookBlurb = () => {
  const { url, problem } = callbackUrl();
  return [
    div(
      { class: "mb-3" },
      p(
        "Optional. The webhook lets Saltcorn receive incoming messages and " +
          "delivery updates, as the ",
        code(MESSAGE_EVENT),
        " and ",
        code(STATUS_EVENT),
        " trigger events.",
      ),
      ol(
        li(
          "In the Meta app, open ",
          strong("App settings → Basic"),
          ", click ",
          strong("Show"),
          " next to ",
          strong("App secret"),
          ", and paste it below.",
        ),
        li("Save this page, so Saltcorn knows the verify token before Meta checks it."),
        li(
          "On WhatsApp's ",
          strong("Step 2. Production setup"),
          " page, open ",
          strong("Configure Webhooks"),
          ". Enter the callback URL and the verify token below, click ",
          strong("Verify and save"),
          ", then subscribe to the ",
          strong("messages"),
          " field.",
        ),
      ),
      p(
        { class: "text-muted" },
        "Until the app is published, Meta only sends the test webhooks you " +
          "trigger from the dashboard. Real messages and status updates need " +
          "a published app.",
      ),
      p("Callback URL:"),
      p(code({ class: "user-select-all" }, url)),
      problem ? div({ class: "alert alert-warning" }, problem) : "",
    ),
  ];
};

const configuration_workflow = () =>
  new Workflow({
    steps: [
      {
        name: "WhatsApp Cloud API",
        form: async () =>
          new Form({
            blurb: setupBlurb(),
            fields: [
              {
                name: "access_token",
                label: "Access token",
                sublabel:
                  "The system user token. The one from the WhatsApp setup " +
                  "pages expires within about a day.",
                type: "String",
                required: true,
                input_type: "password",
              },
              {
                name: "phone_number_id",
                label: "Phone number ID",
                sublabel:
                  "From WhatsApp → Step 1. Try it out, next to the test " +
                  "number. It is not the phone number itself.",
                type: "String",
                required: true,
              },
              {
                name: "default_country_code",
                label: "Default country code",
                sublabel:
                  "Optional, digits only, e.g. 1. Lets recipients be " +
                  "written as national numbers starting with 0.",
                type: "String",
              },
              {
                name: "api_version",
                label: "Graph API version",
                sublabel:
                  "Meta retires each version about two years after release.",
                type: "String",
                required: true,
                default: DEFAULT_API_VERSION,
              },
            ],
          }),
      },
      {
        name: "Webhook",
        form: async () => {
          const tables = await Table.find({}, { orderBy: "name" });
          return new Form({
            blurb: webhookBlurb(),
            fields: [
              {
                name: "verify_token",
                label: "Verify token",
                sublabel: "Any secret string. Enter the same one in Meta.",
                type: "String",
                default: crypto.randomBytes(16).toString("hex"),
              },
              {
                name: "app_secret",
                label: "App secret",
                sublabel:
                  "Checks that each webhook really comes from Meta. Without " +
                  "it, every webhook is refused.",
                type: "String",
                input_type: "password",
              },
              {
                name: "status_table",
                label: "Track delivery status in",
                sublabel:
                  "Optional. A table where you save message IDs. Its rows " +
                  "are updated as messages are delivered, read or fail. The " +
                  "next step picks the fields.",
                type: "String",
                attributes: { options: ["", ...tables.map((t) => t.name)] },
              },
            ],
          });
        },
      },
      {
        name: "Delivery status",
        onlyWhen: (context) => !!context.status_table,
        form: async (context) => {
          const table =
            Table.findOne({ name: context.status_table }) ||
            (await Table.find({ name: context.status_table }))[0];
          const strings = ((table && table.fields) || [])
            .filter((f) => f.type && f.type.name === "String")
            .map((f) => f.name);
          return new Form({
            blurb: [
              p(
                "Statuses only move forward: a late ",
                code("delivered"),
                " never replaces ",
                code("read"),
                ", and ",
                code("failed"),
                " is final.",
              ),
            ],
            fields: [
              {
                name: "status_id_field",
                label: "Message ID field",
                sublabel: "Where the send actions save the message ID",
                type: "String",
                required: true,
                attributes: { options: strings },
              },
              {
                name: "status_field",
                label: "Status field",
                sublabel: "Set to sent, delivered, read or failed",
                type: "String",
                required: true,
                attributes: { options: strings },
              },
              {
                name: "status_error_field",
                label: "Error field",
                sublabel: "Optional. Why a message failed, e.g. its error code and title",
                type: "String",
                attributes: { options: ["", ...strings] },
              },
            ],
          });
        },
      },
    ],
  });

const { _internal, ...exportedActions } = actions;

module.exports = {
  sc_plugin_api_version: 1,
  plugin_name: "whatsapp",
  configuration_workflow,
  actions: () => exportedActions,
  routes: () => routes,
  eventTypes: () => ({
    [MESSAGE_EVENT]: { hasChannel: true },
    [STATUS_EVENT]: { hasChannel: true },
  }),
};
