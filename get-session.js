#!/usr/bin/env node
/**
 * get-session.js
 * ─────────────────────────────────────────────────────────────
 * Run this script once to verify your session_id is working.
 *
 * Usage:
 *   node get-session.js YOUR_SESSION_ID
 *
 * How to get your Instagram sessionid:
 *   1. Open instagram.com in Chrome/Firefox
 *   2. Log in to your account
 *   3. Press F12 → Application tab → Cookies → instagram.com
 *   4. Copy the value of "sessionid"
 *   5. Also copy "csrftoken" value
 */

const axios = require("axios");

const sessionId = process.argv[2];
if (!sessionId) {
  console.error("Usage: node get-session.js YOUR_SESSION_ID");
  process.exit(1);
}

async function verifySession(sessionId) {
  try {
    const response = await axios.get("https://www.instagram.com/api/v1/accounts/current_user/?edit=true", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "X-IG-App-ID": "936619743392459",
        "Cookie": `sessionid=${sessionId}`,
        "Referer": "https://www.instagram.com/",
      },
    });

    const user = response.data?.user;
    if (user) {
      console.log("\n✅ Session is VALID!");
      console.log(`👤 Logged in as: @${user.username} (${user.full_name})`);
      console.log(`🔑 Session ID: ${sessionId}`);
    } else {
      console.log("❌ Session might be invalid or expired.");
    }
  } catch (err) {
    if (err.response?.status === 401) {
      console.error("❌ Session is INVALID or EXPIRED. Please get a fresh sessionid.");
    } else {
      console.error("Error:", err.message);
    }
  }
}

verifySession(sessionId);