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
    1️⃣ DATABASE SCHEMAS
================================ */
// User Schema
const userSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    accessToken: String,
    refreshToken: String,
    username: String,
    guilds: [String],
    verifiedAt: { type: Date, default: Date.now }
});
const User = mongoose.models.User || mongoose.model('User', userSchema);

// Server Config Schema (For Roles)
const serverSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    verifyRoleId: String,
});
const ServerConfig = mongoose.models.ServerConfig || mongoose.model('ServerConfig', serverSchema);

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
    3️⃣ CALLBACK (WITH AUTO-ROLE)
================================ */
app.get('/callback', async (req, res) => {
    const { code, state } = req.query; // 'state' is the Guild ID
    if (!code) return res.status(400).send("Missing authorization code.");

    if (activeCallbacks.has(code)) return res.status(429).send("Duplicate verification blocked.");
    activeCallbacks.add(code);

    try {
        // Exchange Code for Token
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

        // Fetch User Info
        const userRes = await axios.get('https://discord.com/api/users/@me', { 
            headers: { Authorization: `Bearer ${access_token}` },
            httpsAgent: proxyAgent, proxy: false
        });

        const userId = userRes.data.id;

        // Save to Database
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

        /* --- 🎭 AUTO-ROLE LOGIC --- */
        try {
            const config = await ServerConfig.findOne({ guildId: state });
            if (config && config.verifyRoleId) {
                // Assign role via Discord API
                await axios.put(
                    `https://discord.com/api/v10/guilds/${state}/members/${userId}/roles/${config.verifyRoleId}`,
                    {},
                    {
                        headers: { 
                            Authorization: `Bot ${process.env.BOT_TOKEN}`, // MUST MATCH YOUR .ENV
                            'Content-Type': 'application/json' 
                        }
                    }
                );
                console.log(`[🎭 ROLE] Assigned role ${config.verifyRoleId} to ${userRes.data.username}`);
            }
        } catch (roleErr) {
            console.error("⚠️ Role Assignment Failed (Check Bot Permissions/Hierarchy):", roleErr.response?.data || roleErr.message);
        }

        res.send(`<h1>🛡️ Verified</h1><p>Welcome <b>${userRes.data.username}</b>. You have been verified and assigned your role.</p>`);

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
app.post('/cleanup-user', async (req, res) => {
    try {
        const userId = req.body.user_id;
        if (userId) {
            const deletedUser = await User.findOneAndDelete({ userId: userId });
            if (deletedUser) console.log(`[🗑️ CLEANUP] User ${userId} revoked access. Data wiped.`);
        }
        res.status(204).send();
    } catch (error) {
        console.error('[❌ Cleanup Error]', error);
        res.status(500).send();
    }
});

/* ================================
    5️⃣ START SERVER
=============================== */
mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log("✅ MongoDB Connected");
        app.listen(process.env.PORT || 3000, () => console.log("🚀 Server LIVE (Verification + Roles)"));
    })
    .catch(err => console.error("❌ MongoDB Error:", err));
