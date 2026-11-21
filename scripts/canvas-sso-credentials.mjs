#!/usr/bin/env node
/**
 * Pinned `duegood-canvas-sso` broker consumer. The broker supplies the Marymount
 * SSO username, password, and TOTP seed in the environment. This helper hands the
 * username, password, and short-lived one-time passcodes to the session broker on
 * file descriptor 3 only. The TOTP seed never leaves this process, and no value is
 * ever written to stdout, stderr, argv, or disk.
 */
import { createHmac } from "node:crypto";
import { fstatSync, writeSync } from "node:fs";
import { isatty } from "node:tty";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SSO_USERNAME_ENV = "DUEGOOD_SSO_USERNAME";
export const SSO_PASSWORD_ENV = "DUEGOOD_SSO_PASSWORD";
export const SSO_TOTP_SEED_ENV = "DUEGOOD_SSO_TOTP_SEED";
export const HANDOFF_FD = 3;
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Codes for the current window and the next two cover a sign-in of up to about a minute. */
export const TOTP_WINDOWS = 3;
const MAX_FIELD_LENGTH = 256;

export class SsoCredentialError extends Error {
  constructor(code) {
    super(code);
    this.name = "SsoCredentialError";
    this.code = code;
  }
}

function fail(code) {
  throw new SsoCredentialError(code);
}

/** Decodes an RFC 4648 base32 seed, ignoring spaces, hyphens, padding, and case. */
export function decodeBase32Seed(value) {
  if (typeof value !== "string") fail("TOTP_SEED_INVALID");
  const normalized = value.replace(/[\s-]/gu, "").replace(/=+$/u, "").toUpperCase();
  if (normalized.length < 16 || normalized.length > 128 || !/^[A-Z2-7]+$/u.test(normalized)) {
    fail("TOTP_SEED_INVALID");
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const character of normalized) {
    buffer = (buffer << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP (HMAC-SHA1, 30-second step, 6 digits) for one time counter. */
export function totpForCounter(key, counter) {
  if (!Buffer.isBuffer(key) || key.length === 0 || !Number.isSafeInteger(counter) || counter < 0) {
    fail("TOTP_INPUT_INVALID");
  }
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/** Returns passcodes for the current and following windows with their validity bounds. */
export function passcodeWindows(key, nowMs = Date.now()) {
  const counter = Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
  return Array.from({ length: TOTP_WINDOWS }, (_, index) => ({
    notBefore: (counter + index) * TOTP_STEP_SECONDS * 1000,
    notAfter: (counter + index + 1) * TOTP_STEP_SECONDS * 1000,
    code: totpForCounter(key, counter + index),
  }));
}

function boundedField(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_FIELD_LENGTH
      || [...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) fail(code);
  return value;
}

/** Builds the handoff object from broker-supplied environment values. */
export function buildHandoff(environment, nowMs = Date.now()) {
  const username = boundedField(environment[SSO_USERNAME_ENV], "USERNAME_UNAVAILABLE");
  if (!/^[A-Za-z0-9._@+-]{1,128}$/u.test(username)) fail("USERNAME_UNAVAILABLE");
  const password = boundedField(environment[SSO_PASSWORD_ENV], "PASSWORD_UNAVAILABLE");
  const seed = environment[SSO_TOTP_SEED_ENV];
  if (typeof seed !== "string" || seed.length === 0) fail("TOTP_SEED_UNAVAILABLE");
  const key = decodeBase32Seed(seed);
  try {
    return { format: "duegood-sso-handoff", version: 1, username, password, passcodes: passcodeWindows(key, nowMs) };
  } finally {
    key.fill(0);
  }
}

/** Accepts only a pipe or socket on the handoff descriptor, never a terminal or file. */
export function assertHandoffDescriptor(fd = HANDOFF_FD, { fstat = fstatSync, tty = isatty } = {}) {
  let stat;
  try { stat = fstat(fd); } catch { fail("HANDOFF_UNAVAILABLE"); }
  if (tty(fd) || !(stat.isFIFO() || stat.isSocket())) fail("HANDOFF_UNAVAILABLE");
}

function writeAll(fd, text) {
  const bytes = Buffer.from(text, "utf8");
  let offset = 0;
  try {
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
  } finally {
    bytes.fill(0);
  }
}

/** Entry point: validate the descriptor first, then emit one JSON line on it. */
export function main({ environment = process.env, fd = HANDOFF_FD, now = Date.now, descriptorCheck = assertHandoffDescriptor } = {}) {
  try {
    descriptorCheck(fd);
    writeAll(fd, `${JSON.stringify(buildHandoff(environment, now()))}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof SsoCredentialError ? error.code : "HANDOFF_FAILED";
    process.stderr.write(`DUEGOOD_SSO_HANDOFF=${code}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    process.stderr.write("DUEGOOD_SSO_HANDOFF=ARGUMENTS_REJECTED\n");
    process.exitCode = 2;
  } else {
    process.exitCode = main();
  }
}
