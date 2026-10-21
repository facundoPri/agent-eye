/** Splits a concatenated JPEG stream (ffmpeg image2pipe/mjpeg) into whole frames. */
export class JpegSplitter {
  constructor(onFrame) { this.onFrame = onFrame; this.buf = Buffer.alloc(0); }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const start = this.buf.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) { this.buf = Buffer.alloc(0); return; }
      const end = this.buf.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) { this.buf = start ? this.buf.subarray(start) : this.buf; return; }
      this.onFrame(this.buf.subarray(start, end + 2));
      this.buf = this.buf.subarray(end + 2);
    }
  }
}
