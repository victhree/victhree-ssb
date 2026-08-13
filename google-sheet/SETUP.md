# Connecting the welcome popup to a Google Sheet

The site is static (GitHub Pages), so it cannot write to Google Sheets directly.
Instead you deploy a tiny **Google Apps Script Web App** on your own Google
account. The popup posts each submission to it, and it appends a row to your
Sheet. One-time setup, about 5 minutes.

## 1. Make the Sheet
1. Go to https://sheets.google.com and create a new blank spreadsheet.
2. Name it something like **VicThree Leads**.
3. In the first row, type these headers (one per cell, A1 to E1):

   | Timestamp | Name | Phone | Email | Page |

## 2. Add the script
1. In that Sheet, open **Extensions -> Apps Script**.
2. Delete whatever code is shown, then paste the entire contents of
   `Code.gs` (in this folder).
3. Click the **Save** icon.

## 3. Deploy as a Web App
1. Click **Deploy -> New deployment**.
2. Click the gear next to "Select type" and choose **Web app**.
3. Set:
   - **Description:** VicThree leads
   - **Execute as:** Me
   - **Who has access:** **Anyone**
4. Click **Deploy**. Google will ask you to authorise it, allow the access
   (choose your account, click Advanced -> Go to project -> Allow).
5. Copy the **Web app URL**. It looks like:
   `https://script.google.com/macros/s/AKfy....../exec`

## 4. Wire it into the site
1. Open `assets/config.js`.
2. Paste your URL between the quotes:

   ```js
   sheetEndpoint: "https://script.google.com/macros/s/AKfy....../exec"
   ```
3. Save, commit and push. Done.

## Test it
Open the site in a fresh browser (or a private/incognito window so the popup
shows again), fill in the form, and click **Let's get started**. A new row
should appear in your Sheet within a few seconds.

## Notes
- To make the popup show again for yourself while testing, open the browser
  console and run `localStorage.removeItem('v3_lead_done')`, then reload.
- If you ever change the script, use **Deploy -> Manage deployments -> Edit
  (pencil) -> New version** so the same URL keeps working.
- Every submission is also kept in the visitor's browser as a backup
  (`v3_lead_data`), but the Sheet is the real record.
