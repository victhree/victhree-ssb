/**
 * VicThree Defence — lead capture endpoint (Google Apps Script Web App).
 * Appends each welcome-popup submission as a row in the bound Google Sheet.
 *
 * Setup: see SETUP.md in this folder.
 * The Sheet's first row (header) should be:
 *   Timestamp | Name | Phone | Email | Page
 */

function doPost(e) {
  return handle(e);
}

// Lets you open the Web App URL in a browser to confirm it is live.
function doGet(e) {
  return ContentService
    .createTextOutput("VicThree lead endpoint is live.")
    .setMimeType(ContentService.MimeType.TEXT);
}

function handle(e) {
  try {
    var p = (e && e.parameter) ? e.parameter : {};
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];

    sheet.appendRow([
      p.ts || new Date().toISOString(),
      p.name || "",
      p.phone || "",
      p.email || "",
      p.page || ""
    ]);

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
