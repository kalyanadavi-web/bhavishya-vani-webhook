const express = require("express");
const axios   = require("axios");
const { google } = require("googleapis");

const app = express();

// ── Credentials from environment variables (never hardcode) ──
const BOT_TOKEN  = process.env.BOT_TOKEN;
const CHAT_ID    = process.env.CHAT_ID;
const SHEET_ID   = process.env.GOOGLE_SHEET_ID;

// Parse Google service account JSON from env var
let serviceAccountKey;
try {
    serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
} catch (e) {
    console.error("FATAL: Could not parse GOOGLE_SERVICE_ACCOUNT_JSON env var:", e.message);
}

// ── Body parser — raw plain text for all routes ──
app.use(express.text({ type: "*/*" }));

// ── Google Sheets auth ──
function getSheetsClient() {
    const auth = new google.auth.GoogleAuth({
        credentials: serviceAccountKey,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    return google.sheets({ version: "v4", auth });
}

// ── Telegram helper ──
async function sendTelegram(message) {
    if (!BOT_TOKEN || !CHAT_ID) {
        console.error("Telegram credentials missing");
        return;
    }
    await axios.post(
        `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
        { chat_id: CHAT_ID, text: message }
    );
}

// ── In-memory retry queue ──
// Map: batchId → { attempts, csv, tabName, isAM, timer, lastError }
const retryQueue = new Map();
const MAX_ATTEMPTS = 3;

async function uploadToSheets(batchId, tabName, csv, isAM) {
    const sheets = getSheetsClient();

    // 1. Check for duplicate in Status tab
    let existingBatches = [];
    try {
        const statusRes = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: "Status!A:A",
        });
        existingBatches = (statusRes.data.values || []).flat();
    } catch (e) {
        // Status tab may not exist yet on first run — that's fine
        console.log("Status tab not found yet, will create on first success.");
    }

    if (existingBatches.includes(batchId)) {
        console.log(`Duplicate ignored: ${batchId}`);
        return { success: true, duplicate: true };
    }

    // 2. Parse CSV rows
    const lines  = csv.trim().split("\n");
    if (lines.length < 2) {
        console.log(`No data rows in batch ${batchId}, skipping.`);
        return { success: true, empty: true };
    }

    // Parse all lines into arrays
    const allRows = lines.map(line => line.split(","));
    const rowCount = allRows.length - 1; // exclude header

    // 3. Ensure day tab exists
    let spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const existingSheets = spreadsheet.data.sheets.map(s => s.properties.title);

    if (!existingSheets.includes(tabName)) {
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: SHEET_ID,
            requestBody: {
                requests: [{
                    addSheet: {
                        properties: { title: tabName }
                    }
                }]
            }
        });
        console.log(`Created tab: ${tabName}`);
    }

    // 4. Check if tab already has data (PM skips header)
    const existingData = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${tabName}!A1:A2`,
    });
    const tabHasData = (existingData.data.values || []).length > 0;

    // AM always writes header + rows
    // PM skips header if tab already has data
    const rowsToWrite = (isAM || !tabHasData) ? allRows : allRows.slice(1);

    // 5. Append rows to day tab
    await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${tabName}!A1`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: rowsToWrite },
    });

    // 6. Write to Status tab — 8 columns:
    // BatchID | Date | Session | Status | Attempts | Rows | LastError | UpdatedAt
    const now       = new Date().toISOString();
    const [dPart, sPart] = batchId.split(/-(?=AM$|PM$)/);
    const attemptsUsed = (retryQueue.get(batchId) || {}).attempts || 1;
    await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: "Status!A:H",
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: {
            values: [[batchId, dPart, sPart, "SUCCESS", attemptsUsed, rowCount, "", now]]
        },
    });

    console.log(`Uploaded ${batchId}: ${rowCount} rows to tab "${tabName}"`);
    return { success: true, rowCount };
}

async function attemptUpload(batchId, tabName, csv, isAM) {
    const entry = retryQueue.get(batchId) || { attempts: 0, csv, tabName, isAM };
    entry.attempts += 1;
    retryQueue.set(batchId, entry);

    try {
        const result = await uploadToSheets(batchId, tabName, csv, isAM);

        if (result.success) {
            retryQueue.delete(batchId);
        }
    } catch (err) {
        console.error(`Upload failed for ${batchId} (attempt ${entry.attempts}):`, err.message);

        if (entry.attempts >= MAX_ATTEMPTS) {
            // All retries exhausted — write FAILED to Status tab, send ONE Telegram alert
            retryQueue.delete(batchId);
            try {
                const now = new Date().toISOString();
                const sheets = getSheetsClient();
                const [dPart, sPart] = batchId.split(/-(?=AM$|PM$)/);
                await sheets.spreadsheets.values.append({
                    spreadsheetId: SHEET_ID,
                    range: "Status!A:H",
                    valueInputOption: "RAW",
                    insertDataOption: "INSERT_ROWS",
                    requestBody: {
                        values: [[batchId, dPart, sPart, "FAILED", entry.attempts, 0, err.message, now]]
                    },
                });
            } catch (sheetErr) {
                console.error("Could not write FAILED status to sheet:", sheetErr.message);
            }
            try {
                await sendTelegram(
                    `BV Logger upload failed permanently.\nBatch: ${batchId}\nError: ${err.message}\nPlease recover using manual backup from TradingView console.`
                );
            } catch (tgErr) {
                console.error("Telegram alert also failed:", tgErr.message);
            }
        } else {
            // Schedule retry — 30 min after attempt 1, 60 min after attempt 2
            const delayMs = entry.attempts === 1 ? 30 * 60 * 1000 : 60 * 60 * 1000;
            console.log(`Retry ${entry.attempts + 1} scheduled for ${batchId} in ${delayMs / 60000} min`);
            if (entry.timer) clearTimeout(entry.timer);
            entry.timer = setTimeout(() => attemptUpload(batchId, tabName, csv, isAM), delayMs);
            retryQueue.set(batchId, entry);
        }
    }
}

// ════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════

// Health check
app.get("/", (req, res) => {
    res.send("Bhavishya Vani Webhook Running");
});

// ── Existing BV signal route — unchanged ──
app.post("/webhook", async (req, res) => {
    try {
        const message = req.body;
        console.log("Signal received:", message);
        await sendTelegram(message);
        res.status(200).send("Alert Sent");
    } catch (error) {
        console.error(error.response?.data || error.message);
        res.status(500).send("Error");
    }
});

// ── BV Metrics Logger route ──
app.post("/webhook/logger", async (req, res) => {
    try {
        const body = req.body;

        if (!body || typeof body !== "string") {
            return res.status(400).send("Empty body");
        }

        // Strip TradingView console timestamp prefix if present
        // TV console adds: [2026-05-29T15:30:00.000+05:30]: before each line
        // Auto alert() payloads from Pine are always clean
        // This stripping only matters for manual paste recovery
        const cleanBody = body.replace(/^\[\d{4}-\d{2}-\d{2}T[\d:.+]+\]:\s*/gm, "").trim();

        // Split batch ID line from CSV content
        const newlineIndex = cleanBody.indexOf("\n");
        if (newlineIndex === -1) {
            return res.status(400).send("Invalid payload format");
        }

        const firstLine = cleanBody.substring(0, newlineIndex).trim();
        const csvContent = cleanBody.substring(newlineIndex + 1).trim();

        // Validate batch ID format: BATCH:YYYY-MM-DD-AM or BATCH:YYYY-MM-DD-PM
        if (!firstLine.startsWith("BATCH:")) {
            return res.status(400).send("Missing BATCH prefix");
        }

        const batchId = firstLine.replace("BATCH:", "").trim();
        const batchMatch = batchId.match(/^(\d{4}-\d{2}-\d{2})-(AM|PM)$/);

        if (!batchMatch) {
            return res.status(400).send("Invalid batch ID format");
        }

        const dateStr = batchMatch[1];   // e.g. 2026-06-02
        const session = batchMatch[2];   // AM or PM
        const isAM    = session === "AM";

        // Build tab name: 02-Jun-2026
        const [year, month, day] = dateStr.split("-");
        const monthNames = ["Jan","Feb","Mar","Apr","May","Jun",
                            "Jul","Aug","Sep","Oct","Nov","Dec"];
        const tabName = `${day}-${monthNames[parseInt(month) - 1]}-${year}`;

        // Holiday guard — no data means no upload
        const csvLines = csvContent.trim().split("\n");
        if (csvLines.length < 2) {
            console.log(`No data in ${batchId}, skipping upload.`);
            return res.status(200).send("No data");
        }

        // Return 200 immediately so TradingView doesn't retry
        // Upload happens asynchronously
        res.status(200).send("Received");

        // Attempt upload (with retry on failure)
        await attemptUpload(batchId, tabName, csvContent, isAM);

    } catch (error) {
        console.error("Logger route error:", error.message);
        // Still return 200 — TV should not retry, our retry logic handles it
        res.status(200).send("Error logged");
    }
});

// Test Telegram
app.get("/test", async (req, res) => {
    try {
        await sendTelegram("Bhavishya Vani Telegram Test Successful");
        res.send("Test Message Sent");
    } catch (error) {
        console.error(error.response?.data || error.message);
        res.send("Error Sending Test Message");
    }
});

// Test Sheets connection
app.get("/test-sheets", async (req, res) => {
    try {
        const sheets = getSheetsClient();
        const result = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
        res.send(`Sheets connected. Title: ${result.data.properties.title}`);
    } catch (error) {
        console.error(error.message);
        res.status(500).send(`Sheets error: ${error.message}`);
    }
});
// ── BB Strategy Logger route ──
app.post("/webhook/bb-strategy", async (req, res) => {
    try {
        const body = req.body;

        if (!body || typeof body !== "string") {
            return res.status(400).send("Empty body");
        }

        // Parse JSON payload from Python script
        let data;
        try {
            data = JSON.parse(body);
        } catch (e) {
            return res.status(400).send("Invalid JSON");
        }

        // Required fields: type and row
        // type: "signal" | "trade" | "daily"
        // row: array of values to append
        const { type, row } = data;

        if (!type || !row || !Array.isArray(row)) {
            return res.status(400).send("Missing type or row");
        }

        // Map type to tab name
        const tabMap = {
            "signal": "BB-Signal-Log",
            "trade":  "BB-Trade-Log",
            "daily":  "BB-Daily-Log",
            "signal_replay": "BB-Signal-Log-Replay",
            "trade_replay":  "BB-Trade-Log-Replay",
            "daily_replay":  "BB-Daily-Log-Replay"
        };
        
        const tabName = tabMap[type];
        if (!tabName) {
            return res.status(400).send(`Unknown type: ${type}`);
        }

        // Append row to correct tab
        const sheets = getSheetsClient();

        const headerMap = {
            "signal": ["Date","Time","Type","Cond#","Cond Name","Spot","Strike","Elig Premium","MaxVol CE","MaxVol PE","Conf Path","Confirmed","Conf Time","Bars Waited","Conf Vol","Surge/Drop %","Spot at Conf","Entry Strike","Strike Changed","Entry Premium","Secondary Disabled","Invalidated Reason"],
            "trade":  ["Date","Type","Entry Strike","Condition","Conf Path","Surge/Drop %","Entry Time","Entry Premium","Initial SL","Lot1 Exit Time","Lot1 Exit Prem","Lot1 Pts","Highest Milestone","Final Lot2 SL","Lot2 Exit Time","Lot2 Exit Prem","Lot2 Exit Reason","Lot2 Pts","Was Armed","Total Pts","Result","Reached 1:1 Time"],
            "daily":  ["Date","Total Elig","Confirmed","Primary","Secondary","Invalidated","Parallel Peak","Strike Changed","Exhaustion Exits","Armed Reversals","Armed Win Rate","Trades","Wins","Losses","Win Rate","Total Pts","Avg Surge Wins","Avg Surge Losses","Best Trade","Worst Trade","Notes"],
            "signal_replay": ["Date","Source","Time","Type","Cond#","Cond Name","Spot","Strike","Conf Path","Conf Vol","Surge/Drop %","Entry Premium","Initial SL","Result","Total Pts","Notes"],
            "trade_replay":  ["Date","Source","Type","Entry Strike","Conf Path","Entry Time","Entry Premium","Initial SL","Exit Time","Exit Premium","Exit Reason","Total Pts","Result"],
            "daily_replay":  ["Date","Source","Total Signals","Confirmed","Primary","Secondary","Wins","Losses","Win Rate","Total Pts","Best Trade","Worst Trade"]
        };

        const existing = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: `${tabName}!A1:A1`,
        });
        const isEmpty = !(existing.data.values && existing.data.values.length > 0);

        const rowsToWrite = [];
        if (isEmpty && headerMap[type]) {
            rowsToWrite.push(headerMap[type]);
        }
        rowsToWrite.push(row);

        await sheets.spreadsheets.values.append({
            spreadsheetId: SHEET_ID,
            range: `${tabName}!A1`,
            valueInputOption: "RAW",
            insertDataOption: "INSERT_ROWS",
            requestBody: { values: rowsToWrite }
        });

        console.log(`BB Strategy: appended ${type} row to ${tabName}`);
        res.status(200).send("OK");

    } catch (error) {
        console.error("BB Strategy logger error:", error.message);
        res.status(500).send("Error");
    }
});

// ── Chartink Alert route (separate bot/group from BV Telegram) ──
app.post("/webhook/chartink", async (req, res) => {
    try {
        const body = req.body;

        if (!body || typeof body !== "string") {
            return res.status(400).send("Empty body");
        }

        let data;
        try {
            data = JSON.parse(body);
        } catch (e) {
            return res.status(400).send("Invalid JSON");
        }

        const { scan_name, stocks, trigger_prices, triggered_at, alert_name } = data;

        const message =
            `${alert_name || scan_name || "Chartink Alert"}\n` +
            `Scan: ${scan_name || "-"}\n` +
            `Stocks: ${stocks || "-"}\n` +
            `Prices: ${trigger_prices || "-"}\n` +
            `Time: ${triggered_at || "-"}`;

        await axios.post(
            `https://api.telegram.org/bot${process.env.CHARTINK_BOT_TOKEN}/sendMessage`,
            { chat_id: process.env.CHARTINK_CHAT_ID, text: message }
        );

        res.status(200).send("OK");
    } catch (error) {
        console.error("Chartink webhook error:", error.response?.data || error.message);
        res.status(500).send("Error");
    }
});

// Test Chartink Telegram route
app.get("/test-chartink", async (req, res) => {
    try {
        await axios.post(
            `https://api.telegram.org/bot${process.env.CHARTINK_BOT_TOKEN}/sendMessage`,
            { chat_id: process.env.CHARTINK_CHAT_ID, text: "Chartink Telegram Test Successful" }
        );
        res.send("Test Message Sent");
    } catch (error) {
        console.error(error.response?.data || error.message);
        res.status(500).send("Error Sending Test Message");
    }
});

app.listen(process.env.PORT || 3000, () => {
    console.log("Bhavishya Vani Server Running");
});