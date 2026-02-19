# Privacy Policy — Video Downloader

**Last updated:** February 19, 2026

## Overview

Video Downloader is a Chrome extension that detects and downloads videos from web pages. This privacy policy explains what data the extension accesses and how it is handled.

## Data Collection

**This extension does not collect, transmit, or store any personal data on external servers.**

All data processing happens entirely within your browser. No analytics, telemetry, or tracking of any kind is performed. No information is sent to any server operated by the extension developer or any third party.

## Data Accessed Locally

The extension accesses the following data, which remains entirely on your device:

- **Network requests**: The extension monitors network traffic on pages you visit to detect video stream URLs (HLS/M3U8, MP4, and other formats). This monitoring is used solely to identify downloadable media.

- **User preferences**: Settings such as preferred video quality are stored locally in Chrome's extension storage.

- **Download state**: Temporary download progress (percentage, speed) is stored locally to display in the extension popup.

All locally stored data can be cleared at any time by removing the extension.

## Third-Party Services

This extension does not communicate with any external servers. All video detection and downloading happens directly between your browser and the website you are visiting.

## Permissions

- **tabs**: Detects which tab is active to find videos on the current page.
- **offscreen**: Creates an offscreen document for remuxing HLS video segments into MP4.
- **downloads**: Saves detected videos to your computer.
- **sidePanel**: Provides an optional side panel view for detected videos.
- **webRequest**: Intercepts network requests to detect video stream URLs on the current page.
- **unlimitedStorage**: Caches video segments during HLS downloads before final remuxing.
- **webNavigation**: Detects page navigations to reset video detection.
- **scripting**: Injects content scripts to help detect video elements on web pages.
- **declarativeNetRequest**: Modifies request headers when needed to download video segments.
- **storage**: Stores user preferences locally.
- **notifications**: Notifies the user when a download completes or fails.
- **contextMenus**: Adds a right-click menu option to download videos.
- **host_permissions (all URLs)**: Required because users may visit videos on any website.

## Changes

If this policy is updated, the changes will be posted here with a revised date.

## Contact

If you have questions about this privacy policy, please open an issue at:
https://github.com/hanzili/mcgill-lrs-extension/issues
