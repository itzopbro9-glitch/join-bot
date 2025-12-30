require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent'); // Added for Proxy support

const app = express();

/* ================================
    🛡️ PROXY CONFIGURATION
================================ */
// This uses the PROXY_URL from your Render Environment variables
const proxyUrl = process.env.PROXY_URL;
const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;

/* ================================
    🔐 CALLBACK REPLAY PROTECTION
================================ */
const activeCallbacks = new Set();

/* ================================
    🟢 WARM-UP ROUTE (RENDER SAFE)
================================ */
app.get('/', (req, res) => {
    res.status(200).send('🛡️ Member Shield is online (Bypassing blocks with Proxy)');
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

    if (!guildId) {
        return res.send(
            "<h2>Error</h2><p>Invalid verification link. Missing server ID.</p>"
        );
    }

    const url =
        `https://discord.com/oauth2/authorize` +
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

    // 🔐 BLOCK DUPLICATE CALLBACKS
    if (activeCallbacks.has(code)) {
        return res.status(429).send("Duplicate verification blocked.");
    }
    activeCallbacks.add(code);

    try {
        /* 🔁 TOKEN EXCHANGE (TUNNELED THROUGH PROXY) */
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
                // THIS BYPASSES THE DISCORD RATE LIMIT BLOCK
                httpsAgent: proxyAgent,
                httpAgent: proxyAgent,
                proxy: false // Disables axios' internal proxy logic to use Agent instead
            }
        );

        const { access_token, refresh_token } = tokenRes.data;

        /* 👤 FETCH USER (ALSO THROUGH PROXY) */
        const userRes = await axios.get(
            'https://discord.com/api/users/@me',
            { 
                headers: { Authorization: `Bearer ${access_token}` },
                httpsAgent: proxyAgent,
                httpAgent: proxyAgent,
                proxy: false
            }
        );

        /* 💾 SAVE / UPDATE USER */
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

        /* ✅ SUCCESS UI */
        res.send(`
<!DOCTYPE html>
<html>
<head>
<title>Verification Successful</title>
<style>
body { background:#2c2f33; color:white; font-family:Arial; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; }
.card { background:#23272a; padding:40px; border-radius:16px; text-align:center; border:2px solid #5865F2; box-shadow:0 10px 25px rgba(0,0,0,.5); }
h1 { color:#5865F2; margin-bottom:10px; }
p { color:#b9bbbe; }
.user { background:#36393f; padding:6px 12px; border-radius:6px; color:white; font-weight:bold; }
</style>
</head>
<body>
<div class="card">
  <h1>🛡️ Verified</h1>
  <p>Welcome <span class="user">${userRes.data.username}</span></p>
  <p>Your account has been securely backed up.</p>
  <small>Member Shield System (Proxy Active)</small>
</div>
</body>
</html>
        `);

    } catch (err) {
        console.error("❌ Proxy Verification Error:", err.response?.data || err.message);
        res.status(500).send("Verification failed. Please retry. (Server under heavy load or blocked)");
    } finally {
        // 🔓 RELEASE CALLBACK LOCK AFTER 60s
        setTimeout(() => activeCallbacks.delete(code), 60_000);
    }
});

/* ================================
    4️⃣ DATABASE + SERVER START
================================ */
mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log("✅ MongoDB Connected");
        app.listen(process.env.PORT || 3000, () =>
            console.log("🚀 Proxy-Enabled Server LIVE")
        );
    })
    .catch(err => {
        console.error("❌ MongoDB Error:", err);
    });
