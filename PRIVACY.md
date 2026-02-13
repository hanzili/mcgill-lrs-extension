# Privacy Policy — McGill LRS Downloader

**Last updated:** February 13, 2026

## Overview

McGill LRS Downloader is a Chrome extension that downloads lecture recordings from McGill University's Lecture Recording System. This privacy policy explains what data the extension accesses and how it is handled.

## Data Collection

**This extension does not collect, transmit, or store any personal data on external servers.**

All data processing happens entirely within your browser. No information is sent to any server operated by the extension developer or any third party.

## Data Accessed Locally

The extension accesses the following data, which remains entirely on your device:

- **Authentication tokens**: When you visit a course's Lecture Recordings page on McGill myCourses, the extension captures the temporary JWT token your browser already uses to access the LRS. This token is stored locally in Chrome's extension storage and is only used to fetch recording metadata from McGill's LRS API.

- **Course and recording metadata**: The extension retrieves the list of recordings (dates, instructor names, durations) for courses you visit. This data is stored locally to display in the extension popup.

- **Download progress**: Temporary download state (percentage, bytes downloaded) is stored locally to display real-time progress in the popup.

All locally stored data can be cleared at any time by removing the extension.

## Third-Party Services

The extension communicates only with McGill University servers (`*.mcgill.ca`) using your existing authenticated session. No data is sent to any other server.

## Permissions

- **storage**: Stores authentication tokens and download progress locally in Chrome.
- **webRequest**: Reads request headers sent to McGill's LRS API to capture your authentication token.
- **scripting**: Injects scripts into the lecture page to download and convert video files.
- **host_permissions (mcgill.ca)**: Required to access McGill's LRS API and video CDN.

## Changes

If this policy is updated, the changes will be posted here with a revised date.

## Contact

If you have questions about this privacy policy, please open an issue at:
https://github.com/YOUR_USERNAME/mcgill-lrs-extension/issues
