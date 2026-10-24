# Trying out WhatsApp webhooks

The webhook lets Saltcorn hear back from WhatsApp: messages people send to
your business number, and whether the messages you sent were delivered,
read or failed. This guide walks through trying each of these in the
browser.

## Before you start

- **Sending works.** The plugin is configured with an access token and
  phone number ID, and you can send yourself a message.
- **Saltcorn has a public address.** Meta has to reach Saltcorn from the
  internet, at an `https://` address. Check the site's base URL under
  **Settings → Site identity → Base URL**. If the plugin's **Webhook** step
  shows a warning under the callback URL, Meta will not be able to reach it.
- **The event log is on.** Webhook events happen in the background, so you
  won't see them unless they are logged:
  1. Go to **Settings → Events → Event log**, and open its settings.
  2. Tick **WhatsAppMessage** and **WhatsAppStatus**. Leave their channel
     boxes empty to log everything.
  3. Save.

## 1. Connect the webhook

1. In Meta, open your app's **App settings → Basic**, click **Show** next to
   **App secret**, and copy it.
2. In Saltcorn, open the WhatsApp plugin's configuration and go to the
   **Webhook** step. Paste the app secret. Note the **Callback URL** and the
   **Verify token**, then save.
3. In Meta, open WhatsApp's **Step 2. Production setup** and expand
   **Configure Webhooks**. With the WhatsApp use case, it is under **Use
   cases → Customize → Connect on WhatsApp**.
4. Enter the callback URL and verify token from Saltcorn, and click **Verify
   and save**.
5. Subscribe to the **messages** field.

**If Meta says "The callback URL or verify token couldn't be validated":**

- Check that you saved the plugin configuration before clicking **Verify
  and save**. Meta checks the token straight away.
- Check that the verify token is exactly the same in both places.
- Check that the callback URL starts with `https://` and is not `localhost`.

## 2. Publish the app

Until the app is published, Meta does not send real messages or delivery
updates, not even yours as the app's admin. Click **Publish your app** on
the **Configure Webhooks** page, and complete what Meta asks for.

## 3. Receive a message

1. From your phone, send a WhatsApp message to your business number, e.g.
   "Hello".
2. In Saltcorn, open **Settings → Events → Event log**.

You should see a **WhatsAppMessage** entry on the `text` channel. Open it to
see who sent it (`from`, `name`) and what they wrote (`text`).

Try a photo, a document or a location as well. Each arrives on its own
channel: `image`, `document`, `location`.

## 4. Reply automatically

Someone who messages you opens a 24-hour window in which you can answer
freely. A trigger can use it:

1. Go to **Settings → Events → Triggers** and click **Create trigger**.
2. Set **When** to **WhatsAppMessage**, **Channel** to `text`, and
   **Action** to **whatsapp_send_text**.
3. Set **To** to `from`, and **Text** to `` `Thanks, we got: ${text}` ``.
4. Save, then message your business number again.

The reply should arrive on your phone within a few seconds.

## 5. Save photos people send

1. Create another trigger: **When** **WhatsAppMessage**, **Channel**
   `image`, **Action** **whatsapp_download_media**.
2. Set **Media ID** to `media_id`, and choose who can read the saved file.
3. Save, then send a photo to your business number.

The photo should appear under **Settings → Files**.

## 6. Follow delivery status

1. Create a table, e.g. **WhatsApp messages**, with three String fields:
   **Message ID**, **Status** and **Error**.
2. In the plugin's configuration, on the **Webhook** step, choose that
   table under **Track delivery status in**. On the next step, **Delivery
   status**, pick the three fields.
3. Send yourself a message with one of the send actions, from a button or
   a trigger on that table, with **Save message ID to** set to **Message
   ID**.
4. Open the table's data. The **Status** field should move from `sent` to
   `delivered`, and to `read` once you open the message, if your read
   receipts are on.

The event log shows the same steps as **WhatsAppStatus** entries.

## 7. See a failure

Send a message to a number that is not on WhatsApp. The event log should
show **WhatsAppStatus** on the `failed` channel, with the reason in
`error_code` and `error_title`. If you are tracking delivery status, the
row's **Status** becomes `failed` and **Error** says why.

To be told about failures as they happen, create a trigger on
**WhatsAppStatus** with the channel `failed`, e.g. one that emails you.

## If nothing shows up

- **No events at all:** check that the event log settings tick
  **WhatsAppMessage** and **WhatsAppStatus**, that the app is published,
  and that the webhook is subscribed to the **messages** field.
- **The webhook stopped working:** check that the app secret in the plugin
  matches **App settings → Basic** in Meta. If Saltcorn's address changed,
  update the callback URL in Meta.
- **Messages arrive but no reply is sent:** check the trigger's channel,
  and that it uses `from` as the recipient.
- **Status never changes:** check that the send action saved the message
  ID into the field picked as **Message ID field**.
