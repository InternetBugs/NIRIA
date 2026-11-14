import test from "node:test";
import assert from "node:assert/strict";
import { crc32, verifyNsisCrc } from "../scripts/nsis-integrity.mjs";

function fixture(flags = 1) {
  const bytes = Buffer.alloc(1024 + 28 + 64 + 4);
  bytes.write("MZ");
  bytes.writeUInt32LE(flags, 1024);
  Buffer.from("efbeadde4e756c6c736f6674496e7374", "hex").copy(bytes, 1028);
  bytes.writeUInt32LE(bytes.length - 1024, 1048);
  bytes.writeUInt32LE(crc32(bytes.subarray(512, -4)), bytes.length - 4);
  return bytes;
}

test("NSIS CRC uses the standard independent check vector", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});
test("NSIS verifies installer and uninstaller kinds", () => {
  assert.equal(verifyNsisCrc(fixture(), { uninstaller: true }).uninstaller, true);
  assert.equal(verifyNsisCrc(fixture(0)).uninstaller, false);
  assert.throws(() => verifyNsisCrc(fixture()), /kind/);
});
test("NSIS checks executable stub bytes after the first 512 bytes", () => {
  const bytes = fixture();
  bytes[700] ^= 1;
  assert.throws(() => verifyNsisCrc(bytes, { uninstaller: true }), /CRC mismatch/);
});
test("NSIS checks payload bytes and the stored CRC", () => {
  for (const position of [1080, 1119]) {
    const bytes = fixture();
    bytes[position] ^= 1;
    assert.throws(() => verifyNsisCrc(bytes, { uninstaller: true }), /CRC mismatch/);
  }
});
test("NSIS excludes the first 512 bytes from its CRC", () => {
  const bytes = fixture();
  bytes[100] ^= 1;
  assert.equal(verifyNsisCrc(bytes, { uninstaller: true }).uninstaller, true);
});
test("NSIS rejects disabled integrity checks and unknown flags", () => {
  assert.throws(() => verifyNsisCrc(fixture(5), { uninstaller: true }), /remain enabled/);
  assert.throws(() => verifyNsisCrc(fixture(17), { uninstaller: true }), /Unsupported/);
});
test("NSIS rejects truncated or incorrectly sized executables", () => {
  assert.throws(() => verifyNsisCrc(Buffer.alloc(30)), /Truncated/);
  assert.throws(() => verifyNsisCrc(fixture().subarray(0, -1), { uninstaller: true }), /length mismatch/);
});
test("NSIS rejects missing executable and NSIS signatures", () => {
  const bytes = fixture();
  bytes[0] = 0;
  assert.throws(() => verifyNsisCrc(bytes, { uninstaller: true }), /executable signature/);
  const missing = fixture();
  missing[1028] = 0;
  assert.throws(() => verifyNsisCrc(missing, { uninstaller: true }), /NSIS header/);
});
