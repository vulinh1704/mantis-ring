// PNG decoding, cropping and encoding for the vision check (spec §1.9, §2.9), with Node built-ins only.
// The vision model gets a BEFORE and an AFTER crop around one issue, cut out of Mantis's full-page
// screenshots, so this file reads what Chromium writes (8-bit RGB, sometimes RGBA) and writes small
// PNGs for data: URIs. Screenshots come out of the task's sandbox, so every input is treated as hostile:
// the pixel count is checked against the header before inflating, inflate output is capped at the size
// the header implies, and every chunk's CRC must match.
import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SIDE = 0x7fffffff; // the PNG limit for width, height and chunk length

// CRC-32 as PNG uses it (ISO 3309), one table lookup per byte.
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function asBuffer(data, who) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError(`${who}: expected a Buffer`);
}

function readHeader(h, maxPixels) {
  const width = h.readUInt32BE(0);
  const height = h.readUInt32BE(4);
  const [depth, colorType, compression, filter, interlace] = h.subarray(8, 13);
  if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) throw new Error(`PNG has an invalid size ${width}×${height}`);
  if (depth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG: bit depth ${depth}, colour type ${colorType} (only 8-bit RGB or RGBA is read)`);
  }
  if (interlace !== 0) throw new Error('unsupported PNG: interlaced');
  if (compression !== 0 || filter !== 0) throw new Error('unsupported PNG: unknown compression or filter method');
  if (width * height > maxPixels) throw new Error(`PNG is too large: ${width}×${height} pixels (limit ${maxPixels})`);
  return { width, height, channels: colorType === 6 ? 4 : 3 };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Undo one row's filter in place. `prev` is the row above, already unfiltered (zeros for the first row).
// Uint8 stores wrap modulo 256, which is exactly the arithmetic the PNG filters use.
function unfilter(type, row, prev, bpp, y) {
  const n = row.length;
  switch (type) {
    case 0: // None
      return;
    case 1: // Sub: add the byte one pixel to the left
      for (let i = bpp; i < n; i++) row[i] += row[i - bpp];
      return;
    case 2: // Up: add the byte above
      for (let i = 0; i < n; i++) row[i] += prev[i];
      return;
    case 3: // Average of left and above
      for (let i = 0; i < bpp; i++) row[i] += prev[i] >> 1;
      for (let i = bpp; i < n; i++) row[i] += (row[i - bpp] + prev[i]) >> 1;
      return;
    case 4: // Paeth; in the first pixel left and upper-left are 0, so the predictor is the byte above
      for (let i = 0; i < bpp; i++) row[i] += prev[i];
      for (let i = bpp; i < n; i++) row[i] += paeth(row[i - bpp], prev[i], prev[i - bpp]);
      return;
    default:
      throw new Error(`PNG row ${y} has an unknown filter type ${type}`);
  }
}

/**
 * Decode a PNG into raw pixels: rows top to bottom, `channels` bytes per pixel, no padding.
 * Only 8-bit, non-interlaced RGB (colour type 2) and RGBA (6) are read; anything else throws
 * 'unsupported PNG: …'. A damaged file throws a plain error. The size in the header is checked against
 * `maxPixels` before anything is inflated, and inflate may not produce more than that size implies.
 * @param {Buffer|Uint8Array} buf
 * @param {{maxPixels?: number}} [opts]
 * @returns {{width: number, height: number, channels: 3|4, data: Buffer}}
 */
export function decodePng(buf, { maxPixels = 40e6 } = {}) {
  const png = asBuffer(buf, 'decodePng');
  if (!(maxPixels > 0)) throw new TypeError('decodePng: maxPixels must be a positive number');
  if (png.length < 8 || !png.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG file');
  let header = null;
  const idat = [];
  let off = 8;
  while (off < png.length) {
    if (off + 12 > png.length) throw new Error('PNG is truncated');
    const len = png.readUInt32BE(off);
    const type = png.toString('latin1', off + 4, off + 8);
    const end = off + 8 + len;
    if (len > MAX_SIDE || end + 4 > png.length) throw new Error('PNG is truncated');
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error('PNG has an invalid chunk type');
    if (crc32(png, off + 4, end) !== png.readUInt32BE(end)) throw new Error(`PNG chunk ${type} has a bad CRC`);
    const body = png.subarray(off + 8, end);
    off = end + 4;
    if (!header) {
      if (type !== 'IHDR' || len !== 13) throw new Error('PNG does not start with a valid IHDR chunk');
      header = readHeader(body, maxPixels);
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    } else if (type === 'IHDR') {
      throw new Error('PNG has a second IHDR chunk');
    } else if (type !== 'PLTE' && /^[A-Z]/.test(type)) {
      // An uppercase first letter marks a critical chunk: a decoder must not skip one it does not know.
      throw new Error(`unsupported PNG: critical chunk ${type}`);
    }
  }
  if (!header) throw new Error('PNG has no IHDR chunk');
  if (!idat.length) throw new Error('PNG has no image data');

  const { width, height, channels } = header;
  const stride = width * channels;
  const size = (stride + 1) * height; // = width*height*channels + height: each row starts with a filter byte
  let raw;
  try {
    raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: size });
  } catch (err) {
    if (err?.code === 'ERR_BUFFER_TOO_LARGE') throw new Error('PNG image data is larger than its header says');
    throw new Error(`PNG image data is damaged (${err?.message ?? err})`);
  }
  if (raw.length !== size) throw new Error('PNG image data is shorter than its header says');

  // Unfilter in place (row y keeps its offset y*(stride+1)+1), then close the gaps the filter bytes
  // leave. Working in one buffer keeps the peak memory at one copy of the image, not two.
  const zero = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    unfilter(raw[at], raw.subarray(at + 1, at + 1 + stride), y ? raw.subarray(at - stride, at) : zero, channels, y);
  }
  for (let y = 0; y < height; y++) raw.copy(raw, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  return { width, height, channels, data: raw.subarray(0, stride * height) };
}

function chunk(type, body) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'latin1');
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + body.length), 8 + body.length);
  return out;
}

/**
 * Encode raw pixels as an 8-bit RGB or RGBA PNG: filter 0 (None) on every row, one IDAT chunk made
 * with zlib.deflateSync, CRCs from the table above.
 * @param {{width: number, height: number, channels: 3|4, data: Buffer|Uint8Array}} img
 * @returns {Buffer}
 */
export function encodePng({ width, height, channels, data } = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) {
    throw new TypeError('encodePng: width and height must be positive integers');
  }
  if (channels !== 3 && channels !== 4) throw new TypeError('encodePng: channels must be 3 (RGB) or 4 (RGBA)');
  const pixels = asBuffer(data, 'encodePng');
  const stride = width * channels;
  if (pixels.length !== stride * height) {
    throw new TypeError(`encodePng: data has ${pixels.length} bytes, expected ${stride * height} (width × height × channels)`);
  }
  const raw = Buffer.alloc((stride + 1) * height); // the filter byte of every row stays 0
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13); // compression, filter and interlace methods stay 0
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Cut a box out of decoded pixels. The box is clipped to the image (fractions widen it to whole
 * pixels); a box that misses the image entirely throws.
 * @param {{width: number, height: number, channels: 3|4, data: Buffer}} img  as returned by decodePng
 * @param {{x: number, y: number, width: number, height: number}} box
 * @returns {{width: number, height: number, channels: 3|4, data: Buffer}}
 */
export function cropImage(img, box) {
  const { width: w, height: h, channels: ch, data } = img ?? {};
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || (ch !== 3 && ch !== 4) || !data || data.length !== w * h * ch) {
    throw new TypeError('cropImage: expected a decoded image {width, height, channels, data}');
  }
  if (![box?.x, box?.y, box?.width, box?.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) {
    throw new TypeError('cropImage: the box needs finite x and y and a positive width and height');
  }
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(w, Math.ceil(box.x + box.width));
  const y1 = Math.min(h, Math.ceil(box.y + box.height));
  if (x1 <= x0 || y1 <= y0) throw new Error('the crop box is outside the image');
  const rowBytes = (x1 - x0) * ch;
  const out = Buffer.alloc(rowBytes * (y1 - y0));
  for (let y = y0; y < y1; y++) data.copy(out, (y - y0) * rowBytes, (y * w + x0) * ch, (y * w + x1) * ch);
  return { width: x1 - x0, height: y1 - y0, channels: ch, data: out };
}

/**
 * Decode a PNG, cut out a box (clipped to the image, see cropImage) and encode the result.
 * @param {Buffer} buf
 * @param {{x: number, y: number, width: number, height: number}} box
 * @param {{maxPixels?: number}} [opts]  passed to decodePng
 * @returns {Buffer}
 */
export function cropPng(buf, box, opts = {}) {
  return encodePng(cropImage(decodePng(buf, opts), box));
}

// One axis of cropBox: the rect plus padding, grown to `min` and cut to `max` around the rect's
// centre, slid inside [0, limit], and clipped to the image when the image is smaller than that.
function span(start, size, pad, min, max, limit) {
  const len = Math.min(Math.max(size + 2 * pad, min), max);
  let a = start + size / 2 - len / 2;
  a = Math.min(a, limit - len);
  a = Math.max(a, 0);
  const lo = Math.floor(a);
  const hi = Math.min(limit, Math.ceil(a + len));
  return [lo, Math.max(1, hi - lo)];
}

/**
 * The area to crop around an issue: `rect` (in document pixels, which are screenshot pixels at scale 1)
 * plus `pad` on every side, at least minW×minH and at most maxW×maxH, centred on the rect and kept
 * inside the image. Whole pixels. A rect that does not touch the image throws.
 * @param {{x: number, y: number, width: number, height: number}} rect
 * @param {number} imgW
 * @param {number} imgH
 * @param {{pad?: number, minW?: number, minH?: number, maxW?: number, maxH?: number}} [opts]
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function cropBox(rect, imgW, imgH, { pad = 96, minW = 360, minH = 240, maxW = 1200, maxH = 1200 } = {}) {
  if (![rect?.x, rect?.y, rect?.width, rect?.height].every(Number.isFinite) || rect.width < 0 || rect.height < 0) {
    throw new TypeError('cropBox: rect needs finite x, y, width and height');
  }
  if (!Number.isInteger(imgW) || !Number.isInteger(imgH) || imgW < 1 || imgH < 1) {
    throw new TypeError('cropBox: the image width and height must be positive integers');
  }
  if (![pad, minW, minH, maxW, maxH].every((n) => Number.isFinite(n) && n >= 0) || maxW < 1 || maxH < 1) {
    throw new TypeError('cropBox: pad and the size limits must be non-negative numbers');
  }
  if (rect.x >= imgW || rect.y >= imgH || rect.x + rect.width < 0 || rect.y + rect.height < 0) {
    throw new Error('the area is outside the screenshot');
  }
  const [x, width] = span(rect.x, rect.width, pad, minW, maxW, imgW);
  const [y, height] = span(rect.y, rect.height, pad, minH, maxH, imgH);
  return { x, y, width, height };
}

/**
 * Self-test (spec U9): a round trip in RGB and RGBA, crop pixels, the maxPixels refusal and the
 * 'unsupported PNG' refusal. With `sample` (a real screenshot), it also crops an area in the middle
 * of it, decodes the crop again and compares the pixels with the source.
 * @param {Buffer} [sample]
 * @returns {string[]} the names of the checks that passed; throws on the first one that fails
 */
export function pngSelfTest(sample) {
  const passed = [];
  const check = (name, ok) => {
    if (!ok) throw new Error(`png self-test failed: ${name}`);
    passed.push(name);
  };
  const refuses = (fn, pattern) => {
    try {
      fn();
      return false;
    } catch (err) {
      return pattern.test(err.message);
    }
  };
  for (const channels of [3, 4]) {
    const kind = channels === 3 ? 'RGB' : 'RGBA';
    const img = { width: 7, height: 5, channels, data: Buffer.alloc(7 * 5 * channels) };
    for (let i = 0; i < img.data.length; i++) img.data[i] = (i * 37 + 11) & 0xff;
    const png = encodePng(img);
    const back = decodePng(png);
    check(`round trip ${kind}`, back.width === 7 && back.height === 5 && back.channels === channels && back.data.equals(img.data));
    const crop = decodePng(cropPng(png, { x: 2, y: 1, width: 3, height: 2 }));
    const want = Buffer.concat([1, 2].map((y) => img.data.subarray((y * 7 + 2) * channels, (y * 7 + 5) * channels)));
    check(`crop pixels ${kind}`, crop.width === 3 && crop.height === 2 && crop.data.equals(want));
  }
  const big = encodePng({ width: 64, height: 64, channels: 3, data: Buffer.alloc(64 * 64 * 3) });
  check('maxPixels refusal', refuses(() => decodePng(big, { maxPixels: 1000 }), /too large/));
  const palette = Buffer.from(big);
  palette[25] = 3; // IHDR colour type: palette
  palette.writeUInt32BE(crc32(palette, 12, 29), 29);
  check('unsupported PNG refusal', refuses(() => decodePng(palette), /^unsupported PNG/));
  if (sample) {
    const img = decodePng(sample);
    const box = cropBox({ x: img.width / 2 - 20, y: img.height / 2 - 20, width: 40, height: 40 }, img.width, img.height);
    const back = decodePng(cropPng(sample, box));
    check('sample crop', back.width === box.width && back.height === box.height && back.data.equals(cropImage(img, box).data));
  }
  return passed;
}
