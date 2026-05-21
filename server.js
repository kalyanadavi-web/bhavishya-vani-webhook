const express = require("express");
const axios = require("axios");
const app = express();

const BOT_TOKEN = "8998963894:AAFst6YKbTkTq8FzSuWdNw9eFujFsE0G_jc";
const CHAT_ID = "-1003746589873";

// Read raw plain text — NOT express.json()
app.use(express.text({ type: '*/*' }));

app.get("/", (req, res) => {
    res.send("Bhavishya Vani Webhook Running");
});

app.post("/webhook", async (req, res) => {
    try {
        const message = req.body;
        console.log("Received:", message);

        await axios.post(
            `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
            {
                chat_id: CHAT_ID,
                text: message
            }
        );
        res.status(200).send("Alert Sent");
    } catch (error) {
        console.log(error.response?.data || error.message);
        res.status(500).send("Error");
    }
});

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

app.listen(process.env.PORT || 3000, () => {
    console.log("Server Running");
});