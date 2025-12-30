require('dotenv').config(); 
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const app = express();

// 1️⃣ DATABASE SCHEMA (Synchronized with Wispbyte Bot)
const userSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    accessToken: String,
    refreshToken: String,
    username: String,
    guilds: [String], // Array to track multiple servers per user
    verifiedAt: { type: Date, default: Date.now }
});

// Avoid "OverwriteModelError" if Render restarts
const User = mongoose.models.User || mongoose.model('User', userSchema);

// 2️⃣ VERIFY ENDPOINT
app.get('/verify', (req, res) => {
    const guildId = req.query.guild;
    if (!guildId) {
        return res.send("<h2>Error: Invalid Link</h2><p>This verification link is missing the Server ID. Please contact the server owner.</p>");
    }

    // Pass guildId into 'state' so Discord returns it to the callback
    const url = `https://discord.com/oauth2/authorize?client_id=${process.env.CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}&response_type=code&scope=identify%20guilds.join&state=${guildId}`;
    res.redirect(url);
});

// 3️⃣ CALLBACK & DATA SAVING
app.get('/callback', async (req, res) => {
    const { code, state } = req.query; // state contains the guildId
    if (!code) return res.send("No authorization code provided.");

    try {
        // Trade code for tokens
        const response = await axios.post(
            'https://discord.com/api/oauth2/token',
            new URLSearchParams({
                client_id: process.env.CLIENT_ID,
                client_secret: process.env.CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: process.env.REDIRECT_URI
            }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        const { access_token, refresh_token } = response.data;

        // Get user info
        const userRes = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${access_token}` }
        });

        // ✅ SYNCED SAVE LOGIC: Links user to the server list
        await User.findOneAndUpdate(
            { userId: userRes.data.id },
            {
                $set: {
                    accessToken: access_token,
                    refreshToken: refresh_token,
                    username: userRes.data.username,
                    verifiedAt: new Date()
                },
                $addToSet: { guilds: state } // Adds server ID to the array if not already there
            },
            { upsert: true }
        );

        // ✅ Success UI
        res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Verification Successful</title>
            <style>
                body { background-color: #2c2f33; color: white; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                .card { background-color: #23272a; padding: 50px; border-radius: 20px; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border: 2px solid #5865F2; max-width: 400px; }
                .icon { font-size: 60px; margin-bottom: 20px; filter: drop-shadow(0 0 10px #5865F2); }
                h1 { margin: 0; font-size: 28px; color: #5865F2; }
                p { color: #b9bbbe; line-height: 1.6; margin-top: 15px; }
                .username { color: #ffffff; font-weight: bold; background: #36393f; padding: 5px 12px; border-radius: 5px; }
                .footer { margin-top: 30px; font-size: 12px; opacity: 0.6; }
            </style>
        </head>
        <body>
            <div class="card">
                <div class="icon">🛡️</div>
                <h1>Verification Success</h1>
                <p>Identity confirmed for <span class="username">${userRes.data.username}</span>.</p>
                <p>Your account is now securely backed up in this server's vault. You can safely close this window.</p>
                <div class="footer">Member Shield System &bull; Protected Server</div>
            </div>
        </body>
        </html>
        `);

    } catch (err) {
        console.error("Verification Error:", err.response?.data || err.message || err);
        res.status(500).send("Verification failed. Please try again.");
    }
});

// 4️⃣ DATABASE CONNECTION (Cleaned & Fixed)
mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log("✅ Database Connected Successfully");
        app.listen(process.env.PORT || 3000, () => console.log("🚀 Render Web Server is LIVE"));
    })
    .catch(err => {
        console.error("❌ Database Connection Failed:", err);
    });
