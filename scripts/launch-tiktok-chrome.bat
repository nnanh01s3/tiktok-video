@echo off
REM Launch Chrome with CDP port for TikTok Direct posting
REM Run this ONCE, login to TikTok @suutam0405, then leave Chrome open
REM The tiktok-direct module will connect to this Chrome instance

"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9402 ^
  --user-data-dir="D:\tiktok\data\tiktok\chrome_profile" ^
  --disable-blink-features=AutomationControlled ^
  --no-first-run ^
  --window-size=1280,900 ^
  "https://www.tiktok.com/login"

echo Chrome closed. Re-run this script to open again.
pause
