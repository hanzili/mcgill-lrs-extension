#!/bin/bash
# McGill LRS Lecture Downloader
# Downloads lecture recordings from McGill's Lecture Recording System
#
# Usage:
#   ./mcgill-lrs-dl.sh              (interactive - shows instructions to get token)
#   ./mcgill-lrs-dl.sh <JWT_TOKEN>  (downloads recordings for the course in the token)
#
# Requirements: curl, jq, ffmpeg

set -euo pipefail

API_BASE="https://lrswapi.campus.mcgill.ca/api"
CDN_BASE="https://LRSCDN.mcgill.ca"
DOWNLOAD_DIR="$HOME/Downloads/McGill-Lectures"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

check_deps() {
    local missing=()
    for cmd in curl jq ffmpeg; do
        command -v "$cmd" &>/dev/null || missing+=("$cmd")
    done
    if [ ${#missing[@]} -gt 0 ]; then
        echo -e "${RED}Missing dependencies: ${missing[*]}${NC}"
        echo "Install with: brew install ${missing[*]}"
        exit 1
    fi
}

show_instructions() {
    echo -e "${BOLD}${CYAN}╔═══════════════════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}${CYAN}║       McGill LRS Lecture Downloader                   ║${NC}"
    echo -e "${BOLD}${CYAN}╚═══════════════════════════════════════════════════════╝${NC}"
    echo
    echo -e "${YELLOW}To use this script, you need a JWT token from your browser.${NC}"
    echo -e "${YELLOW}Here's how to get it (takes 30 seconds):${NC}"
    echo
    echo -e "  ${BOLD}1.${NC} Log into ${BLUE}mycourses2.mcgill.ca${NC}"
    echo -e "  ${BOLD}2.${NC} Open any course → click ${BOLD}Lecture Recordings${NC}"
    echo -e "  ${BOLD}3.${NC} Open ${BOLD}DevTools${NC} (Cmd+Option+I) → ${BOLD}Network${NC} tab"
    echo -e "  ${BOLD}4.${NC} In the filter bar, type: ${CYAN}lrswapi${NC}"
    echo -e "  ${BOLD}5.${NC} Click any request → ${BOLD}Headers${NC} tab"
    echo -e "  ${BOLD}6.${NC} Find ${CYAN}authorization: Bearer eyJ...${NC}"
    echo -e "  ${BOLD}7.${NC} Copy everything after \"Bearer \" (the eyJ... part)"
    echo
    echo -e "${BOLD}Then run:${NC}"
    echo -e "  ${GREEN}./mcgill-lrs-dl.sh eyJ...your_token_here${NC}"
    echo
    echo -e "${YELLOW}The token lasts ~4 hours. One token per course.${NC}"
}

decode_jwt() {
    local token="$1"
    # JWT has 3 parts separated by dots: header.payload.signature
    local payload
    payload=$(echo "$token" | cut -d'.' -f2)
    # Add padding if needed
    local padding=$(( 4 - ${#payload} % 4 ))
    if [ "$padding" -lt 4 ]; then
        payload="${payload}$(printf '=%.0s' $(seq 1 "$padding"))"
    fi
    echo "$payload" | base64 -d 2>/dev/null
}

fetch_recordings() {
    local token="$1"
    local course_id="$2"

    curl -sS \
        -H "Authorization: Bearer $token" \
        -H "Origin: https://lrs.mcgill.ca" \
        -H "Referer: https://lrs.mcgill.ca/" \
        -H "Accept: application/json" \
        "$API_BASE/MediaRecordings/dto/$course_id"
}

get_tsmedia_url() {
    local hls_url="$1"

    # Fetch the HLS manifest and extract the tsmedia URL
    local manifest
    manifest=$(curl -sS \
        -H "Origin: https://lrs.mcgill.ca" \
        -H "Referer: https://lrs.mcgill.ca/" \
        "$hls_url")

    # Extract the tsmedia URL (first occurrence)
    echo "$manifest" | grep -m1 "tsmedia" || echo ""
}

download_recording() {
    local tsmedia_url="$1"
    local output_file="$2"
    local ts_file="${output_file%.mp4}.ts"

    echo -e "  ${CYAN}Downloading...${NC}"
    curl -L --progress-bar \
        -H "Origin: https://lrs.mcgill.ca" \
        -H "Referer: https://lrs.mcgill.ca/" \
        -H "Range: bytes=0-" \
        -o "$ts_file" \
        "$tsmedia_url"

    local filesize
    filesize=$(stat -f%z "$ts_file" 2>/dev/null || stat -c%s "$ts_file" 2>/dev/null || echo 0)
    if [ "$filesize" -lt 1000000 ]; then
        echo -e "  ${RED}Download failed (file too small: ${filesize} bytes)${NC}"
        rm -f "$ts_file"
        return 1
    fi

    echo -e "  ${CYAN}Converting to MP4...${NC}"
    ffmpeg -i "$ts_file" -c copy -bsf:a aac_adtstoasc -y "$output_file" 2>/dev/null

    if [ -f "$output_file" ]; then
        rm -f "$ts_file"
        local mp4size
        mp4size=$(du -h "$output_file" | cut -f1)
        echo -e "  ${GREEN}Done! ${mp4size} → ${output_file}${NC}"
    else
        echo -e "  ${RED}Conversion failed. Raw file kept at: ${ts_file}${NC}"
        return 1
    fi
}

format_duration() {
    local secs="$1"
    printf "%dh%02dm" $((secs / 3600)) $(((secs % 3600) / 60))
}

# ─── Main ───────────────────────────────────────────────

check_deps

if [ $# -lt 1 ]; then
    show_instructions
    exit 0
fi

TOKEN="$1"

# Strip "Bearer " prefix if user copied the whole header
TOKEN="${TOKEN#Bearer }"

# Decode JWT to get course info
JWT_PAYLOAD=$(decode_jwt "$TOKEN")
if [ -z "$JWT_PAYLOAD" ]; then
    echo -e "${RED}Invalid token. Could not decode JWT.${NC}"
    exit 1
fi

COURSE_ID=$(echo "$JWT_PAYLOAD" | jq -r '.LRSCourseId // empty')
EMAIL=$(echo "$JWT_PAYLOAD" | jq -r '.email // empty')
EXP=$(echo "$JWT_PAYLOAD" | jq -r '.exp // empty')

if [ -z "$COURSE_ID" ]; then
    echo -e "${RED}Could not extract course ID from token.${NC}"
    exit 1
fi

# Check if token is expired
NOW=$(date +%s)
if [ -n "$EXP" ] && [ "$NOW" -gt "$EXP" ]; then
    echo -e "${RED}Token has expired. Please get a fresh one from the browser.${NC}"
    exit 1
fi

echo -e "${BOLD}${CYAN}╔═══════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${CYAN}║       McGill LRS Lecture Downloader                   ║${NC}"
echo -e "${BOLD}${CYAN}╚═══════════════════════════════════════════════════════╝${NC}"
echo
echo -e "  ${BOLD}Account:${NC}  $EMAIL"
echo -e "  ${BOLD}Course ID:${NC} $COURSE_ID"
EXPIRES_IN=$(( (EXP - NOW) / 60 ))
echo -e "  ${BOLD}Token:${NC}    valid for ${GREEN}${EXPIRES_IN} min${NC}"
echo

# Fetch recordings
echo -e "${CYAN}Fetching recordings...${NC}"
RECORDINGS=$(fetch_recordings "$TOKEN" "$COURSE_ID")

if [ -z "$RECORDINGS" ] || [ "$RECORDINGS" = "[]" ]; then
    echo -e "${RED}No recordings found (or API error).${NC}"
    exit 1
fi

# Parse and display recordings
COUNT=$(echo "$RECORDINGS" | jq 'length')
COURSE_NAME=$(echo "$RECORDINGS" | jq -r '.[0].courseName // "Unknown"')
SEMESTER=$(echo "$RECORDINGS" | jq -r '.[0].semesterName // "Unknown"')

echo -e "${BOLD}${COURSE_NAME} (${SEMESTER}) — ${COUNT} recordings:${NC}"
echo

for i in $(seq 0 $((COUNT - 1))); do
    REC=$(echo "$RECORDINGS" | jq ".[$i]")
    DATE=$(echo "$REC" | jq -r '.dateTime' | cut -d'T' -f1)
    TIME=$(echo "$REC" | jq -r '.dateTime' | cut -dT -f2 | cut -d: -f1-2)
    INSTRUCTOR=$(echo "$REC" | jq -r '.instructor // "—"')
    DURATION=$(echo "$REC" | jq -r '.durationSeconds // 0')
    DUR_FMT=$(format_duration "$DURATION")

    printf "  ${BOLD}%2d.${NC} ${GREEN}%-12s${NC} %s  ${CYAN}%s${NC}  %s\n" \
        $((i + 1)) "$DATE" "$TIME" "$DUR_FMT" "$INSTRUCTOR"
done

echo
echo -e "${YELLOW}Which recordings to download?${NC}"
echo -e "  Enter numbers (e.g., ${BOLD}1${NC} or ${BOLD}1,3,5${NC} or ${BOLD}all${NC}):"
read -rp "  > " SELECTION

# Parse selection
INDICES=()
if [ "$SELECTION" = "all" ] || [ "$SELECTION" = "a" ]; then
    for i in $(seq 1 "$COUNT"); do INDICES+=("$i"); done
else
    IFS=',' read -ra PARTS <<< "$SELECTION"
    for part in "${PARTS[@]}"; do
        part=$(echo "$part" | tr -d ' ')
        if [[ "$part" =~ ^[0-9]+$ ]] && [ "$part" -ge 1 ] && [ "$part" -le "$COUNT" ]; then
            INDICES+=("$part")
        fi
    done
fi

if [ ${#INDICES[@]} -eq 0 ]; then
    echo -e "${RED}No valid recordings selected.${NC}"
    exit 1
fi

# Create download directory
COURSE_DIR="$DOWNLOAD_DIR/${SEMESTER}_${COURSE_NAME}"
mkdir -p "$COURSE_DIR"
echo
echo -e "${BOLD}Downloading ${#INDICES[@]} recording(s) to:${NC}"
echo -e "  ${BLUE}${COURSE_DIR}${NC}"
echo

for idx in "${INDICES[@]}"; do
    i=$((idx - 1))
    REC=$(echo "$RECORDINGS" | jq ".[$i]")
    DATE=$(echo "$REC" | jq -r '.dateTime' | cut -d'T' -f1)
    INSTRUCTOR=$(echo "$REC" | jq -r '.instructor // "Unknown"')
    HLS_URL=$(echo "$REC" | jq -r '.sources[] | select(.label=="VGA") | .src')

    FILENAME="${COURSE_NAME}_${DATE}_${INSTRUCTOR// /_}.mp4"
    FILEPATH="${COURSE_DIR}/${FILENAME}"

    echo -e "${BOLD}[${idx}/${COUNT}] ${DATE} — ${INSTRUCTOR}${NC}"

    if [ -f "$FILEPATH" ]; then
        echo -e "  ${YELLOW}Already exists, skipping.${NC}"
        continue
    fi

    # Get tsmedia URL from HLS manifest
    TSMEDIA_URL=$(get_tsmedia_url "$HLS_URL")
    if [ -z "$TSMEDIA_URL" ]; then
        echo -e "  ${RED}Could not get media URL. Token may have expired.${NC}"
        continue
    fi

    download_recording "$TSMEDIA_URL" "$FILEPATH"
    echo
done

echo -e "${GREEN}${BOLD}All done!${NC}"
echo -e "Files saved to: ${BLUE}${COURSE_DIR}${NC}"
