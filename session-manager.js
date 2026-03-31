/**
 * session-manager.js v3
 * ─────────────────────────────────────────────────────────────
 * Reads session from session.json (created by login_final.py)
 * - Python script se session.json banao (playwright se)
 * - Ye file us session ko use karti hai
 * - 4 hrs baad console me warning deta hai (re-run python script)
 * - 401 error pe bhi file se reload karta hai
 */

const fs   = require("fs");
const path = require("path");

const SESSION_FILE   = path.join(__dirname, "session.json");
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

let cachedSession = {
  session_id  : null,
  csrf_token  : null,
  logged_in_at: null,
  username    : null,
};

// ─── Load from file ───────────────────────────────────────────
function loadSessionFromFile() {
  try {
    if (!fs.existsSync(SESSION_FILE)) {
      console.error("❌ session.json not found! Run: python3 login_final.py");
      return false;
    }

    const data = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));

    // session_id directly in root (Python script format)
    const sessionId = data.session_id;
    const csrfToken = data.csrf_token;

    if (!sessionId) {
      console.error("❌ session.json has no session_id! Re-run: python3 login_final.py");
      return false;
    }

    // URL-decode if needed (Python saves it as %3A encoded)
    cachedSession = {
      session_id  : decodeURIComponent(sessionId),
      csrf_token  : csrfToken || "",
      username    : data.username || "",
      logged_in_at: data.logged_in_at || new Date().toISOString(),
    };

    console.log(`📂 Session loaded — @${cachedSession.username} (saved: ${cachedSession.logged_in_at})`);
    return true;

  } catch (e) {
    console.error("❌ Could not read session.json:", e.message);
    return false;
  }
}

// ─── Time check ───────────────────────────────────────────────
function isSessionExpired() {
  if (!cachedSession.session_id || !cachedSession.logged_in_at) return true;

  const loginTime    = new Date(cachedSession.logged_in_at).getTime();
  const ageMs        = Date.now() - loginTime;

  if (ageMs >= SESSION_TTL_MS) {
    const ageHrs = (ageMs / 1000 / 60 / 60).toFixed(1);
    console.warn(`⏰ Session is ${ageHrs} hrs old — run: python3 login_final.py`);
    // Don't block — still try to use it, Instagram sessions last longer than 4hrs
    return false;
  }

  const remainingMin = Math.round((SESSION_TTL_MS - ageMs) / 1000 / 60);
  console.log(`✅ Session @${cachedSession.username} — ${remainingMin} min until refresh reminder`);
  return false;
}

// ─── PUBLIC: getSession ───────────────────────────────────────
async function getSession(forceRefresh = false) {
  if (forceRefresh || !cachedSession.session_id) {
    console.log("🔄 Reloading session from session.json...");
    const ok = loadSessionFromFile();
    if (!ok) {
      throw new Error(
        "No valid session found. Run 'python3 login_final.py' on the server to login."
      );
    }
  }

  isSessionExpired(); // just logs warning, doesn't block

  return cachedSession;
}

// ─── PUBLIC: clearSession ─────────────────────────────────────
function clearSession() {
  cachedSession = { session_id: null, csrf_token: null, logged_in_at: null, username: null };
  console.log("🗑️  In-memory session cleared (session.json kept — re-run python script to refresh)");
}

// ─── Startup load ─────────────────────────────────────────────
loadSessionFromFile();

module.exports = { getSession, clearSession };