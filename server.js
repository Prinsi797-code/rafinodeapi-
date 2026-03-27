require("dotenv").config();
const express    = require("express");
const axios      = require("axios");
const rateLimit  = require("express-rate-limit");
const { getSession, clearSession } = require("./session-manager");

const app = express();
app.use(express.json());

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { success: "error", message: "Too many requests. Please wait a minute." },
});
app.use(limiter);

// ─── Helpers ──────────────────────────────────────────────────
function extractShortcode(url) {
  const patterns = [
    /instagram\.com\/reels?\/([A-Za-z0-9_-]+)/,
    /instagram\.com\/p\/([A-Za-z0-9_-]+)/,
    /instagram\.com\/tv\/([A-Za-z0-9_-]+)/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function shortcodeToMediaId(shortcode) {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let id = BigInt(0);
  for (const c of shortcode) id = id * BigInt(64) + BigInt(alpha.indexOf(c));
  return id.toString();
}

function buildHeaders(sessionId, csrfToken, userAgent) {
  return {
    "User-Agent": userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "X-IG-App-ID": "936619743392459",
    "X-ASBD-ID": "129477",
    "X-CSRFToken": csrfToken || "",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": "https://www.instagram.com/",
    "Origin": "https://www.instagram.com",
    "Cookie": `sessionid=${sessionId}; csrftoken=${csrfToken || ""}`,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "Connection": "keep-alive",
  };
}

function formatComment(comment) {
  const username = comment.user?.username || "";
  return {
    id: comment.pk || comment.id,
    text: comment.text || "",
    created_at: comment.created_at || comment.created_at_utc || 0,
    like_count: comment.comment_like_count || 0,
    user: {
      username,
      profile_pic_url: comment.user?.profile_pic_url || "",
      profile_url: username ? `https://www.instagram.com/${username}` : "",
      is_verified: comment.user?.is_verified || false,
    },
    replies: (comment.preview_child_comments || []).map((r) => {
      const ru = r.user?.username || "";
      return {
        id: r.pk || r.id,
        text: r.text || "",
        created_at: r.created_at || 0,
        like_count: r.comment_like_count || 0,
        user: {
          username: ru,
          profile_pic_url: r.user?.profile_pic_url || "",
          profile_url: ru ? `https://www.instagram.com/${ru}` : "",
          is_verified: r.user?.is_verified || false,
        },
      };
    }),
  };
}

function filterUniqueUsers(comments) {
  const seen = new Set();
  return comments.filter((c) => {
    const u = c.user?.username;
    if (u && seen.has(u)) return false;
    if (u) seen.add(u);
    return true;
  });
}

// ─── Fetch comments with auto session-retry ───────────────────
async function fetchAllComments(mediaId, headers, maxComments, delayMs, session) {
  const allComments = [];
  let nextMinId = null;
  let pageCount  = 0;
  let hasMore    = true;
  let retried    = false;

  while (hasMore && allComments.length < maxComments) {
    pageCount++;
    const params = new URLSearchParams({ can_support_threading: "true", permalink_enabled: "false" });
    if (nextMinId) params.set("min_id", nextMinId);

    try {
      const response = await axios.get(
        `https://www.instagram.com/api/v1/media/${mediaId}/comments/?${params}`,
        { headers, timeout: 15000 }
      );
      const data     = response.data;
      const comments = data.comments || [];

      for (const c of comments) {
        allComments.push(formatComment(c));
        if (allComments.length >= maxComments) break;
      }

      const cursor = data.next_min_id || data.next_max_id;
      if (cursor && comments.length > 0 && allComments.length < maxComments) {
        nextMinId = cursor;
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        hasMore = false;
      }

    } catch (err) {
      const status = err.response?.status;

      if ((status === 401 || status === 403) && !retried) {
        console.log("⚠️  Session expired mid-scrape. Auto-refreshing...");
        retried = true;
        const newSession = await getSession(true);
        const newHeaders = buildHeaders(newSession.session_id, newSession.csrf_token);
        Object.assign(headers, newHeaders);
        pageCount--;
        continue;
      }

      if (status === 429)  throw new Error("Instagram rate limited. Try after some time.");
      if (status === 401)  throw new Error("Session expired and re-login also failed. Check IG_USERNAME/IG_PASSWORD in .env");
      if (status === 404)  throw new Error("Post not found or is private.");
      throw new Error(`Instagram API error: ${err.message}`);
    }
  }

  return { comments: allComments, pages_fetched: pageCount };
}

// ─── fetchMediaInfo: 3 fallback methods ──────────────────────
async function fetchMediaInfo(mediaId, shortcode, headers) {
  try {
    const res = await axios.get(`https://i.instagram.com/api/v1/media/${mediaId}/info/`, {
      headers: {
        ...headers,
        "Host": "i.instagram.com",
        "User-Agent": "Instagram 269.0.0.18.75 Android (26/8.0.0; 480dpi; 1080x1920; OnePlus; 6T Dev; devitron; qcom; en_US; 314665256)",
      },
      timeout: 10000,
    });
    const item = res.data?.items?.[0];
    if (item?.user?.username) return item;
  } catch (e) {
    console.log(`⚠️  MediaInfo M1 failed: ${e.response?.status || e.message}`);
  }

  try {
    const res = await axios.get(`https://www.instagram.com/p/${shortcode}/?__a=1&__d=dis`, {
      headers: { ...headers, "Accept": "application/json, text/plain, */*" },
      timeout: 10000,
    });
    const item = res.data?.items?.[0] || res.data?.graphql?.shortcode_media;
    if (item) {
      if (item.__typename) {
        return {
          media_type: item.__typename === "GraphVideo" ? 2 : 1,
          caption: { text: item.edge_media_to_caption?.edges?.[0]?.node?.text || "" },
          comment_count: item.edge_media_to_comment?.count || 0,
          user: { username: item.owner?.username || "", profile_pic_url: item.owner?.profile_pic_url || "", is_verified: item.owner?.is_verified || false },
        };
      }
      return item;
    }
  } catch (e) {
    console.log(`⚠️  MediaInfo M2 failed: ${e.response?.status || e.message}`);
  }

  try {
    const res = await axios.get(`https://www.instagram.com/api/v1/media/${mediaId}/info/`, { headers, timeout: 10000 });
    const item = res.data?.items?.[0];
    if (item) return item;
  } catch (e) {
    console.log(`⚠️  MediaInfo M3 failed: ${e.response?.status || e.message}`);
  }

  return null;
}

// ─── Build final response ─────────────────────────────────────
function buildResponse(rawComments, pages_fetched, mediaInfo, unique_users) {
  const finalComments  = unique_users ? filterUniqueUsers(rawComments) : rawComments;
  const ownerUsername  = mediaInfo?.user?.username || "";
  const mediaType      = mediaInfo?.media_type;
  return {
    success: "success",
    message: "Post details get successfully",
    platform: "instagram",
    type: mediaType === 2 ? "video" : mediaType === 1 ? "image" : "video",
    caption: mediaInfo?.caption?.text || "",
    posted_by: {
      username: ownerUsername,
      profile_pic_url: mediaInfo?.user?.profile_pic_url || "",
      profile_url: ownerUsername ? `https://www.instagram.com/${ownerUsername}` : "",
      is_verified: mediaInfo?.user?.is_verified || false,
    },
    comments_count:    mediaInfo?.comment_count || rawComments.length,
    comments_fetched:  finalComments.length,
    duplicates_removed: unique_users ? rawComments.length - finalComments.length : 0,
    pages_fetched,
    comments: finalComments,
  };
}

// ═══════════════════════════════════════════════════════════════
// WINNER ROUTE SETUP
// winner.js ko Instagram helper functions pass karo app.locals se
// ═══════════════════════════════════════════════════════════════
app.locals.instagramHelpers = {
  extractShortcode,
  shortcodeToMediaId,
  buildHeaders,
  fetchAllComments,
  fetchMediaInfo,
};

const winnerRouter = require("./winner");
app.use("/", winnerRouter);

// ═══════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════

// ─── POST /scrape/comments ────────────────────────────────────
app.post("/scrape/comments", async (req, res) => {
  const {
    url,
    max_comments  = 5000,
    delay_ms      = 1200,
    unique_users  = true,
    session_id: manualSession,
    csrf_token:  manualCsrf,
  } = req.body;

  if (!url) return res.status(400).json({ success: "error", message: "url is required" });

  const shortcode = extractShortcode(url);
  if (!shortcode) return res.status(400).json({ success: "error", message: "Invalid Instagram Reel/Post URL" });

  const mediaId = shortcodeToMediaId(shortcode);

  try {
    let session;
    if (manualSession) {
      session = { session_id: manualSession, csrf_token: manualCsrf || "" };
    } else {
      session = await getSession();
    }

    const headers = buildHeaders(session.session_id, session.csrf_token);

    const [{ comments: rawComments, pages_fetched }, mediaInfo] = await Promise.all([
      fetchAllComments(mediaId, headers, parseInt(max_comments), parseInt(delay_ms), session),
      fetchMediaInfo(mediaId, shortcode, headers),
    ]);

    return res.json(buildResponse(rawComments, pages_fetched, mediaInfo, unique_users));

  } catch (err) {
    return res.status(500).json({ success: "error", message: err.message });
  }
});

// ─── GET /scrape/comments ─────────────────────────────────────
app.get("/scrape/comments", async (req, res) => {
  const { url, max_comments = 5000, delay_ms = 1200, unique_users = "true" } = req.query;

  if (!url) return res.status(400).json({ success: "error", message: "url is required" });

  const shortcode = extractShortcode(url);
  if (!shortcode) return res.status(400).json({ success: "error", message: "Invalid URL" });

  const mediaId = shortcodeToMediaId(shortcode);

  try {
    const session = await getSession();
    const headers = buildHeaders(session.session_id, session.csrf_token);

    const [{ comments: rawComments, pages_fetched }, mediaInfo] = await Promise.all([
      fetchAllComments(mediaId, headers, parseInt(max_comments), parseInt(delay_ms), session),
      fetchMediaInfo(mediaId, shortcode, headers),
    ]);

    return res.json(buildResponse(rawComments, pages_fetched, mediaInfo, unique_users !== "false"));

  } catch (err) {
    return res.status(500).json({ success: "error", message: err.message });
  }
});

// ─── POST /auth/refresh ───────────────────────────────────────
app.post("/auth/refresh", async (req, res) => {
  try {
    clearSession();
    const session = await getSession(true);
    return res.json({
      success: "success",
      message: `Re-logged in as @${session.username}`,
      logged_in_at: session.logged_in_at,
    });
  } catch (err) {
    return res.status(500).json({ success: "error", message: err.message });
  }
});

// ─── GET /auth/status ─────────────────────────────────────────
app.get("/auth/status", async (req, res) => {
  try {
    const session = await getSession();
    return res.json({
      success: "success",
      logged_in: !!session.session_id,
      username: session.username,
      logged_in_at: session.logged_in_at,
    });
  } catch (err) {
    return res.status(500).json({ success: "error", logged_in: false, message: err.message });
  }
});

// ─── POST /scrape/post-info ───────────────────────────────────
app.post("/scrape/post-info", async (req, res) => {
  const { url } = req.body;

  if (!url) return res.status(400).json({ success: "error", message: "url is required" });

  const shortcode = extractShortcode(url);
  if (!shortcode) return res.status(400).json({ success: "error", message: "Invalid Instagram Reel/Post URL" });

  const mediaId = shortcodeToMediaId(shortcode);

  try {
    const session = await getSession();
    const headers = buildHeaders(session.session_id, session.csrf_token);
    const mediaInfo = await fetchMediaInfo(mediaId, shortcode, headers);

    if (!mediaInfo) {
      return res.status(404).json({ success: "error", message: "Post not found or could not fetch details." });
    }

    const ownerUsername = mediaInfo?.user?.username || "";

    return res.json({
      success: "success",
      message: "Post details get successfully",
      platform: "instagram",
      type: mediaInfo?.media_type === 2 ? "video" : "image",
      caption: mediaInfo?.caption?.text || "",
      posted_by: {
        username: ownerUsername,
        profile_pic_url: mediaInfo?.user?.profile_pic_url || "",
        profile_url: ownerUsername ? `https://www.instagram.com/${ownerUsername}` : "",
        is_verified: mediaInfo?.user?.is_verified || false,
      },
      comments_count: mediaInfo?.comment_count || 0,
      like_count: mediaInfo?.like_count || 0,
      view_count: mediaInfo?.play_count || mediaInfo?.view_count || 0,
      taken_at: mediaInfo?.taken_at || 0,
      media_id: mediaId,
      shortcode,
    });

  } catch (err) {
    return res.status(500).json({ success: "error", message: err.message });
  }
});

// ─── Health check ─────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    name: "Instagram Reels Comment Scraper API",
    version: "3.0.0",
    note: "Session auto-managed — no session_id needed in requests",
    endpoints: {
      "POST /winner":           "Pick giveaway winners (DB + coin logic)",
      "POST /scrape/comments":  "Scrape comments (just send url)",
      "GET  /scrape/comments":  "Same via ?url=...",
      "POST /scrape/post-info": "Post details only",
      "GET  /auth/status":      "Check login status",
      "POST /auth/refresh":     "Force re-login",
    },
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Instagram Scraper API v3 running on http://localhost:${PORT}`));