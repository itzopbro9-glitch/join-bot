require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();

/* ================================
    🛡️ MIDDLEWARE (Body Parsers)
================================ */
// MUST BE ABOVE ROUTES to handle Discord Webhooks/Revocations
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ================================
    🛡️ PROXY CONFIGURATION
================================ */
const proxyUrl = process.env.PROXY_URL;
const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;

/* ================================
    🔐 CALLBACK REPLAY PROTECTION
================================ */
const activeCallbacks = new Set();

/* ================================
    🟢 WARM-UP ROUTE
================================ */
app.get('/', (req, res) => {
    res.status(200).send('🛡️ Member Shield is online (Cleanup & Proxy Active)');
});

/* ================================
    1️⃣ DATABASE SCHEMA
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

/* ================================
    2️⃣ VERIFY ENDPOINT
================================ */
app.get('/verify', (req, res) => {
    const guildId = req.query.guild;
    if (!guildId) return res.send("<h2>Error</h2><p>Missing server ID.</p>");

    const url = `https://discord.com/oauth2/authorize` +
        `?client_id=${process.env.CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}` +
        `&response_type=code` +
        `&scope=identify%20guilds.join` +
        `&state=${guildId}`;

    res.redirect(url);
});

/* ================================
    3️⃣ CALLBACK (PROXY INTEGRATED)
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
            { 
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                httpsAgent: proxyAgent,
                httpAgent: proxyAgent,
                proxy: false 
            }
        );

        const { access_token, refresh_token } = tokenRes.data;

        const userRes = await axios.get('https://discord.com/api/users/@me', { 
            headers: { Authorization: `Bearer ${access_token}` },
            httpsAgent: proxyAgent,
            httpAgent: proxyAgent,
            proxy: false
        });

        await User.findOneAndUpdate(
            { userId: userRes.data.id },
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

        res.send(`<h1>🛡️ Verified</h1><p>Welcome <b>${userRes.data.username}</b>. Data secured.</p>`);

    } catch (err) {
        console.error("❌ Error:", err.response?.data || err.message);
        res.status(500).send("Verification failed.");
    } finally {
        setTimeout(() => activeCallbacks.delete(code), 60_000);
    }
});

/* ================================
    4️⃣ 🧹 CLEANUP (DEAUTHORIZATION)
================================ */
// Discord will POST to this URL when a user revokes the app
app.post('/cleanup-user', async (req, res) => {
    try {
        const userId = req.body.user_id;

        if (userId) {
            const result = await User.deleteOne({ userId: userId });
            if (result.deletedCount > 0) {
                console.log(`[🗑️ CLEANUP] User ${userId} deauthorized. Deleted from DB.`);
            }
        }

        // Send 204 (No Content) back to Discord to acknowledge
        res.status(204).send();
    } catch (error) {
        console.error('[❌ Cleanup Error]', error);
        res.status(500).send();
    }
});

/* ================================
    5️⃣ DATABASE + SERVER START
=============================== */
mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log("✅ MongoDB Connected");
        app.listen(process.env.PORT || 3000, () => console.log("🚀 Server LIVE with Cleanup Route"));
    })
    .catch(err => console.error("❌ MongoDB Error:", err));
