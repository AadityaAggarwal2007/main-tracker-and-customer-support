// Meta's errors in the owner's words (whatsapp*.ts). `metaHint` reads the text Meta gave back (its code in
// brackets, "(#10) Application does not have permission ...") and says what it means and what to do; the
// WhatsApp screen shows the hint under the error. Pure, unit-tested.

export interface MetaHint { what: string; fix: string }

export function metaHint(error: string | null | undefined): MetaHint | null {
  const e = (error || '').trim();
  if (!e) return null;
  const code = (e.match(/\(#(\d+)\)/) || e.match(/\b(\d{3,6})\b/))?.[1];
  const paid = e.match(/Paid Message Account\s+(\d{6,30})/i);
  if (paid) {
    return {
      what: `The token's System User can use the number, but not the account that pays for the messages (${paid[1]}, the one with your funds in Billing & payments). Meta refuses to send until that user can see it.`,
      fix: `Meta Business Settings > Users > System users > shiptrack-server > Add assets > WhatsApp accounts > tick the account with id ${paid[1]} (open it in "WhatsApp accounts": its address bar ends with selected_asset_id=${paid[1]}) > Full control > Save. Then press Send again. No new token is needed; if it still fails, make a new token with the same 3 permissions.`,
    };
  }
  if (/cannot be used with this API/i.test(e)) {
    return {
      what: 'Meta keeps message templates on the Messaging account, not on the WhatsApp account, so it refused to make one on the WhatsApp account id.',
      fix: 'Setup tab > "Messaging account id": paste the id of Business Settings > Accounts > Messaging accounts > Shiptrack (the number in its address bar), Save, then send the template again. The System User needs Full control on that Messaging account (System users > shiptrack-server > Assign assets).',
    };
  }
  if (code === '10' || /does not have permission for this action/i.test(e)) {
    return {
      what: 'The token is not allowed to do this. It belongs to a System User that has no rights on the app or the WhatsApp account, or it was made without the whatsapp_business_management permission.',
      fix: 'Meta Business Settings > Users > System users > the user > Assign assets: the app "ship track msg" (full control) and the WhatsApp account "Shiptrack" (full control). Then Generate new token with whatsapp_business_management + whatsapp_business_messaging + business_management, put it in /etc/tracker/.env as WHATSAPP_CLOUD_TOKEN and deploy (the old token stops working: that is the rotation the setup file asked for).',
    };
  }
  if (code === '190' || /token was refused|expired or revoked|Invalid OAuth/i.test(e)) {
    return { what: 'The WhatsApp token is dead (expired, revoked or wrong).', fix: 'Make a new System User token in Meta Business Settings, put it in /etc/tracker/.env as WHATSAPP_CLOUD_TOKEN and deploy.' };
  }
  if (code === '131047' || /24 hours/i.test(e)) {
    return { what: 'The customer last wrote over 24 hours ago, so a plain text cannot go.', fix: 'Send an approved template (the Template button) or wait for the customer to write.' };
  }
  if (code === '131026' || /cannot receive WhatsApp/i.test(e)) {
    return { what: 'That number cannot get WhatsApp messages from this business (no WhatsApp on it, or it blocked the number, or it is not on the app\'s allowed list while the app is in Development).', fix: 'Check the number, and that the Meta app is Live.' };
  }
  if (code === '131030') {
    return { what: 'The recipient is not in the allowed list (the test number only allows listed recipients).', fix: 'Use the real business number, or add the recipient in Meta > API Setup.' };
  }
  if (code === '131042' || /payment/i.test(e)) {
    return { what: 'Meta wants a payment method or funds before a business-initiated message.', fix: 'Billing & payments > Shiptrack > Add funds.' };
  }
  if (code === '132001' || /template name does not exist|Template name does not exist/i.test(e)) {
    return { what: 'Meta has no approved template by that name in that language.', fix: 'Use a template from the Templates tab that shows Approved.' };
  }
  if (code === '132012' || /parameter/i.test(e) && /template/i.test(e)) {
    return { what: 'The values do not match the template (too many, too few, or a newline / tab inside one).', fix: 'Fill exactly one value per {{n}}, one line each.' };
  }
  if (code === '100' && /does not exist|cannot be loaded|missing permissions/i.test(e) || /does not know this WhatsApp Business Account/i.test(e)) {
    return { what: 'Meta does not know that id, or the token cannot see it.', fix: 'Check the WhatsApp Business Account id / App id on the Setup tab (copy them from Meta Business Settings).' };
  }
  if (/not set up|token missing|phone number id missing/i.test(e)) {
    return { what: 'The server has no WhatsApp token or phone number id.', fix: 'Put WHATSAPP_CLOUD_TOKEN and WHATSAPP_PHONE_NUMBER_ID in /etc/tracker/.env and deploy.' };
  }
  if (/did not answer in time|Could not reach WhatsApp/i.test(e)) {
    return { what: 'Meta did not answer.', fix: 'Try again in a minute; if it keeps happening, check the VPS can reach graph.facebook.com.' };
  }
  return null;
}
