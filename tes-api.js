#!/usr/bin/env node
/**
 * test-api.js — Quick test for Instagram Scraper API
 * Run: node test-api.js
 * Make sure server is running first: node server.js
 */

const axios = require("axios");

const BASE_URL = "http://localhost:3000";

// ─── CHANGE THESE ─────────────────────────────────────────────
const TEST_REEL_URL = "https://www.instagram.com/reel/YOUR_REEL_ID_HERE/";
const SESSION_ID    = "YOUR_SESSION_ID_HERE";
const CSRF_TOKEN    = "YOUR_CSRF_TOKEN_HERE";   // From cookies
// ──────────────────────────────────────────────────────────────

async function testHealthCheck() {
  console.log("\n🔍 Testing health check...");
  const res = await axios.get(`${BASE_URL}/`);
  console.log("✅ Server is up:", res.data.name);
}

async function testMediaInfo() {
  console.log("\n🎬 Fetching media info...");
  const res = await axios.post(`${BASE_URL}/scrape/media-info`, {
    url: TEST_REEL_URL,
    session_id: SESSION_ID,
    csrf_token: CSRF_TOKEN,
  });
  console.log("✅ Media Info:", JSON.stringify(res.data, null, 2));
}

async function testScrapeComments() {
  console.log("\n💬 Scraping comments (max 100 for test)...");
  const res = await axios.post(`${BASE_URL}/scrape/comments`, {
    url: TEST_REEL_URL,
    session_id: SESSION_ID,
    csrf_token: CSRF_TOKEN,
    max_comments: 100,   // Change to 5000 for full scrape
    delay_ms: 1200,
  });

  const data = res.data;
  console.log(`\n✅ Done!`);
  console.log(`📊 Total comments fetched: ${data.total_comments_fetched}`);
  console.log(`📄 Pages fetched: ${data.pages_fetched}`);
  console.log(`⏱️  Time taken: ${data.elapsed_seconds}s`);

  if (data.comments?.length > 0) {
    console.log("\n--- First comment sample ---");
    console.log(JSON.stringify(data.comments[0], null, 2));
  }
}

(async () => {
  try {
    await testHealthCheck();
    await testMediaInfo();
    await testScrapeComments();
  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);
  }
})();