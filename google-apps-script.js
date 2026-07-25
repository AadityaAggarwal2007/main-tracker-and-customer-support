// ═══════════════════════════════════════════════
// ShipTrack — Gmail Draft Creator
// ═══════════════════════════════════════════════
// 
// HOW TO SET UP:
// 1. Go to https://script.google.com → New Project
//    (Make sure you're signed in with your Workspace account)
// 2. Delete any existing code and paste this entire file
// 3. Click "Deploy" → "New Deployment"
// 4. Type: "Web app"
// 5. Execute as: "Me (your-workspace-email@yourdomain.com)"
// 6. Who has access: "Anyone"
// 7. Click "Deploy" → Authorize when prompted
// 8. Copy the Web App URL → paste in Vercel as GMAIL_SCRIPT_URL
// ═══════════════════════════════════════════════

function doGet(e) {
  return ContentService.createTextOutput(
    JSON.stringify({ status: 'ok', service: 'ShipTrack Email Web App' })
  ).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var emails = data.emails; // Array of { to, subject, html }
    
    if (!emails || !emails.length) {
      return ContentService.createTextOutput(
        JSON.stringify({ success: false, error: 'No emails provided', sent: 0 })
      ).setMimeType(ContentService.MimeType.JSON);
    }
    
    var sent = 0;
    var failed = 0;
    var errors = [];
    
    for (var i = 0; i < emails.length; i++) {
      try {
        var email = emails[i];
        
        // Send email directly — no drafts!
        GmailApp.sendEmail(
          email.to,       // recipient
          email.subject,  // subject
          '',             // plain text body (empty, we use HTML)
          { htmlBody: email.html }  // HTML body
        );
        
        sent++;
      } catch (err) {
        failed++;
        if (errors.length < 3) {
          errors.push(err.toString());
        }
      }
    }
    
    return ContentService.createTextOutput(
      JSON.stringify({
        success: true,
        sent: sent,
        drafts: sent,  // keep backwards compatibility
        failed: failed,
        errors: errors,
        message: sent + ' emails sent' + (failed > 0 ? ', ' + failed + ' failed' : '')
      })
    ).setMimeType(ContentService.MimeType.JSON);
    
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ success: false, error: err.toString(), sent: 0, drafts: 0 })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

// Test function — run this to trigger the permission prompt
function testDraft() {
  GmailApp.createDraft('test@example.com', 'Test Draft', 'This is a test draft from ShipTrack');
  Logger.log('Test draft created! Check your Gmail Drafts folder.');
}


// ═══════════════════════════════════════════════
// AUTO SEND DRAFTS
// ═══════════════════════════════════════════════
//
// HOW TO USE:
//   Option A — Run manually:
//     Select "sendDrafts" from the function dropdown → click ▶ Run
//
//   Option B — Auto-send on a schedule:
//     Select "setupAutoSendTrigger" → click ▶ Run (do this ONCE)
//     It will send 5 drafts every hour automatically.
//     To stop: go to Triggers (clock icon) → delete the trigger.
//
//   Change SEND_COUNT below to send more or fewer at a time.
// ═══════════════════════════════════════════════

var SEND_COUNT = 5; // ← change this number to send more/fewer drafts per run

function sendDrafts() {
  var drafts = GmailApp.getDrafts();

  if (drafts.length === 0) {
    Logger.log('No drafts found.');
    return;
  }

  var toSend = Math.min(SEND_COUNT, drafts.length);
  var sent = 0;
  var failed = 0;

  Logger.log('Found ' + drafts.length + ' drafts. Sending ' + toSend + '...');

  for (var i = 0; i < toSend; i++) {
    try {
      var subject = drafts[i].getMessage().getSubject();
      drafts[i].send();
      sent++;
      Logger.log('✅ Sent ' + (i + 1) + ': ' + subject);
      Utilities.sleep(500); // 0.5s delay between sends to avoid rate limits
    } catch (err) {
      failed++;
      Logger.log('❌ Failed draft ' + (i + 1) + ': ' + err.toString());
    }
  }

  Logger.log('Done! Sent: ' + sent + ' | Failed: ' + failed + ' | Remaining drafts: ' + (drafts.length - sent));
}

// ── Run this ONCE to set up automatic sending every hour ──
function setupAutoSendTrigger() {
  // Remove any existing sendDrafts triggers to avoid duplicates
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendDrafts') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  // Create new trigger: run sendDrafts every 1 minute
  ScriptApp.newTrigger('sendDrafts')
    .timeBased()
    .everyMinutes(1)
    .create();

  Logger.log('✅ Auto-send trigger created! Will send ' + SEND_COUNT + ' drafts every minute.');
}

// ── Run this to STOP auto-sending ──
function removeAutoSendTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendDrafts') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  Logger.log('Removed ' + removed + ' trigger(s). Auto-send stopped.');
}


// ═══════════════════════════════════════════════
// DRAFT QUEUE PROCESSOR
// ═══════════════════════════════════════════════
//
// This replaces the old "create all drafts at once" approach.
// Instead of timing out on 900 orders, it processes 5 at a time
// every minute by polling the /api/draft-queue/next endpoint.
//
// HOW TO SET UP (do this ONCE):
// 1. Go to Project Settings (⚙️) → Script Properties
// 2. Add these three properties:
//      QUEUE_NEXT_URL     → https://your-app.vercel.app/api/draft-queue/next
//      QUEUE_COMPLETE_URL → https://your-app.vercel.app/api/draft-queue/complete
//      QUEUE_SECRET       → (same random string you set as DRAFT_QUEUE_SECRET in Vercel)
// 3. Run "setupQueueTrigger" once to start the auto-processing.
// ═══════════════════════════════════════════════

var QUEUE_BATCH_SIZE = 5; // drafts to create per minute (safe limit)

function processQueue() {
  var props = PropertiesService.getScriptProperties();
  var nextUrl = props.getProperty('QUEUE_NEXT_URL');
  var completeUrl = props.getProperty('QUEUE_COMPLETE_URL');
  var secret = props.getProperty('QUEUE_SECRET');

  if (!nextUrl || !completeUrl || !secret) {
    Logger.log('❌ Queue not configured. Set QUEUE_NEXT_URL, QUEUE_COMPLETE_URL, QUEUE_SECRET in Script Properties.');
    return;
  }

  // 1. Fetch next batch of pending orders from our API
  var fetchUrl = nextUrl + '?limit=' + QUEUE_BATCH_SIZE + '&key=' + encodeURIComponent(secret);
  var fetchRes;
  try {
    fetchRes = UrlFetchApp.fetch(fetchUrl, { method: 'get', muteHttpExceptions: true });
  } catch (err) {
    Logger.log('❌ Failed to fetch queue: ' + err.toString());
    return;
  }

  if (fetchRes.getResponseCode() !== 200) {
    Logger.log('❌ Queue next returned ' + fetchRes.getResponseCode() + ': ' + fetchRes.getContentText().slice(0, 200));
    return;
  }

  var payload;
  try {
    payload = JSON.parse(fetchRes.getContentText());
  } catch (err) {
    Logger.log('❌ Failed to parse queue response: ' + err.toString());
    return;
  }

  var emails = payload.emails || [];

  if (emails.length === 0) {
    Logger.log('✅ Queue empty — nothing to process.');
    return;
  }

  Logger.log('📬 Processing ' + emails.length + ' queued drafts...');

  // 2. Create Gmail drafts for each item
  var results = [];
  for (var i = 0; i < emails.length; i++) {
    var item = emails[i];

    // Items with skip=true (no email address, template missing) — mark done without creating draft
    if (item.skip) {
      Logger.log('⏭️ Skipped ' + item.queueId + ' (' + item.reason + ')');
      results.push({ queueId: item.queueId, orderId: item.orderId, to: '', success: true, error: 'skipped:' + item.reason });
      continue;
    }

    try {
      GmailApp.createDraft(
        item.to,
        item.subject,
        '',
        { htmlBody: item.html }
      );
      Logger.log('✅ Draft created for order ' + item.orderId + ' → ' + item.to);
      results.push({ queueId: item.queueId, orderId: item.orderId, to: item.to, success: true });
    } catch (err) {
      Logger.log('❌ Failed draft for ' + item.orderId + ': ' + err.toString());
      results.push({ queueId: item.queueId, orderId: item.orderId, to: item.to, success: false, error: err.toString() });
    }

    Utilities.sleep(300); // small delay between drafts
  }

  // 3. Report results back to our API
  try {
    var completeFullUrl = completeUrl + '?key=' + encodeURIComponent(secret);
    UrlFetchApp.fetch(completeFullUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ results: results }),
      muteHttpExceptions: true,
    });
    Logger.log('✅ Reported ' + results.length + ' results back to queue.');
  } catch (err) {
    Logger.log('⚠️ Failed to report results: ' + err.toString());
    // Not fatal — the queue rows will stay as 'processing' and can be retried
  }

  // ── Send pending emails (pull from Vercel, send via Gmail) ──
  sendPendingEmails();

  // ── Auto-progress orders (piggyback on the 1-minute trigger) ──
  progressOrders();
}

// ═══════════════════════════════════════════════
// SEND PENDING EMAILS
// ═══════════════════════════════════════════════
// Instead of Vercel pushing to Apps Script (blocked by Workspace),
// Apps Script PULLS unsent orders from Vercel and sends directly.
//
// Requires Script Property:
//   PENDING_EMAILS_URL → https://shiptrack.store/api/cron/pending-emails
//   QUEUE_SECRET       → (same secret as before)
// ═══════════════════════════════════════════════

function sendPendingEmails() {
  var props = PropertiesService.getScriptProperties();
  var pendingUrl = props.getProperty('PENDING_EMAILS_URL');
  var secret = props.getProperty('QUEUE_SECRET');

  if (!pendingUrl || !secret) {
    // Not configured yet — skip silently
    return;
  }

  try {
    // 1. Fetch unsent emails from Vercel
    var url = pendingUrl + '?key=' + encodeURIComponent(secret) + '&limit=5';
    var res = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });

    if (res.getResponseCode() !== 200) {
      Logger.log('⚠️ Pending emails returned ' + res.getResponseCode());
      return;
    }

    var data = JSON.parse(res.getContentText());
    var emails = data.emails || [];

    if (emails.length === 0) {
      return; // Nothing to send
    }

    Logger.log('📧 Sending ' + emails.length + ' pending emails...');

    // 2. Send each email via Gmail
    var results = [];
    for (var i = 0; i < emails.length; i++) {
      var email = emails[i];
      try {
        GmailApp.sendEmail(
          email.to,
          email.subject,
          '',
          { htmlBody: email.html }
        );
        Logger.log('✅ Email sent for ' + email.orderId + ' → ' + email.to);
        results.push({ orderId: email.orderId, to: email.to, success: true });
      } catch (err) {
        Logger.log('❌ Failed email for ' + email.orderId + ': ' + err.toString());
        results.push({ orderId: email.orderId, to: email.to, success: false, error: err.toString() });
      }
      Utilities.sleep(300);
    }

    // 3. Report results back to Vercel (log them in email_logs)
    if (results.length > 0) {
      try {
        var reportUrl = pendingUrl + '?key=' + encodeURIComponent(secret);
        UrlFetchApp.fetch(reportUrl, {
          method: 'post',
          contentType: 'application/json',
          payload: JSON.stringify({ results: results }),
          muteHttpExceptions: true,
        });
        Logger.log('✅ Reported ' + results.length + ' email results.');
      } catch (err) {
        Logger.log('⚠️ Failed to report email results: ' + err.toString());
      }
    }

  } catch (err) {
    Logger.log('⚠️ sendPendingEmails error: ' + err.toString());
  }
}

// ═══════════════════════════════════════════════
// AUTO-PROGRESSION
// ═══════════════════════════════════════════════
// Calls the progress-orders endpoint to auto-advance
// order statuses based on configured timers.
// Runs every minute as part of processQueue.
//
// Requires Script Property:
//   PROGRESS_URL → https://shiptrack.store/api/cron/progress-orders
// ═══════════════════════════════════════════════

function progressOrders() {
  var props = PropertiesService.getScriptProperties();
  var progressUrl = props.getProperty('PROGRESS_URL');
  var secret = props.getProperty('QUEUE_SECRET');

  if (!progressUrl || !secret) {
    // Silently skip if not configured
    return;
  }

  try {
    var url = progressUrl + '?key=' + encodeURIComponent(secret);
    var res = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
    var body = res.getContentText();
    
    if (res.getResponseCode() === 200) {
      var result = JSON.parse(body);
      if (result.progressed > 0) {
        Logger.log('🔄 Auto-progressed ' + result.progressed + ' orders.');
      }
    }
  } catch (err) {
    // Don't fail processQueue if progression fails
    Logger.log('⚠️ Auto-progression error: ' + err.toString());
  }
}

// ── Run this ONCE to set up automatic queue processing every minute ──
function setupQueueTrigger() {
  // Remove any existing processQueue triggers
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'processQueue') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  ScriptApp.newTrigger('processQueue')
    .timeBased()
    .everyMinutes(1)
    .create();

  Logger.log('✅ Queue trigger created! Will process ' + QUEUE_BATCH_SIZE + ' drafts every minute.');
}

// ── Run this to STOP queue processing ──
function removeQueueTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'processQueue') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  Logger.log('Removed ' + removed + ' queue trigger(s). Queue processing stopped.');
}

// ── Test the queue connection ──
function testQueueConnection() {
  var props = PropertiesService.getScriptProperties();
  var nextUrl = props.getProperty('QUEUE_NEXT_URL');
  var secret = props.getProperty('QUEUE_SECRET');

  if (!nextUrl || !secret) {
    Logger.log('❌ QUEUE_NEXT_URL and QUEUE_SECRET must be set in Script Properties first.');
    return;
  }

  var url = nextUrl + '?limit=1&key=' + encodeURIComponent(secret);
  var res = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
  Logger.log('Status: ' + res.getResponseCode());
  Logger.log('Response: ' + res.getContentText().slice(0, 300));
}
