// Event ids: UUIDv7 (RFC 9562), generated in the app so they increase with
// insertion order. Events sort by `at`, then `id` (spec D), so two events with
// the same `at` (a discovered event and an immediate status change, say) come
// back in the order they were written. A random v4 id would order them by chance.
import { randomBytes } from "node:crypto";

let lastMs = 0;
let seq = 0;

/**
 * A new UUIDv7. The 48-bit timestamp is the wall clock in milliseconds; the
 * 12-bit rand_a field is a counter within one millisecond (RFC 9562 method 1),
 * so ids from this process are strictly increasing. The remaining 62 bits are random.
 */
export function newEventId(): string {
  let ms = Date.now();
  if (ms <= lastMs) {
    ms = lastMs;
    seq += 1;
    if (seq > 0xfff) {
      ms += 1;
      seq = 0;
    }
  } else {
    seq = 0;
  }
  lastMs = ms;

  const bytes = randomBytes(16);
  bytes.writeUIntBE(ms, 0, 6);
  bytes[6] = 0x70 | (seq >> 8);
  bytes[7] = seq & 0xff;
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
