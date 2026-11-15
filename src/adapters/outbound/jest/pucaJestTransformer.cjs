"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/**
 * Jest transformer: serve active mutant buffers from globalThis.__PUCA_JEST_BUFFERS__.
 * Passthrough when no buffer is active. Must stay CommonJS so Jest can require() it.
 */

function stripModuleQuery(id) {
  const queryIndex = id.indexOf("?");
  const withoutQuery = queryIndex === -1 ? id : id.slice(0, queryIndex);
  const hashIndex = withoutQuery.indexOf("#");
  return hashIndex === -1 ? withoutQuery : withoutQuery.slice(0, hashIndex);
}

function normalizeModulePath(id) {
  const resolved = path.normalize(path.resolve(stripModuleQuery(id)));
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    try {
      const realDir = fs.realpathSync.native(path.dirname(resolved));
      return path.join(realDir, path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}

function lookupRamBuffer(buffers, id) {
  if (buffers == null) {
    return undefined;
  }
  const normalizedId = normalizeModulePath(id);
  const direct = buffers.get(normalizedId);
  if (direct != null) {
    return direct;
  }
  for (const [key, value] of buffers) {
    if (value == null) {
      continue;
    }
    if (normalizeModulePath(key) === normalizedId) {
      return value;
    }
  }
  return undefined;
}

function process(sourceText, sourcePath) {
  const buffers = globalThis.__PUCA_JEST_BUFFERS__;
  const buffered = lookupRamBuffer(buffers, sourcePath);
  return { code: buffered ?? sourceText };
}

function getCacheKey(sourceText, sourcePath) {
  const buffers = globalThis.__PUCA_JEST_BUFFERS__;
  const buffered = lookupRamBuffer(buffers, sourcePath);
  return crypto
    .createHash("sha1")
    .update(buffered ?? sourceText)
    .update("\0")
    .update(normalizeModulePath(sourcePath))
    .digest("hex");
}

module.exports = { process, getCacheKey };
