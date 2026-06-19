// ═══════════════════════════════════════════════
// ShipTrack — Gmail Draft Creator
// ═══════════════════════════════════════════════
// 
// HOW TO SET UP:
// 1. Go to https://script.google.com → New Project
// 2. Delete any existing code and paste this entire file
// 3. Click "Deploy" → "New Deployment"
// 4. Type: "Web app"
// 5. Execute as: "Me (krvvy700@gmail.com)"
// 6. Who has access: "Anyone"
// 7. Click "Deploy" → Authorize when prompted
// 8. Copy the Web App URL → paste in Vercel as GMAIL_SCRIPT_URL
// ═══════════════════════════════════════════════

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var emails = data.emails; // Array of { to, subject, html }
    
    if (!emails || !emails.length) {
      return ContentService.createTextOutput(
        JSON.stringify({ success: false, error: 'No emails provided', drafts: 0 })
      ).setMimeType(ContentService.MimeType.JSON);
    }
    
    var created = 0;
    var failed = 0;
    var errors = [];
    
    for (var i = 0; i < emails.length; i++) {
      try {
        var email = emails[i];
        
        // Create a draft in Gmail
        GmailApp.createDraft(
          email.to,       // recipient
          email.subject,  // subject
          '',             // plain text body (empty, we use HTML)
          { htmlBody: email.html }  // HTML body
        );
        
        created++;
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
        drafts: created,
        failed: failed,
        errors: errors,
        message: created + ' drafts created' + (failed > 0 ? ', ' + failed + ' failed' : '')
      })
    ).setMimeType(ContentService.MimeType.JSON);
    
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ success: false, error: err.toString(), drafts: 0 })
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
