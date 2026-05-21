const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());

const BOT_TOKEN = "8998963894:AAFst6YKbTkTq8FzSuWdNw9eFujFsE0G_jc";
const CHAT_ID = "1145476769";

app.get("/", (req, res) => {
    res.send("Bhavishya Vani Webhook Running");
});

app.post("/webhook", async (req, res) => {

    try {

        console.log(req.body);

        const {
            symbol,
            action,
            price,
            timeframe,
            message
        } = req.body;

        const telegramMessage = `
🚨 Bhavishya Vani Alert

📈 Symbol: ${symbol}
🎯 Signal: ${action}
💰 Price: ${price}
⏰ Timeframe: ${timeframe}

🧠 ${message}
`;

        await axios.post(
            `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
            {
                chat_id: CHAT_ID,
                text: telegramMessage
            }
        );

        res.status(200).send("Alert Sent");

    } catch (error) {

        console.log(error.response?.data || error.message);

        res.status(500).send("Error");
    }
});
// ===================================
// TEST TELEGRAM MESSAGE
// ===================================
app.get("/test", async (req, res) => {

    try {

        await axios.post(
            `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
            {
                chat_id: CHAT_ID,
                text: "✅ Bhavishya Vani Telegram Test Successful"
            }
        );

        res.send("Test Message Sent");

    } catch (error) {

        console.log(error.response?.data || error.message);

        res.send("Error Sending Test Message");
    }
});
app.listen(3000, () => {
    console.log("Server Running on Port 3000");
});