# McGill LRS Downloader

A Chrome extension that downloads lecture recordings from McGill's Lecture Recording System (LRS). Downloads play natively on macOS, Windows, and Linux — no additional software needed.

## Features

- **Zero setup** — automatically captures your authentication token when you visit a course's LRS page
- **One-click downloads** — download individual lectures or all at once
- **Playable MP4 files** — in-browser remuxing produces standard H.264+AAC MP4 files that play in QuickTime, Windows Media Player, VLC, etc.
- **Real-time progress** — live percentage and MB counter in the popup while downloading
- **Smart file naming** — saves as `CourseName_Date_Instructor.mp4`
- **Cross-platform** — works on macOS, Windows, Linux, and ChromeOS

## Installation

### From Chrome Web Store

*(Coming soon)*

### From source (Developer mode)

1. Clone or download this repository
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (toggle in the top right)
4. Click **Load unpacked** and select this folder
5. Pin the extension to your toolbar for easy access

## Usage

1. Go to [myCourses](https://mycourses2.mcgill.ca) and open any course
2. Navigate to **Lecture Recordings** (Content > Lecture Recordings)
3. Click the extension icon — it should show **Active** and list all recordings
4. Click the download button on any recording, or hit **Download all**
5. Keep the lecture tab open while downloading — the file will appear in Chrome's download bar when ready

## How It Works

The extension works within Chrome's Manifest V3 constraints using a multi-layer approach:

1. **Token capture** — A content script in the page's MAIN world patches `fetch`/`XHR` to intercept JWT tokens sent to McGill's LRS API. A bridge script relays these to the service worker.

2. **Recording discovery** — The service worker uses the captured JWT to call the LRS API and fetch the course's recording list.

3. **In-page download** — The video is fetched from the CDN inside the LRS iframe (which has the correct Origin header). The raw MPEG-TS stream is remuxed to MP4 in the browser using a custom pure-JS remuxer, then triggered as a download via `<a download>`.

4. **Progress tracking** — Download progress flows from the page context through a bridge script to the service worker, which stores it in `chrome.storage` for the popup to display in real time.

## Project Structure

```
manifest.json      Extension config (Manifest V3)
background.js      Service worker: token storage, API calls, download orchestration
intercept.js       Content script (MAIN world): patches fetch/XHR to capture tokens
bridge.js          Content script (ISOLATED world): relays messages to service worker
remux.js           Pure JS MPEG-TS to MP4 remuxer (H.264 video + AAC audio)
popup.html         Extension popup UI
popup.css          Styles
popup.js           Popup logic and progress display
icons/             Extension icons (16, 48, 128px)
```

## License

[MIT](LICENSE)
