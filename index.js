const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const app = express();

// 1. The Database Schema (The "Vault" format)
const User = mongoose.model('User', new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    accessToken: String,
    refreshToken: String,
    username: String
}));

// 2. The Verification Link
app.get('/verify', (req, res) => {
    const url = `https://discord.com/oauth2/authorize?client_id=${process.env.CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}&response_type=code&scope=identify%20guilds.join`;
    res.redirect(url);
});

// 3. The Callback (Where Discord sends the user back)
app.get('/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.send("No code provided.");

    try {
        // Trade 'code' for Tokens
        const response = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
            client_id: process.env.CLIENT_ID,
            client_secret: process.env.CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: process.env.REDIRECT_URI,
        }));

        const { access_token, refresh_token } = response.data;

        // Get User ID to know WHO they are
        const userRes = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${access_token}` }
        });

        // SAVE to MongoDB (This links to your WispByte Bot)
        await User.findOneAndUpdate(
            { userId: userRes.data.id },
            { accessToken: access_token, refreshToken: refresh_token, username: userRes.data.username },
            { upsert: true }
        );

        res.send("✅ Success! You are now backed up. You can close this tab.");
    } catch (err) {
        console.error(err.response?.data || err.message);
        res.status(500).send("Verification failed.");
    }
});

// 4. Start Server
mongoose.connect(process.env.MONGO_URI).then(() => {
    app.listen(process.env.PORT || 3000, () => console.log("Web Door Ready!"));
});
