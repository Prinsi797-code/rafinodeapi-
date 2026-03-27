/**
 * session-manager.js v2
 * ─────────────────────────────────────────────────────────────
 * Time-based session cache — 4 hours
 * - Pehli request pe login karo
 * - 4 hrs tak same session use karo (koi extra Instagram call nahi)
 * - 4 hrs baad auto re-login
 * - 401 error pe force re-login
 * - Server restart pe session.json se load
 */

const axios  = require("axios");
const fs     = require("fs");
const path   = require("path");

const SESSION_FILE   = path.join(__dirname, "session.json");
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

// ─── In-memory cache ─────────────────────────────────────────
let cachedSession = {
  session_id  : null,
  csrf_token  : null,
  logged_in_at: null,
  username    : null,
};

// ─── Load from file (server restart ke baad bhi kaam kare) ───
function loadSessionFromFile() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
      if (data.session_id) {
        cachedSession = data;
        console.log(`📂 Session loaded from file — @${data.username} (saved: ${data.logged_in_at})`);
        return true;
      }
    }
  } catch (e) {
    console.log("⚠️  Could not read session.json:", e.message);
  }
  return false;
}

function saveSessionToFile(session) {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
    console.log(`💾 Session saved to session.json`);
  } catch (e) {
    console.log("⚠️ Could not write session.json:", e.message);
  }
}

// ─── Time check — koi Instagram API call nahi ─────────────────
function isSessionExpired() {
  if (!cachedSession.session_id || !cachedSession.logged_in_at) return true;

  const loginTime    = new Date(cachedSession.logged_in_at).getTime();
  const ageMs        = Date.now() - loginTime;

  if (ageMs >= SESSION_TTL_MS) {
    const ageHrs = (ageMs / 1000 / 60 / 60).toFixed(1);
    console.log(`⏰ Session expired (${ageHrs} hrs old) — will re-login`);
    return true;
  }

  const remainingMin = Math.round((SESSION_TTL_MS - ageMs) / 1000 / 60);
  console.log(`✅ Cached session @${cachedSession.username} — expires in ${remainingMin} min`);
  return false;
}

// ─── Step 1: Get initial CSRF from login page ─────────────────
async function getInitialCsrf() {
  const res = await axios.get("https://www.instagram.com/accounts/login/", {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
    },
    timeout: 15000,
  });

  const cookies = res.headers["set-cookie"] || [];
  for (const cookie of cookies) {
    const match = cookie.match(/csrftoken=([^;]+)/);
    if (match) return match[1];
  }
  const htmlMatch = res.data.match(/"csrf_token":"([^"]+)"/);
  if (htmlMatch) return htmlMatch[1];
  return "";
}

// ─── Main login function ──────────────────────────────────────
async function instagramLogin() {
  const username = process.env.IG_USERNAME;
  const password = process.env.IG_PASSWORD;

  if (!username || !password) {
    throw new Error(".env me IG_USERNAME aur IG_PASSWORD set karo!");
  }

  console.log(`🔐 Logging in as @${username}...`);

  const initialCsrf = await getInitialCsrf();
  if (!initialCsrf) throw new Error("Could not get CSRF from Instagram login page");

  const loginHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Content-Type": "application/x-www-form-urlencoded",
    "X-CSRFToken": initialCsrf,
    "X-Instagram-AJAX": "1",
    "X-IG-App-ID": "936619743392459",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": "https://www.instagram.com/accounts/login/",
    "Origin": "https://www.instagram.com",
    "Cookie": `csrftoken=${initialCsrf}`,
  };

  const loginPayload = new URLSearchParams({
    username,
    enc_password: `#PWD_INSTAGRAM_BROWSER:0:${Math.floor(Date.now() / 1000)}:${password}`,
    queryParams: "{}",
    optIntoOneTap: "false",
    stopDeletionNonce: "",
    trustedDeviceRecords: "{}",
  });

  let loginRes;
  try {
    loginRes = await axios.post(
      "https://www.instagram.com/accounts/login/ajax/",
      loginPayload.toString(),
      { headers: loginHeaders, timeout: 20000, maxRedirects: 0 }
    );
  } catch (e) {
    if (e.response?.status === 302) {
      loginRes = e.response;
    } else {
      throw new Error(`Login failed: ${e.response?.status} — ${JSON.stringify(e.response?.data)}`);
    }
  }

  const loginData = loginRes.data;

  if (loginData?.checkpoint_url) {
    throw new Error(
      `Instagram checkpoint required. Login manually once from this IP.\n` +
      `URL: https://www.instagram.com${loginData.checkpoint_url}`
    );
  }
  if (loginData?.two_factor_required) {
    throw new Error("2FA is ON. Please disable it in Instagram settings.");
  }
  if (!loginData?.authenticated) {
    throw new Error(`Login failed: ${JSON.stringify(loginData)} — Check IG_USERNAME/IG_PASSWORD`);
  }

  // Extract cookies
  const responseCookies = loginRes.headers["set-cookie"] || [];
  let sessionId = "";
  let csrfToken = initialCsrf;

  for (const cookie of responseCookies) {
    const s = cookie.match(/sessionid=([^;]+)/);
    if (s) sessionId = s[1];
    const c = cookie.match(/csrftoken=([^;]+)/);
    if (c) csrfToken = c[1];
  }

  if (!sessionId) throw new Error("Login ok but sessionid not found in cookies.");

  const session = {
    session_id  : sessionId,
    csrf_token  : csrfToken,
    username,
    logged_in_at: new Date().toISOString(),
  };

  cachedSession = session;
  saveSessionToFile(session);

  console.log(`✅ Login success @${username} — session valid for 4 hrs`);
  return session;
}

// ─── PUBLIC: getSession ───────────────────────────────────────
// Logic:
//  1. Memory empty? → file se load karo
//  2. forceRefresh?  → turant re-login (401 error pe)
//  3. Session < 4hrs? → seedha return (NO Instagram API call)
//  4. Session >= 4hrs? → auto re-login
async function getSession(forceRefresh = false) {
  if (!cachedSession.session_id) {
    loadSessionFromFile();
  }

  if (forceRefresh) {
    console.log("🔄 Force re-login...");
    return await instagramLogin();
  }

  if (cachedSession.session_id && !isSessionExpired()) {
    return cachedSession;
  }

  return await instagramLogin();
}

// ─── PUBLIC: clearSession ─────────────────────────────────────
function clearSession() {
  cachedSession = { session_id: null, csrf_token: null, logged_in_at: null, username: null };
  if (fs.existsSync(SESSION_FILE)) {
    fs.unlinkSync(SESSION_FILE);
    console.log("🗑️  session.json deleted");
  }
}

// Startup pe file se load karo
loadSessionFromFile();
module.exports = { getSession, clearSession, instagramLogin };