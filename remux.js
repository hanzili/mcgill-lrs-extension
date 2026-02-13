// MPEG-TS → MP4 remuxer for H.264 video + AAC audio.
// Produces standard non-fragmented MP4 (ftyp + mdat + moov).
// Designed for lecture recordings; no external dependencies.
//
// Injected into MAIN world via chrome.scripting.executeScript.
// Sets window.__LRS_REMUX = function(tsArrayBuffer) → ArrayBuffer (MP4)

(function() {
  'use strict';

  window.__LRS_REMUX = remuxTsToMp4;

  const AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

  function remuxTsToMp4(tsArrayBuffer) {
    const data = new Uint8Array(tsArrayBuffer);
    const { videoPes, audioPes, audioStreamType } = demuxTs(data);

    // Parse video
    const { sps, pps, samples: videoSamples } = parseH264(videoPes);
    if (!sps || !pps || videoSamples.length === 0) {
      throw new Error('Could not parse H.264 from TS');
    }
    const videoInfo = parseSps(sps);

    // Parse audio (AAC only)
    let audioData = null;
    if (audioPes.length > 0 && audioStreamType === 0x0F) {
      audioData = parseAac(audioPes);
      if (!audioData || audioData.samples.length === 0) audioData = null;
    }

    return buildMp4(sps, pps, videoSamples, videoInfo, audioData);
  }

  // ─── Bit reader for Exp-Golomb (SPS parsing) ──────────

  function BitReader(data) {
    this.data = data; this.byte = 0; this.bit = 0;
  }
  BitReader.prototype.readBit = function() {
    const b = (this.data[this.byte] >> (7 - this.bit)) & 1;
    if (++this.bit === 8) { this.bit = 0; this.byte++; }
    return b;
  };
  BitReader.prototype.readBits = function(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.readBit();
    return v;
  };
  BitReader.prototype.readUE = function() {
    let z = 0;
    while (this.readBit() === 0 && z < 32) z++;
    return z === 0 ? 0 : (1 << z) - 1 + this.readBits(z);
  };
  BitReader.prototype.skipBits = function(n) {
    this.bit += n;
    this.byte += (this.bit >> 3);
    this.bit &= 7;
  };

  // ─── SPS parser (extract width, height, profile, level) ──

  function parseSps(sps) {
    const clean = [];
    for (let i = 0; i < sps.length; i++) {
      if (i + 2 < sps.length && sps[i] === 0 && sps[i+1] === 0 && sps[i+2] === 3) {
        clean.push(0, 0);
        i += 2;
      } else {
        clean.push(sps[i]);
      }
    }
    const r = new BitReader(new Uint8Array(clean));

    r.readBits(8); // NAL header
    const profileIdc = r.readBits(8);
    const constraintFlags = r.readBits(8);
    const levelIdc = r.readBits(8);
    r.readUE(); // seq_parameter_set_id

    let chromaFormatIdc = 1;
    const highProfiles = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];
    if (highProfiles.includes(profileIdc)) {
      chromaFormatIdc = r.readUE();
      if (chromaFormatIdc === 3) r.skipBits(1);
      r.readUE(); r.readUE();
      r.skipBits(1);
      const scalingPresent = r.readBit();
      if (scalingPresent) {
        const cnt = chromaFormatIdc !== 3 ? 8 : 12;
        for (let i = 0; i < cnt; i++) {
          if (r.readBit()) {
            const size = i < 6 ? 16 : 64;
            for (let j = 0; j < size; j++) { r.readUE(); }
          }
        }
      }
    }

    r.readUE(); // log2_max_frame_num_minus4
    const pocType = r.readUE();
    if (pocType === 0) {
      r.readUE();
    } else if (pocType === 1) {
      r.skipBits(1);
      r.readUE(); r.readUE();
      const cnt = r.readUE();
      for (let i = 0; i < cnt; i++) r.readUE();
    }

    r.readUE(); // max_num_ref_frames
    r.skipBits(1);

    const picWidthInMbs = r.readUE() + 1;
    const picHeightInMapUnits = r.readUE() + 1;
    const frameMbsOnly = r.readBit();

    let width = picWidthInMbs * 16;
    let height = picHeightInMapUnits * 16 * (2 - frameMbsOnly);

    if (!frameMbsOnly) r.skipBits(1);
    r.skipBits(1);

    const frameCropping = r.readBit();
    if (frameCropping) {
      const cropLeft = r.readUE();
      const cropRight = r.readUE();
      const cropTop = r.readUE();
      const cropBottom = r.readUE();
      const cropUnitX = chromaFormatIdc === 0 ? 1 : 2;
      const cropUnitY = (chromaFormatIdc === 0 ? 1 : 2) * (2 - frameMbsOnly);
      width -= (cropLeft + cropRight) * cropUnitX;
      height -= (cropTop + cropBottom) * cropUnitY;
    }

    return { width, height, profileIdc, levelIdc, constraintFlags };
  }

  // ─── TS Demuxer (video + audio) ───────────────────────

  function demuxTs(data) {
    let pmtPid = -1, videoPid = -1, audioPid = -1;
    let audioStreamType = 0;
    let currentVideoPes = null, currentAudioPes = null;
    const videoPes = [], audioPes = [];

    for (let i = 0; i < data.length; i += 188) {
      if (data[i] !== 0x47) {
        while (i < data.length && data[i] !== 0x47) i++;
        if (i >= data.length) break;
      }

      const pid = ((data[i+1] & 0x1F) << 8) | data[i+2];
      const payloadStart = !!(data[i+1] & 0x40);
      const hasAdapt = !!(data[i+3] & 0x20);
      const hasPay = !!(data[i+3] & 0x10);

      let off = i + 4;
      if (hasAdapt) off += 1 + data[i+4];
      if (!hasPay || off >= i + 188) continue;
      const payload = data.subarray(off, i + 188);

      // PAT (PID 0)
      if (pid === 0 && pmtPid === -1) {
        const p = payloadStart ? payload[0] + 1 : 0;
        if (p + 12 <= payload.length) {
          pmtPid = ((payload[p+10] & 0x1F) << 8) | payload[p+11];
        }
        continue;
      }

      // PMT — extract both video and audio PIDs
      if (pid === pmtPid && (videoPid === -1 || audioPid === -1)) {
        let p = payloadStart ? payload[0] + 1 : 0;
        if (p + 12 > payload.length) continue;
        const infoLen = ((payload[p+10] & 0x0F) << 8) | payload[p+11];
        p += 12 + infoLen;
        while (p + 5 <= payload.length) {
          const sType = payload[p];
          const ePid = ((payload[p+1] & 0x1F) << 8) | payload[p+2];
          const esLen = ((payload[p+3] & 0x0F) << 8) | payload[p+4];
          if (sType === 0x1B && videoPid === -1) videoPid = ePid;       // H.264
          if (sType === 0x0F && audioPid === -1) { audioPid = ePid; audioStreamType = 0x0F; } // AAC
          p += 5 + esLen;
        }
        continue;
      }

      // Video PES
      if (pid === videoPid) {
        if (payloadStart) {
          if (currentVideoPes) videoPes.push(currentVideoPes);
          if (payload[0] === 0 && payload[1] === 0 && payload[2] === 1) {
            const hdrLen = payload[8];
            const flags2 = payload[7];
            let pts = null, dts = null;
            if (flags2 & 0x80) {
              pts = (payload[9] & 0x0E) * 536870912 +
                    (payload[10] & 0xFF) * 4194304 +
                    (payload[11] & 0xFE) * 16384 +
                    (payload[12] & 0xFF) * 128 +
                    ((payload[13] & 0xFE) >> 1);
            }
            if ((flags2 & 0xC0) === 0xC0) {
              dts = (payload[14] & 0x0E) * 536870912 +
                    (payload[15] & 0xFF) * 4194304 +
                    (payload[16] & 0xFE) * 16384 +
                    (payload[17] & 0xFF) * 128 +
                    ((payload[18] & 0xFE) >> 1);
            } else {
              dts = pts;
            }
            currentVideoPes = { pts, dts, chunks: [payload.subarray(9 + hdrLen)] };
          } else {
            currentVideoPes = null;
          }
        } else if (currentVideoPes) {
          currentVideoPes.chunks.push(payload);
        }
      }

      // Audio PES
      if (pid === audioPid) {
        if (payloadStart) {
          if (currentAudioPes) audioPes.push(currentAudioPes);
          if (payload[0] === 0 && payload[1] === 0 && payload[2] === 1) {
            const hdrLen = payload[8];
            currentAudioPes = { chunks: [payload.subarray(9 + hdrLen)] };
          } else {
            currentAudioPes = null;
          }
        } else if (currentAudioPes) {
          currentAudioPes.chunks.push(payload);
        }
      }
    }

    if (currentVideoPes) videoPes.push(currentVideoPes);
    if (currentAudioPes) audioPes.push(currentAudioPes);
    return { videoPes, audioPes, audioStreamType };
  }

  // ─── AAC ADTS parser ──────────────────────────────────

  function parseAac(audioPes) {
    // Concatenate all audio PES payload into one buffer
    let totalLen = 0;
    for (const pes of audioPes) {
      for (const c of pes.chunks) totalLen += c.length;
    }
    const raw = new Uint8Array(totalLen);
    let off = 0;
    for (const pes of audioPes) {
      for (const c of pes.chunks) { raw.set(c, off); off += c.length; }
    }

    // Scan for ADTS frames
    const samples = [];
    let sampleRate = 0, channels = 0, audioObjectType = 0, samplingFreqIndex = 0;

    let i = 0;
    while (i < raw.length - 6) {
      // ADTS sync word: 0xFFF (12 bits)
      if (raw[i] !== 0xFF || (raw[i+1] & 0xF0) !== 0xF0) { i++; continue; }

      const protectionAbsent = raw[i+1] & 0x01;
      const profile = (raw[i+2] >> 6) & 0x03;
      const sfIndex = (raw[i+2] >> 2) & 0x0F;
      const channelConfig = ((raw[i+2] & 0x01) << 2) | ((raw[i+3] >> 6) & 0x03);
      const frameLength = ((raw[i+3] & 0x03) << 11) | (raw[i+4] << 3) | ((raw[i+5] >> 5) & 0x07);

      if (frameLength < 7 || i + frameLength > raw.length) break;

      const headerSize = protectionAbsent ? 7 : 9;
      const aacFrame = raw.slice(i + headerSize, i + frameLength);

      if (!sampleRate) {
        audioObjectType = profile + 1; // ADTS profile = AOT - 1
        samplingFreqIndex = sfIndex;
        channels = channelConfig;
        sampleRate = AAC_SAMPLE_RATES[sfIndex] || 48000;
      }

      samples.push({ data: aacFrame });
      i += frameLength;
    }

    return { samples, sampleRate, channels, audioObjectType, samplingFreqIndex };
  }

  // ─── H.264 NAL parser ────────────────────────────────

  function parseH264(pesPackets) {
    let sps = null, pps = null;
    const samples = [];

    for (const pes of pesPackets) {
      const totalLen = pes.chunks.reduce((s, c) => s + c.length, 0);
      const raw = new Uint8Array(totalLen);
      let off = 0;
      for (const c of pes.chunks) { raw.set(c, off); off += c.length; }

      // Find NAL units (Annex B start codes)
      const nalus = [];
      let start = -1;
      for (let i = 0; i < raw.length - 2; i++) {
        if (raw[i] !== 0) continue;
        if (raw[i+1] !== 0) continue;
        let naluStart;
        if (raw[i+2] === 1) {
          naluStart = i + 3;
        } else if (raw[i+2] === 0 && i + 3 < raw.length && raw[i+3] === 1) {
          naluStart = i + 4;
        } else continue;
        if (start >= 0) nalus.push(raw.subarray(start, i));
        start = naluStart;
        i = naluStart - 1;
      }
      if (start >= 0 && start < raw.length) nalus.push(raw.subarray(start));

      let isKey = false;
      const frameNalus = [];
      for (const nalu of nalus) {
        if (nalu.length === 0) continue;
        const type = nalu[0] & 0x1F;
        if (type === 7) { sps = nalu; continue; }
        if (type === 8) { pps = nalu; continue; }
        if (type === 9) continue; // AUD
        if (type === 5) isKey = true; // IDR
        frameNalus.push(nalu);
      }
      if (frameNalus.length === 0) continue;

      // Annex B → AVCC (length-prefixed)
      const size = frameNalus.reduce((s, n) => s + 4 + n.length, 0);
      const buf = new Uint8Array(size);
      let o = 0;
      for (const n of frameNalus) {
        buf[o] = (n.length >> 24) & 0xFF;
        buf[o+1] = (n.length >> 16) & 0xFF;
        buf[o+2] = (n.length >> 8) & 0xFF;
        buf[o+3] = n.length & 0xFF;
        buf.set(n, o + 4);
        o += 4 + n.length;
      }

      samples.push({ data: buf, pts: pes.pts, dts: pes.dts, isKey });
    }

    return { sps, pps, samples };
  }

  // ─── MP4 box helpers ──────────────────────────────────

  function u32(v) { return [(v >> 24) & 0xFF, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF]; }
  function u16(v) { return [(v >> 8) & 0xFF, v & 0xFF]; }

  function box(type, ...payloads) {
    const fourcc = type.split('').map(c => c.charCodeAt(0));
    let size = 8;
    for (const p of payloads) size += p.length;
    const out = new Uint8Array(size);
    out.set(u32(size), 0);
    out.set(fourcc, 4);
    let off = 8;
    for (const p of payloads) { out.set(p, off); off += p.length; }
    return out;
  }

  function fullBox(type, version, flags, ...payloads) {
    const header = new Uint8Array([version, (flags >> 16) & 0xFF, (flags >> 8) & 0xFF, flags & 0xFF]);
    return box(type, header, ...payloads);
  }

  // ─── MP4 builder ──────────────────────────────────────

  function buildMp4(sps, pps, videoSamples, videoInfo, audioData) {
    const VIDEO_TIMESCALE = 90000;
    const { width, height, profileIdc, levelIdc } = videoInfo;

    // ── Video timing ──

    const durations = [];
    for (let i = 0; i < videoSamples.length - 1; i++) {
      durations.push(Math.max(1, videoSamples[i+1].dts - videoSamples[i].dts));
    }
    durations.push(durations.length > 0 ? durations[durations.length - 1] : 3600);
    const videoTotalDuration = durations.reduce((s, d) => s + d, 0);

    const hasCtts = videoSamples.some(s => s.pts !== s.dts);
    const cttsOffsets = videoSamples.map(s => s.pts - s.dts);

    // ── Data sizes ──

    let totalVideoDataSize = 0;
    for (const s of videoSamples) totalVideoDataSize += s.data.length;

    let totalAudioDataSize = 0;
    if (audioData) {
      for (const s of audioData.samples) totalAudioDataSize += s.data.length;
    }

    // ── ftyp ──

    const ftyp = box('ftyp',
      new Uint8Array([0x69,0x73,0x6F,0x6D]), // isom
      new Uint8Array(u32(0x200)),
      new Uint8Array([0x69,0x73,0x6F,0x6D,   // isom
                      0x69,0x73,0x6F,0x32,   // iso2
                      0x61,0x76,0x63,0x31,   // avc1
                      0x6D,0x70,0x34,0x31])  // mp41
    );

    // ── Chunk offsets (layout: ftyp | mdat | moov) ──

    const videoChunkOffset = ftyp.length + 8; // ftyp + mdat header (8 bytes)
    const audioChunkOffset = ftyp.length + 8 + totalVideoDataSize;

    // ── mdat ──

    const mdatSize = 8 + totalVideoDataSize + totalAudioDataSize;
    const mdat = new Uint8Array(mdatSize);
    mdat.set(u32(mdatSize), 0);
    mdat.set([0x6D,0x64,0x61,0x74], 4);
    let mdatOff = 8;
    for (const s of videoSamples) {
      mdat.set(s.data, mdatOff);
      mdatOff += s.data.length;
    }
    if (audioData) {
      for (const s of audioData.samples) {
        mdat.set(s.data, mdatOff);
        mdatOff += s.data.length;
      }
    }

    // ════════════════════════════════════════════════════
    //  VIDEO TRACK (track_ID = 1)
    // ════════════════════════════════════════════════════

    // ── avcC ──
    const avcC = box('avcC', new Uint8Array([
      1, profileIdc, videoInfo.constraintFlags || 0, levelIdc,
      0xFF, 0xE1,
      ...u16(sps.length), ...sps,
      1,
      ...u16(pps.length), ...pps
    ]));

    // ── stsd → avc1 ──
    const avc1Payload = new Uint8Array([
      0,0,0,0,0,0, 0,1,
      0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,
      ...u16(width), ...u16(height),
      0x00,0x48,0x00,0x00, 0x00,0x48,0x00,0x00,
      0,0,0,0, 0,1,
      0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
      0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
      0,0x18, 0xFF,0xFF
    ]);
    const avc1 = box('avc1', avc1Payload, avcC);
    const videoStsd = fullBox('stsd', 0, 0, new Uint8Array(u32(1)), avc1);

    // ── stts ──
    const sttsEntries = [];
    let runCount = 1, runDur = durations[0];
    for (let i = 1; i < durations.length; i++) {
      if (durations[i] === runDur) { runCount++; }
      else { sttsEntries.push(runCount, runDur); runCount = 1; runDur = durations[i]; }
    }
    sttsEntries.push(runCount, runDur);
    const sttsData = new Uint8Array(4 + sttsEntries.length * 4);
    sttsData.set(u32(sttsEntries.length / 2), 0);
    for (let i = 0; i < sttsEntries.length; i++) sttsData.set(u32(sttsEntries[i]), 4 + i * 4);
    const videoStts = fullBox('stts', 0, 0, sttsData);

    // ── ctts (composition time offsets for B-frames) ──
    let videoCtts = null;
    if (hasCtts) {
      const cttsRuns = [];
      let cRunCnt = 1, cRunOff = cttsOffsets[0];
      for (let i = 1; i < cttsOffsets.length; i++) {
        if (cttsOffsets[i] === cRunOff) { cRunCnt++; }
        else { cttsRuns.push(cRunCnt, cRunOff); cRunCnt = 1; cRunOff = cttsOffsets[i]; }
      }
      cttsRuns.push(cRunCnt, cRunOff);
      const cttsData = new Uint8Array(4 + cttsRuns.length * 4);
      cttsData.set(u32(cttsRuns.length / 2), 0);
      for (let i = 0; i < cttsRuns.length; i++) {
        const v = cttsRuns[i];
        cttsData.set([(v >> 24) & 0xFF, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF], 4 + i * 4);
      }
      videoCtts = fullBox('ctts', 1, 0, cttsData);
    }

    // ── stss (keyframes) ──
    const keyframes = [];
    for (let i = 0; i < videoSamples.length; i++) {
      if (videoSamples[i].isKey) keyframes.push(i + 1);
    }
    const stssData = new Uint8Array(4 + keyframes.length * 4);
    stssData.set(u32(keyframes.length), 0);
    for (let i = 0; i < keyframes.length; i++) stssData.set(u32(keyframes[i]), 4 + i * 4);
    const videoStss = fullBox('stss', 0, 0, stssData);

    // ── stsz ──
    const videoStszData = new Uint8Array(8 + videoSamples.length * 4);
    videoStszData.set(u32(0), 0);
    videoStszData.set(u32(videoSamples.length), 4);
    for (let i = 0; i < videoSamples.length; i++) videoStszData.set(u32(videoSamples[i].data.length), 8 + i * 4);
    const videoStsz = fullBox('stsz', 0, 0, videoStszData);

    // ── stsc + stco ──
    const videoStsc = fullBox('stsc', 0, 0, new Uint8Array([
      ...u32(1), ...u32(1), ...u32(videoSamples.length), ...u32(1)
    ]));
    const videoStco = fullBox('stco', 0, 0, new Uint8Array([
      ...u32(1), ...u32(videoChunkOffset)
    ]));

    // ── Video stbl → minf → mdia → trak ──
    const videoStblBoxes = [videoStsd, videoStts, videoCtts, videoStss, videoStsc, videoStsz, videoStco].filter(Boolean);
    const videoStbl = box('stbl', ...videoStblBoxes);
    const vmhd = fullBox('vmhd', 0, 1, new Uint8Array([0,0, 0,0,0,0,0,0]));
    const vUrl = fullBox('url ', 0, 1);
    const vDref = fullBox('dref', 0, 0, new Uint8Array(u32(1)), vUrl);
    const vDinf = box('dinf', vDref);
    const videoMinf = box('minf', vmhd, vDinf, videoStbl);
    const videoHdlr = fullBox('hdlr', 0, 0, new Uint8Array([
      0,0,0,0, 0x76,0x69,0x64,0x65, 0,0,0,0, 0,0,0,0, 0,0,0,0,
      0x56,0x69,0x64,0x65,0x6F,0
    ]));
    const videoMdhd = fullBox('mdhd', 0, 0, new Uint8Array([
      ...u32(0), ...u32(0), ...u32(VIDEO_TIMESCALE), ...u32(videoTotalDuration),
      0x55,0xC4, 0,0
    ]));
    const videoMdia = box('mdia', videoMdhd, videoHdlr, videoMinf);
    const videoTkhd = fullBox('tkhd', 0, 3, new Uint8Array([
      ...u32(0), ...u32(0), ...u32(1), ...u32(0), ...u32(videoTotalDuration),
      ...u32(0), ...u32(0), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0x00010000), ...u32(0), ...u32(0),
      ...u32(0), ...u32(0x00010000), ...u32(0),
      ...u32(0), ...u32(0), ...u32(0x40000000),
      ...u16(width), ...u16(0), ...u16(height), ...u16(0)
    ]));
    const videoTrak = box('trak', videoTkhd, videoMdia);

    // ════════════════════════════════════════════════════
    //  AUDIO TRACK (track_ID = 2) — only if AAC present
    // ════════════════════════════════════════════════════

    let audioTrak = null;
    let audioTkhdDuration = 0;

    if (audioData) {
      const audioTimescale = audioData.sampleRate;
      const audioTotalDuration = audioData.samples.length * 1024; // 1024 PCM samples per AAC frame
      audioTkhdDuration = Math.round(audioTotalDuration * VIDEO_TIMESCALE / audioTimescale);

      // ── AudioSpecificConfig (2 bytes for AAC-LC) ──
      const asc0 = (audioData.audioObjectType << 3) | (audioData.samplingFreqIndex >> 1);
      const asc1 = ((audioData.samplingFreqIndex & 1) << 7) | (audioData.channels << 3);

      // ── esds (Elementary Stream Descriptor) ──
      const esdsPayload = new Uint8Array([
        // ES_Descriptor
        0x03, 25,
        0x00, 0x02,       // ES_ID = 2
        0x00,             // flags
        // DecoderConfigDescriptor
        0x04, 17,
        0x40,             // objectTypeIndication = AAC
        0x15,             // streamType = audio (0x05 << 2 | 0x01)
        0x00, 0x00, 0x00, // bufferSizeDB
        ...u32(0),        // maxBitrate
        ...u32(0),        // avgBitrate
        // DecoderSpecificInfo
        0x05, 2,
        asc0, asc1,
        // SLConfigDescriptor
        0x06, 1,
        0x02
      ]);
      const esds = fullBox('esds', 0, 0, esdsPayload);

      // ── stsd → mp4a ──
      const mp4aPayload = new Uint8Array([
        0,0,0,0,0,0,                       // reserved
        0,1,                               // data_reference_index = 1
        0,0,0,0,0,0,0,0,                   // reserved
        ...u16(audioData.channels),        // channelcount
        ...u16(16),                        // samplesize = 16 bits
        0,0,                               // pre_defined
        0,0,                               // reserved
        ...u16(Math.min(audioData.sampleRate, 65535)), ...u16(0) // samplerate 16.16 fixed
      ]);
      const mp4a = box('mp4a', mp4aPayload, esds);
      const audioStsd = fullBox('stsd', 0, 0, new Uint8Array(u32(1)), mp4a);

      // ── stts (constant 1024 samples per frame) ──
      const audioStts = fullBox('stts', 0, 0, new Uint8Array([
        ...u32(1),
        ...u32(audioData.samples.length),
        ...u32(1024)
      ]));

      // ── stsz ──
      const audioStszData = new Uint8Array(8 + audioData.samples.length * 4);
      audioStszData.set(u32(0), 0);
      audioStszData.set(u32(audioData.samples.length), 4);
      for (let i = 0; i < audioData.samples.length; i++) {
        audioStszData.set(u32(audioData.samples[i].data.length), 8 + i * 4);
      }
      const audioStsz = fullBox('stsz', 0, 0, audioStszData);

      // ── stsc + stco ──
      const audioStsc = fullBox('stsc', 0, 0, new Uint8Array([
        ...u32(1), ...u32(1), ...u32(audioData.samples.length), ...u32(1)
      ]));
      const audioStco = fullBox('stco', 0, 0, new Uint8Array([
        ...u32(1), ...u32(audioChunkOffset)
      ]));

      // ── Audio stbl → minf → mdia → trak ──
      const audioStbl = box('stbl', audioStsd, audioStts, audioStsz, audioStsc, audioStco);
      const smhd = fullBox('smhd', 0, 0, new Uint8Array([0,0, 0,0])); // balance + reserved
      const aUrl = fullBox('url ', 0, 1);
      const aDref = fullBox('dref', 0, 0, new Uint8Array(u32(1)), aUrl);
      const aDinf = box('dinf', aDref);
      const audioMinf = box('minf', smhd, aDinf, audioStbl);
      const audioHdlr = fullBox('hdlr', 0, 0, new Uint8Array([
        0,0,0,0, 0x73,0x6F,0x75,0x6E, 0,0,0,0, 0,0,0,0, 0,0,0,0,
        0x53,0x6F,0x75,0x6E,0x64,0
      ]));
      const audioMdhd = fullBox('mdhd', 0, 0, new Uint8Array([
        ...u32(0), ...u32(0), ...u32(audioTimescale), ...u32(audioTotalDuration),
        0x55,0xC4, 0,0
      ]));
      const audioMdia = box('mdia', audioMdhd, audioHdlr, audioMinf);
      const audioTkhd = fullBox('tkhd', 0, 3, new Uint8Array([
        ...u32(0), ...u32(0), ...u32(2), ...u32(0), ...u32(audioTkhdDuration),
        ...u32(0), ...u32(0), ...u16(0), ...u16(0),
        ...u16(0x0100),                 // volume = 1.0 (audio track)
        ...u16(0),
        ...u32(0x00010000), ...u32(0), ...u32(0),
        ...u32(0), ...u32(0x00010000), ...u32(0),
        ...u32(0), ...u32(0), ...u32(0x40000000),
        ...u16(0), ...u16(0), ...u16(0), ...u16(0) // width=0, height=0
      ]));
      audioTrak = box('trak', audioTkhd, audioMdia);
    }

    // ════════════════════════════════════════════════════
    //  MOOV (movie container)
    // ════════════════════════════════════════════════════

    const movieDuration = audioData
      ? Math.max(videoTotalDuration, audioTkhdDuration)
      : videoTotalDuration;
    const nextTrackId = audioData ? 3 : 2;

    const mvhd = fullBox('mvhd', 0, 0, new Uint8Array([
      ...u32(0), ...u32(0), ...u32(VIDEO_TIMESCALE), ...u32(movieDuration),
      ...u32(0x00010000), ...u16(0x0100),
      0,0, 0,0,0,0,0,0,0,0,
      ...u32(0x00010000), ...u32(0), ...u32(0),
      ...u32(0), ...u32(0x00010000), ...u32(0),
      ...u32(0), ...u32(0), ...u32(0x40000000),
      ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0),
      ...u32(nextTrackId)
    ]));

    const moovChildren = audioTrak ? [mvhd, videoTrak, audioTrak] : [mvhd, videoTrak];
    const moov = box('moov', ...moovChildren);

    // ── Concatenate: ftyp + mdat + moov ──
    const result = new Uint8Array(ftyp.length + mdat.length + moov.length);
    result.set(ftyp, 0);
    result.set(mdat, ftyp.length);
    result.set(moov, ftyp.length + mdat.length);
    return result.buffer;
  }

})();
