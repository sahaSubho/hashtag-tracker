import { createHash } from "node:crypto";

const CONTROL_CHARS_EXCEPT_NEWLINE_TAB = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
const ZERO_WIDTH_CHARS = /[​-‍﻿]/g;
const WHITESPACE_RUN = /\s+/g;

const MIN_HASHABLE_LENGTH = 40;

/** Removes NUL and other C0 control characters, but keeps \n and \t. */
export function stripControlChars(raw: string): string {
  return raw.replace(CONTROL_CHARS_EXCEPT_NEWLINE_TAB, "");
}

/**
 * Normalizes a caption for repost comparison: Unicode NFKC, lowercase,
 * zero-width characters removed, whitespace collapsed, trimmed.
 */
export function normalizeCaption(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(ZERO_WIDTH_CHARS, "")
    .replace(WHITESPACE_RUN, " ")
    .trim();
}

/**
 * A stable hash of a normalized caption, used to detect probable reposts.
 * Returns null when the caption is missing or its normalized form is too
 * short to be a reliable signal (short captions like "matcha 🍵" would
 * otherwise cause false matches between unrelated posts).
 */
export function captionNormHash(raw: string | null): string | null {
  if (raw === null) return null;
  const normalized = normalizeCaption(raw);
  if (normalized.length < MIN_HASHABLE_LENGTH) return null;
  return createHash("sha256").update(normalized).digest("hex");
}
