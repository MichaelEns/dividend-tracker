/*
 * Pure authentication helpers for the sync worker.
 *
 * Separate from index.js because the Workers runtime treats every named export
 * of the entry module as an entrypoint - a service, a Durable Object, or a
 * WorkerEntrypoint - and refuses to start if one is not a function:
 *
 *   Uncaught TypeError: Incorrect type for map entry 'MIN_PASSPHRASE':
 *   the provided value is not of type 'function or ExportedHandler'.
 *
 * So a constant cannot be exported from index.js at all, and these need to be
 * exported to be testable. Keeping them here also means the security-critical
 * logic is a small file with no I/O in it.
 */

/**
 * The shortest normalised passphrase that will be accepted.
 *
 * Applied AFTER normalising, which is the subtle part: "..." folds to the
 * empty string, and so does any punctuation a caller sends, so without a floor
 * a punctuation-only secret would authorise everyone.
 */
export const MIN_PASSPHRASE = 8;

/**
 * Fold a passphrase to its comparable form.
 *
 * A passphrase is only usable if it can actually be typed, and phones fight
 * back: iOS autocorrects a straight apostrophe into a curly one, so "I'm"
 * typed on a phone is a different byte sequence from "I'm" typed on a laptop,
 * and the two would never match. Capitalisation and a trailing full stop are
 * just as easy to get wrong.
 *
 * So everything that is not a letter or a digit is dropped and the rest is
 * lowercased. "It's a lovely day, isn't it?" and
 * "itsalovelydayisntit" are the same passphrase.
 *
 * This trades a little entropy for a phrase that survives a phone keyboard. A
 * long phrase can afford that; a short one cannot, hence MIN_PASSPHRASE.
 *
 * There is a second reason, discovered only by trying it: an HTTP header value
 * is a byte string, so fetch throws outright on any character above U+00FF,
 * and a curly apostrophe is U+2019. The page folds before sending for exactly
 * that reason, which makes the header ASCII by construction. This must stay in
 * step with normalizePassphrase in docs/app.js.
 */
export function normalizePassphrase(value) {
  return String(value == null ? "" : value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Constant-time string comparison.
 *
 * A plain === leaks how many leading characters matched via its return time,
 * which lets an attacker recover the passphrase one character at a time. This
 * always inspects every byte of the expected value.
 */
export function timingSafeEqual(a, b) {
  const x = new TextEncoder().encode(String(a == null ? "" : a));
  const y = new TextEncoder().encode(String(b == null ? "" : b));
  // Length is not itself secret, but bail without a short-circuit on content.
  let diff = x.length ^ y.length;
  for (let i = 0; i < y.length; i += 1) {
    diff |= (x[i % (x.length || 1)] || 0) ^ y[i];
  }
  return diff === 0;
}

/**
 * Fail closed.
 *
 * An unset SYNC_PASSPHRASE must not mean "no auth required", or a deployment
 * that simply forgot the secret would publish its holdings to the internet.
 */
export function authorized(presented, env) {
  const expected = normalizePassphrase(env && env.SYNC_PASSPHRASE);
  if (expected.length < MIN_PASSPHRASE) return false;
  const given = normalizePassphrase(presented);
  if (!given) return false;
  return timingSafeEqual(given, expected);
}

/**
 * Fail closed, for the same reason.
 *
 * An unset ALLOWED_ORIGINS must not mean "allow everything": this worker mints
 * Plaid Link tokens against a real (billable) Plaid account and drives bank
 * sign-in flows, so an open worker is abusable by any other site. Requests are
 * only permitted from an explicitly configured origin.
 */
export function originAllowed(origin, env) {
  if (!origin) return false;
  const allowed = String((env && env.ALLOWED_ORIGINS) || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  if (allowed.length === 0) return false;
  return allowed.includes(String(origin).trim().replace(/\/+$/, ""));
}
