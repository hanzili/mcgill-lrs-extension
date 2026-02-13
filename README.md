# McGill LRS Downloader

A Chrome extension that downloads lecture recordings from McGill's Lecture Recording System (LRS). Just open any course's recordings page on myCourses — the extension automatically captures your session and generates download scripts you can run in Terminal.

![Screenshot](assets/screenshot.png)

## Features

- **Zero setup** — automatically captures your authentication token when you visit a course's LRS page
- **One-click downloads** — download individual lectures or all at once
- **Reliable large-file downloads** — generates curl scripts that handle 1GB+ lecture files without browser memory limits
- **Smart file naming** — saves as `CourseName_Date_Instructor.ts` in `~/Downloads/McGill-Lectures/`
- **Batch support** — "Download all" generates a single script with all lectures

## Installation

1. Clone or download this repository
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (toggle in the top right)
4. Click **Load unpacked** and select this folder
5. Pin the extension to your toolbar for easy access

## Usage

1. Go to [myCourses](https://mycourses2.mcgill.ca) and open any course
2. Navigate to **Lecture Recordings** (Content → Lecture Recordings)
3. Click the extension icon — it should show **Active** and list all recordings
4. Click the download button on any recording, or hit **Download all**
5. A `.command` script will be saved to your Downloads folder
6. Run it:
   ```bash
   cd ~/Downloads/McGill-Lectures
   chmod +x *.command
   open *.command
   ```

Files are saved to `~/Downloads/McGill-Lectures/`.

### Standalone script (alternative)

A standalone bash script is also included for power users who prefer the command line:

```bash
# Requires: curl, jq, ffmpeg
./mcgill-lrs-dl.sh           # shows instructions to get your JWT token
./mcgill-lrs-dl.sh <TOKEN>   # downloads recordings interactively
```

This script also converts `.ts` files to `.mp4` automatically via ffmpeg.

## How It Works

The extension uses a multi-layer approach to work within Chrome's Manifest V3 constraints:

1. **Token capture** — A content script running in the page's JS context (`MAIN` world) patches `fetch` and `XMLHttpRequest` to intercept JWT tokens sent to McGill's LRS API. A bridge script in the `ISOLATED` world relays these to the background service worker. A `webRequest` listener acts as a backup capture method.

2. **Recording discovery** — The service worker uses the captured JWT to call the LRS API and fetch the list of recordings for the course.

3. **Script generation** — Each recording has an HLS manifest pointing to a `.ts` media file on McGill's CDN. The service worker resolves the direct media URL from the manifest, then generates a shell script with curl commands that download the files reliably — no browser memory limits, no service worker timeouts.

## Project Structure

```
├── manifest.json        # Extension config (Manifest V3)
├── background.js        # Service worker: token storage, API calls, script generation
├── intercept.js         # Content script (MAIN world): patches fetch/XHR
├── bridge.js            # Content script (ISOLATED world): relays tokens
├── popup.html           # Extension popup UI
├── popup.css            # Styles (dark theme)
├── popup.js             # Popup logic
├── mcgill-lrs-dl.sh     # Standalone download script (alternative to extension)
└── icons/               # Extension icons (16, 48, 128px)
```

## License

[MIT](LICENSE)
