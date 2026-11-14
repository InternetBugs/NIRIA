import assert from "node:assert/strict";

const signature = Buffer.from("efbeadde4e756c6c736f6674496e7374", "hex");
const table = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

export function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ table[(value ^ byte) & 255];
  return (value ^ 0xffffffff) >>> 0;
}

// Pinned NSIS builds are unsigned and include a CRC over everything after the
// first 512 bytes, excluding the stored CRC itself. This also checks the stub.
export function verifyNsisCrc(bytes, { uninstaller = false } = {}) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length >= 544, "Truncated NSIS executable");
  assert.equal(bytes.subarray(0, 2).toString("ascii"), "MZ", "Missing executable signature");
  let offset = -1;
  for (let position = 512; position + 28 <= bytes.length; position += 512) {
    if (bytes.subarray(position + 4, position + 20).equals(signature)) { offset = position; break; }
  }
  assert.notEqual(offset, -1, "Missing NSIS header");
  const flags = bytes.readUInt32LE(offset);
  assert.equal(flags & ~15, 0, "Unsupported NSIS flags");
  assert.equal(flags & 4, 0, "NSIS CRC checking must remain enabled");
  assert.equal(!!(flags & 1), uninstaller, "Unexpected NSIS executable kind");
  assert.equal(bytes.readUInt32LE(offset + 24), bytes.length - offset, "NSIS length mismatch");
  const actual = crc32(bytes.subarray(512, -4));
  assert.equal(actual, bytes.readUInt32LE(bytes.length - 4), "NSIS CRC mismatch");
  return { bytes: bytes.length, headerOffset: offset, uninstaller, crc32: actual.toString(16).padStart(8, "0").toUpperCase() };
}
