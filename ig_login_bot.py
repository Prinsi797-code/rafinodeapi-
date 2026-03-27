import asyncio
import json
import os
from datetime import datetime
from playwright.async_api import async_playwright

IG_USERNAME = os.environ.get("IG_USERNAME", "hevinp6")
IG_PASSWORD = os.environ.get("IG_PASSWORD", "Hevin@123")
SESSION_FILE = "session.json"
PROXY = None
# Server pe use karna ho to yeh uncomment karo:
# PROXY = {
#     "server": "http://23.95.150.145:6114",
#     "username": "jfnfwvzy",
#     "password": "30ev5vksf7ko"
# }

async def fill_input(page, selector, value):
    await page.locator(selector).first.click()
    await page.locator(selector).first.fill("")
    await page.evaluate("""
        ([sel, val]) => {
            const input = document.querySelector(sel);
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
            ).set;
            nativeInputValueSetter.call(input, val);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
    """, [selector, value])
    await asyncio.sleep(0.5)

async def login():
    print("🌐 Starting browser...")
    async with async_playwright() as p:
        launch_args = {
            "headless": True,
            "args": [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-blink-features=AutomationControlled",
            ]
        }
        if PROXY:
            launch_args["proxy"] = PROXY

        browser = await p.chromium.launch(**launch_args)
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 800},
            locale="en-US",
        )
        await context.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
            Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3]});
            Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
        """)
        page = await context.new_page()

        print("📱 Opening Instagram...")
        await page.goto("https://www.instagram.com/accounts/login/", wait_until="networkidle")
        await asyncio.sleep(5)

        print("📋 Page title:", await page.title())

        # Cookie popup
        try:
            accept_btn = page.locator("text=Allow all cookies")
            if await accept_btn.count() > 0:
                await accept_btn.click()
                print("🍪 Cookie accepted")
                await asyncio.sleep(2)
        except Exception:
            pass

        # Login form wait karo
        try:
            await page.wait_for_selector('input[type="text"]', timeout=20000)
            print("✅ Login form found!")
        except Exception:
            await page.screenshot(path="debug.png", full_page=True)
            print("❌ Login form not found! debug.png dekho")
            await browser.close()
            return False

        # Username aur password fill karo
        print("✍️  Typing username:", IG_USERNAME)
        await fill_input(page, 'input[type="text"]', IG_USERNAME)
        await asyncio.sleep(1)

        print("✍️  Typing password...")
        await fill_input(page, 'input[type="password"]', IG_PASSWORD)
        await asyncio.sleep(2)

        pwd_value = await page.locator('input[type="password"]').first.input_value()
        print(f"🔍 Password length: {len(pwd_value)} chars (expected: {len(IG_PASSWORD)})")

        # Login button click karo
        print("🔐 Clicking login button...")
        try:
            btn = page.locator('button:has-text("Log in"), button:has-text("Log In")')
            if await btn.count() > 0:
                await btn.first.click()
                print("✅ Login button clicked!")
            else:
                await page.keyboard.press("Enter")
                print("✅ Enter key pressed!")
        except Exception:
            await page.keyboard.press("Enter")
            print("✅ Enter key pressed (fallback)!")

        await asyncio.sleep(8)

        current_url = page.url
        print("🔗 URL after login:", current_url)

        await page.screenshot(path="after_login.png", full_page=True)
        print("💾 after_login.png saved!")

        if "instagram.com/accounts/login" not in current_url:
            print("🎉 LOGIN SUCCESSFUL!")
            cookies = await context.cookies()

            # sessionid aur csrftoken nikalo
            session_id = ""
            csrf_token = ""
            for cookie in cookies:
                if cookie["name"] == "sessionid":
                    session_id = cookie["value"]
                if cookie["name"] == "csrftoken":
                    csrf_token = cookie["value"]

            # Proper format mein save karo
            session_data = {
                "session_id": session_id,
                "csrf_token": csrf_token,
                "username": IG_USERNAME,
                "logged_in_at": datetime.utcnow().isoformat() + "Z",
                "cookies": cookies
            }

            with open(SESSION_FILE, "w") as f:
                json.dump(session_data, f, indent=2)
            print(f"💾 Session saved to {SESSION_FILE}")
            print(f"🔑 Session ID: {session_id[:20]}..." if session_id else "⚠️  Session ID missing!")

            await browser.close()
            return True
        else:
            print("❌ Login failed! after_login.png dekho")
            page_content = await page.content()
            if "two-factor" in page_content.lower():
                print("⚠️  2FA required!")
            elif "suspicious" in page_content.lower():
                print("⚠️  Suspicious login detected!")
            elif "challenge" in current_url:
                print("⚠️  Challenge/CAPTCHA required!")
            elif "incorrect" in page_content.lower():
                print("⚠️  Wrong username or password!")
            await browser.close()
            return False

async def use_session():
    if not os.path.exists(SESSION_FILE):
        print("❌ Session file nahi mila, pehle login karo")
        return False

    print("📂 Loading saved session...")
    async with async_playwright() as p:
        launch_args = {"headless": True}
        if PROXY:
            launch_args["proxy"] = PROXY

        browser = await p.chromium.launch(**launch_args)
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 800},
        )

        with open(SESSION_FILE, "r") as f:
            data = json.load(f)

        # Naye format ke saath bhi kaam kare
        if isinstance(data, list):
            cookies = data
        elif isinstance(data, dict) and "cookies" in data:
            cookies = data["cookies"]
        elif isinstance(data, dict):
            cookies = list(data.values()) if data else []
        else:
            cookies = []

        await context.add_cookies(cookies)
        page = await context.new_page()
        await page.goto("https://www.instagram.com/", wait_until="networkidle")
        await asyncio.sleep(3)

        print("🔗 URL:", page.url)
        await page.screenshot(path="session_test.png", full_page=True)
        print("💾 session_test.png saved!")

        if "instagram.com/accounts/login" not in page.url:
            print("✅ Session valid hai!")
            await browser.close()
            return True
        else:
            print("❌ Session expired, dobara login karo")
            await browser.close()
            return False

async def main():
    if os.path.exists(SESSION_FILE):
        print("🔄 Existing session check kar raha hoon...")
        session_valid = await use_session()
        if session_valid:
            return

    print("🔑 Fresh login kar raha hoon...")
    success = await login()

    if success:
        print("\n✅ Bot ready hai!")
    else:
        print("\n❌ Login fail hua, after_login.png check karo")

asyncio.run(main())
