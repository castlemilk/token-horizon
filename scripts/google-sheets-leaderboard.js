/**
 * Token Horizon — Google Sheets Leaderboard Backend
 *
 * How to deploy in 60 seconds:
 * 1. Create a new Google Sheet at https://sheets.new
 * 2. In Google Sheets, click Extensions > Apps Script
 * 3. Delete any code in the editor, paste this entire file, and click Save (⌘S)
 * 4. Run the function `setupLeaderboardSheet()` once from the toolbar to initialize columns and styling
 * 5. Click Deploy > New deployment:
 *    - Type: Web app
 *    - Description: Token Horizon Leaderboard
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 6. Click Deploy and copy the Web App URL (ends in /exec)
 * 7. In Token Horizon (or terminal: `th leaderboard config <URL>`), paste the URL!
 */

const SHEET_NAME = "Leaderboard";
const HEADERS = [
  "Handle",
  "Team",
  "Tokens Today",
  "Tokens 7D",
  "Tokens All-Time",
  "Cost Today",
  "Cost 7D",
  "Cost All-Time",
  "Streak Days",
  "Top Model",
  "Hardware",
  "Updated At"
];

function getOrCreateSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    setupLeaderboardSheet();
  }
  return sheet;
}

function setupLeaderboardSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME) || ss.getActiveSheet();
  sheet.setName(SHEET_NAME);

  // Set headers
  const headerRange = sheet.getRange(1, 1, 1, HEADERS.length);
  headerRange.setValues([HEADERS]);
  headerRange.setBackground("#0F172A");
  headerRange.setFontColor("#F8FAFC");
  headerRange.setFontWeight("bold");
  headerRange.setFontFamily("Consolas");
  headerRange.setHorizontalAlignment("center");

  sheet.setFrozenRows(1);

  // Set number formatting
  // Columns: 3 (Today), 4 (7D), 5 (All-Time) -> Numbers
  sheet.getRange("C2:E").setNumberFormat("#,##0");
  // Columns: 6 (Cost Today), 7 (Cost 7D), 8 (Cost All-Time) -> Currency
  sheet.getRange("F2:H").setNumberFormat("$#,##0.00");
  // Column: 9 (Streak) -> Integer
  sheet.getRange("I2:I").setNumberFormat("0");
  // Column: 12 (Updated At) -> Date/Time
  sheet.getRange("L2:L").setNumberFormat("yyyy-mm-dd hh:mm:ss");

  // Auto-resize
  for (let i = 1; i <= HEADERS.length; i++) {
    sheet.autoResizeColumn(i);
  }
}

function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents ? e.postData.contents : "{}";
    const payload = JSON.parse(raw);
    const entry = payload.entry || payload;

    if (!entry.handle) {
      return responseJSON({ ok: false, error: "Missing handle" }, 400);
    }

    const sheet = getOrCreateSheet();
    const data = sheet.getDataRange().getValues();
    const handleClean = String(entry.handle).replace(/^@/, "").trim().toLowerCase();

    let targetRow = -1;
    for (let r = 1; r < data.length; r++) {
      const existingHandle = String(data[r][0]).replace(/^@/, "").trim().toLowerCase();
      if (existingHandle === handleClean) {
        targetRow = r + 1; // 1-based index
        break;
      }
    }

    const rowValues = [
      "@" + String(entry.handle).replace(/^@/, "").trim(),
      entry.team || "",
      Number(entry.tokensToday) || 0,
      Number(entry.tokens7d) || 0,
      Number(entry.tokensAll) || 0,
      Number(entry.costToday) || 0.0,
      Number(entry.cost7d) || 0.0,
      Number(entry.costAll) || 0.0,
      Number(entry.streakDays) || 0,
      entry.topModel || "claude-3-7-sonnet",
      entry.hardware || "Apple Silicon",
      new Date()
    ];

    if (targetRow > 0) {
      sheet.getRange(targetRow, 1, 1, rowValues.length).setValues([rowValues]);
    } else {
      sheet.appendRow(rowValues);
    }

    // Sort by Tokens All-Time descending (Col 5)
    if (sheet.getLastRow() > 2) {
      sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.length).sort({ column: 5, ascending: false });
    }

    return responseJSON({
      ok: true,
      action: targetRow > 0 ? "updated" : "created",
      handle: entry.handle,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    return responseJSON({ ok: false, error: err.toString() }, 500);
  }
}

function doGet(e) {
  try {
    const sheet = getOrCreateSheet();
    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) {
      return responseJSON({ ok: true, count: 0, leaderboard: [] });
    }

    const leaderboard = [];
    for (let r = 1; r < data.length; r++) {
      const row = data[r];
      if (!row[0]) continue;
      leaderboard.push({
        id: "sheet:" + String(row[0]).replace(/^@/, ""),
        handle: String(row[0]).replace(/^@/, ""),
        team: String(row[1] || ""),
        tokensToday: Number(row[2]) || 0,
        tokens7d: Number(row[3]) || 0,
        tokensAll: Number(row[4]) || 0,
        costToday: Number(row[5]) || 0.0,
        cost7d: Number(row[6]) || 0.0,
        costAll: Number(row[7]) || 0.0,
        streakDays: Number(row[8]) || 0,
        topModel: String(row[9] || "claude-3-7-sonnet"),
        hardware: String(row[10] || "Apple Silicon"),
        updatedAt: row[11] instanceof Date ? row[11].getTime() / 1000 : Date.now() / 1000
      });
    }

    return responseJSON({
      ok: true,
      count: leaderboard.length,
      leaderboard: leaderboard
    });
  } catch (err) {
    return responseJSON({ ok: false, error: err.toString() }, 500);
  }
}

function responseJSON(obj, status) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
