// The phone's H.264 with its capture timestamps, as an MPEG-TS stream ffmpeg can read from a pipe.
// scrcpy prefixes each packet with a 12-byte header: a 64-bit PTS in µs (top bits are flags) and a 32-bit size.
// Raw H.264 has no timestamps, so without this ffmpeg could only stamp frames with their arrival time on the Mac.
import { Transform } from 'node:stream';

const FLAG_SESSION = 1n << 63n; // header-only packet (stream metadata, not requested)
const FLAG_CONFIG = 1n << 62n; // SPS/PPS, no timestamp
const FLAG_KEY = 1n << 61n;
const PTS_MASK = FLAG_KEY - 1n;
const MAX_PACKET = 64 << 20;

/** Split scrcpy's framed stream into packets: onPacket({ ptsUs, config, key, data }). */
export class ScrcpyPackets {
  constructor(onPacket) { this.onPacket = onPacket; this.buf = Buffer.alloc(0); }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let at = 0;
    while (this.buf.length - at >= 12) {
      const head = this.buf.readBigUInt64BE(at);
      if (head & FLAG_SESSION) { at += 12; continue; }
      const size = this.buf.readUInt32BE(at + 8);
      if (size > MAX_PACKET) throw new Error(`Malformed stream from the phone (packet of ${size} bytes)`);
      if (this.buf.length - at - 12 < size) break;
      const data = this.buf.subarray(at + 12, at + 12 + size);
      at += 12 + size;
      this.onPacket({ ptsUs: Number(head & PTS_MASK), config: !!(head & FLAG_CONFIG), key: !!(head & FLAG_KEY), data });
    }
    this.buf = this.buf.subarray(at);
  }
}

/** The 12-byte scrcpy packet header (used by tests and fakes to speak like the phone). */
export function scrcpyPacket(data, { ptsUs = 0, config = false, key = false } = {}) {
  const head = Buffer.alloc(12);
  head.writeBigUInt64BE(config ? FLAG_CONFIG : BigInt(ptsUs) | (key ? FLAG_KEY : 0n));
  head.writeUInt32BE(data.length, 8);
  return Buffer.concat([head, data]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, i) => {
  let c = i << 24;
  for (let k = 0; k < 8; k++) c = (c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1) >>> 0;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = ((c << 8) ^ CRC_TABLE[((c >>> 24) ^ b) & 0xff]) >>> 0;
  return c;
}

const PMT_PID = 0x1000, VIDEO_PID = 0x100;

/** A minimal single-program MPEG-TS muxer for one H.264 stream. Timestamps are 90 kHz ticks. */
export class TsMuxer {
  constructor() { this.cc = new Map(); }

  packet(pid, payload, { start = false, pcr, randomAccess = false } = {}) {
    const p = Buffer.alloc(188, 0xff);
    const cc = this.cc.get(pid) ?? 0;
    this.cc.set(pid, (cc + 1) & 15);
    p[0] = 0x47; p[1] = (start ? 0x40 : 0) | (pid >> 8); p[2] = pid & 0xff;
    let af = null; // adaptation field body, without its length byte
    if (pcr !== undefined) {
      af = Buffer.alloc(7);
      af[0] = 0x10 | (randomAccess ? 0x40 : 0);
      af.writeUInt32BE(Math.floor(pcr / 2), 1); // the 33-bit base, top 32 bits
      af[5] = ((pcr % 2) << 7) | 0x7e; af[6] = 0; // last base bit, reserved, 9-bit extension 0
    }
    const room = 184 - (af ? af.length + 1 : 0);
    const n = Math.min(room, payload.length);
    if (af || n < 184) {
      const stuffing = room - n - (af ? 0 : 1); // without an adaptation field yet, its length byte takes one
      const body = af ? Buffer.concat([af, Buffer.alloc(stuffing, 0xff)])
        : stuffing > 0 ? Buffer.concat([Buffer.from([0]), Buffer.alloc(stuffing - 1, 0xff)]) : Buffer.alloc(0);
      p[3] = 0x30 | cc; p[4] = body.length; body.copy(p, 5);
      payload.copy(p, 188 - n, 0, n);
    } else {
      p[3] = 0x10 | cc;
      payload.copy(p, 4, 0, n);
    }
    return { p, n };
  }

  section(pid, body) {
    const sec = Buffer.concat([body, Buffer.alloc(4)]);
    sec.writeUInt16BE(0xb000 | (sec.length - 3), 1); // section_syntax_indicator, length after this field
    sec.writeUInt32BE(crc32(sec.subarray(0, sec.length - 4)), sec.length - 4);
    return this.packet(pid, Buffer.concat([Buffer.from([0]), sec]), { start: true }).p; // pointer_field 0
  }

  tables() {
    const pat = Buffer.from([0x00, 0, 0, 0x00, 0x01, 0xc1, 0, 0, 0x00, 0x01, 0xe0 | (PMT_PID >> 8), PMT_PID & 0xff]);
    const pmt = Buffer.from([0x02, 0, 0, 0x00, 0x01, 0xc1, 0, 0, 0xe0 | (VIDEO_PID >> 8), VIDEO_PID & 0xff, 0xf0, 0x00,
      0x1b, 0xe0 | (VIDEO_PID >> 8), VIDEO_PID & 0xff, 0xf0, 0x00]);
    return [this.section(0, pat), this.section(PMT_PID, pmt)];
  }

  /** One access unit as TS packets (with PAT/PMT before key frames, so a reader can start there). */
  frame(data, pts90, key) {
    const pes = Buffer.alloc(14);
    pes.set([0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5]); // video stream, unbounded length, PTS only
    pes[9] = 0x21 | ((Math.floor(pts90 / 2 ** 30) & 7) << 1);
    pes.writeUInt16BE(((Math.floor(pts90 / 2 ** 15) & 0x7fff) << 1) | 1, 10);
    pes.writeUInt16BE(((pts90 & 0x7fff) << 1) | 1, 12);
    let rest = Buffer.concat([pes, data]);
    const out = key ? this.tables() : [];
    let first = true;
    while (rest.length) {
      const { p, n } = this.packet(VIDEO_PID, rest, first ? { start: true, pcr: pts90, randomAccess: key } : {});
      out.push(p); rest = rest.subarray(n); first = false;
    }
    return Buffer.concat(out);
  }
}

/**
 * scrcpy's framed stream in, MPEG-TS out. Timestamps start at 0 at the first frame and keep the
 * phone's own spacing; config packets (SPS/PPS) are sent with the frame that follows them.
 */
export function scrcpyToTs() {
  const mux = new TsMuxer();
  let origin = null, config = null, tables = false;
  const t = new Transform({
    transform(chunk, _enc, cb) {
      try { packets.push(chunk); cb(); } catch (e) { cb(e); }
    },
  });
  const packets = new ScrcpyPackets(({ ptsUs, config: isConfig, key, data }) => {
    if (isConfig) { config = config ? Buffer.concat([config, data]) : Buffer.from(data); return; }
    origin ??= ptsUs;
    const au = config ? Buffer.concat([config, data]) : data;
    config = null;
    if (!tables && !key) t.push(Buffer.concat(mux.tables()));
    tables = true;
    t.push(mux.frame(au, Math.max(0, Math.round((ptsUs - origin) * 0.09)) % 2 ** 33, key)); // wraps after 26 h, as TS does
  });
  return t;
}
