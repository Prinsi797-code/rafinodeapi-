// winner.js
// POST /winner — DB coin flow + Instagram giveaway winner picker

const express = require("express");
const mysql   = require("mysql2/promise");
const { getSession } = require("./session-manager");

const router = express.Router();

// ─── DB Pool ──────────────────────────────────────────────────
const pool = mysql.createPool({
  host    : process.env.DB_HOST || "localhost",
  port    : parseInt(process.env.DB_PORT || "3306"),
  user    : process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "instagram_db",
  waitForConnections: true,
  connectionLimit   : 10,
});

// ─── DB Helpers ───────────────────────────────────────────────
async function getUserByDeviceId(device_id) {
  const [rows] = await pool.execute(
    "SELECT * FROM users WHERE device_id = ? LIMIT 1",
    [device_id]
  );
  return rows[0] || null;
}

async function getSettings() {
  const [rows] = await pool.execute(
    "SELECT coins, giveaway FROM settings WHERE id = 1 LIMIT 1"
  );
  return rows[0] || null;
}

async function updateUserCoinsAndRun(device_id, new_coin_count, run) {
  const [result] = await pool.execute(
    "UPDATE users SET coin_count = ?, run = ? WHERE device_id = ?",
    [new_coin_count, run, device_id]
  );
  return result.affectedRows > 0;
}

async function saveGiveawayLog(user_id, device_id, run) {
  const [rows] = await pool.execute(
    `SELECT giveaway_count FROM giveaway_logs
     WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
    [user_id]
  );
  const newCount = (rows[0]?.giveaway_count || 0) + 1;

  await pool.execute(
    `INSERT INTO giveaway_logs (user_id, device_id, giveaway_count, run, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [user_id, device_id, newCount, run, new Date()]
  );
  return newCount;
}

// ─── Comment Helpers ──────────────────────────────────────────
function applyKeywordFilter(comments, keyword) {
  if (!keyword || keyword.trim() === "") return comments;
  const kw = keyword.trim().toLowerCase();
  const filtered = comments.filter(c => c.text?.toLowerCase().includes(kw));
  return filtered.length > 0 ? filtered : comments;
}

function filterUniqueUsers(comments) {
  const seen = new Set();
  return comments.filter(c => {
    const u = c.user?.username;
    if (!u || seen.has(u)) return false;
    seen.add(u);
    return true;
  });
}

function selectRandomComments(comments, winnerCount, substituteCount) {
  const list = [...comments];
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return {
    winners    : list.slice(0, winnerCount),
    substitutes: list.slice(winnerCount, winnerCount + substituteCount),
  };
}

// ─── POST /winner ─────────────────────────────────────────────
router.post("/winner", async (req, res) => {
  const {
    postUrl,
    maxComments      = 100,
    winnerCount      = 1,
    substitutesCount = 0,
    singleUser       = 0,
    searchKeyword    = "",
    device_id,
    run              = 0,
  } = req.body;

  if (!postUrl)   return res.status(400).json({ error: true, message: "postUrl is required" });
  if (!device_id) return res.status(400).json({ error: true, message: "device_id is required" });
  if (![0, 1, 2].includes(Number(run))) {
    return res.status(400).json({ error: true, message: "run must be 0, 1 or 2" });
  }

  const runNum = Number(run);

  const {
    extractShortcode,
    shortcodeToMediaId,
    buildHeaders,
    fetchAllComments,
    fetchMediaInfo,
  } = req.app.locals.instagramHelpers;

  try {
    // Step 1: User check
    const user = await getUserByDeviceId(device_id);
    if (!user) {
      return res.status(404).json({ error: true, message: "Device ID not found" });
    }

    // Step 2: Settings
    const settings = await getSettings();
    if (!settings) {
      return res.status(500).json({ error: true, message: "Failed to load settings" });
    }

    // Step 3: Coin check
    const deductionAmount = runNum === 2 ? 0 : settings.giveaway;
    if (user.coin_count < deductionAmount) {
      return res.status(400).json({
        error         : true,
        message       : `Insufficient coins. You need at least ${deductionAmount} coins.`,
        coin_count    : user.coin_count,
        required_coins: deductionAmount,
      });
    }

    // Step 4: URL parse
    const shortcode = extractShortcode(postUrl);
    if (!shortcode) {
      return res.status(400).json({ error: true, message: "Invalid Instagram URL" });
    }
    const mediaId = shortcodeToMediaId(shortcode);

    // Step 5: Instagram fetch
    const session = await getSession();
    const headers = buildHeaders(session.session_id, session.csrf_token);

    const [{ comments: rawComments }, mediaInfo] = await Promise.all([
      fetchAllComments(mediaId, headers, Number(maxComments), 1200, session),
      fetchMediaInfo(mediaId, shortcode, headers),
    ]);

    if (!rawComments || rawComments.length === 0) {
      return res.status(400).json({ error: true, message: "No comments found on this post" });
    }

    // Step 6: Filter
    let workingComments = applyKeywordFilter(rawComments, searchKeyword);
    if (Number(singleUser) === 1) {
      workingComments = filterUniqueUsers(workingComments);
    }

    // Step 7: Count check
    const totalRequired = Number(winnerCount) + Number(substitutesCount);
    if (workingComments.length < totalRequired) {
      return res.status(400).json({
        error    : true,
        message  : `Not enough ${Number(singleUser) === 1 ? "unique users" : "comments"}. `
                 + `Available: ${workingComments.length}, Required: ${totalRequired}`,
        available: workingComments.length,
        required : totalRequired,
      });
    }

    // Step 8: Random pick
    const { winners, substitutes } = selectRandomComments(
      workingComments,
      Number(winnerCount),
      Number(substitutesCount)
    );

    // Step 9: Coins deduct
    let finalCoinCount = user.coin_count;
    if (deductionAmount > 0) {
      const newCoinCount = user.coin_count - deductionAmount;
      await updateUserCoinsAndRun(device_id, newCoinCount, runNum);
      finalCoinCount = newCoinCount;
    } else {
      await updateUserCoinsAndRun(device_id, user.coin_count, runNum);
    }

    // Step 10: Giveaway log
    await saveGiveawayLog(user.id, device_id, runNum);

    // Step 11: Response — exact format
    return res.json({
      success         : "success",
      message         : "winner get successfully",
      platform        : "instagram",
      comments_count  : mediaInfo?.comment_count || rawComments.length,
      comments_fetched: rawComments.length,
      winners,
      substitutes,
      coin_count      : finalCoinCount,
      run             : runNum,
    });

  } catch (err) {
    console.error("❌ /winner error:", err);
    return res.status(500).json({ error: true, message: err.message || err.toString() });
  }
});

module.exports = router;