"use strict";

const { createHash, timingSafeEqual } = require("node:crypto");

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1200;
const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_PROMPT_BYTES = 24 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 25_000;

function sendJson(res, status, body) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(body);
}

function isAuthorized(provided, expected) {
  if (typeof provided !== "string" || provided.length === 0 || Buffer.byteLength(provided, "utf8") > 512) {
    return false;
  }

  const expectedHash = createHash("sha256").update(expected, "utf8").digest();
  const providedHash = createHash("sha256").update(provided, "utf8").digest();
  return timingSafeEqual(expectedHash, providedHash);
}

function requestBodyBytes(req, body) {
  const contentLength = req.headers["content-length"];
  if (contentLength !== undefined) {
    if (!/^\d+$/.test(String(contentLength))) return { error: 400 };
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes)) return { error: 400 };
    if (declaredBytes > MAX_REQUEST_BYTES) return { error: 413 };
  }

  try {
    const serialized = JSON.stringify(body);
    if (typeof serialized !== "string") return { error: 400 };
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > MAX_REQUEST_BYTES) return { error: 413 };
    return { bytes };
  } catch {
    return { error: 400 };
  }
}

function validateRequestBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const bodyKeys = Object.keys(body);
  if (bodyKeys.length !== 1 || bodyKeys[0] !== "messages" || !Array.isArray(body.messages) || body.messages.length !== 1) {
    return null;
  }

  const message = body.messages[0];
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const messageKeys = Object.keys(message);
  if (messageKeys.length !== 2 || !messageKeys.includes("role") || !messageKeys.includes("content")) return null;
  if (message.role !== "user" || typeof message.content !== "string" || message.content.trim().length === 0) return null;
  if (Buffer.byteLength(message.content, "utf8") > MAX_PROMPT_BYTES) return null;

  return message.content;
}

async function readResponseLimited(response, limit) {
  if (!response.body) throw new Error("Missing upstream response body");
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > limit) {
        await reader.cancel();
        throw new Error("Upstream response exceeded limit");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  const expectedSecret = process.env.GAMEPLAN_INTERNAL_API_SECRET;
  if (typeof expectedSecret !== "string" || expectedSecret.length === 0) {
    return sendJson(res, 503, { error: "Service unavailable" });
  }

  if (!isAuthorized(req.headers["x-gameplan-internal-key"], expectedSecret)) {
    return sendJson(res, 401, { error: "Unauthorized" });
  }

  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType.trim())) {
    return sendJson(res, 415, { error: "Unsupported media type" });
  }

  const bodySize = requestBodyBytes(req, req.body);
  if (bodySize.error === 413) return sendJson(res, 413, { error: "Request too large" });
  if (bodySize.error) return sendJson(res, 400, { error: "Invalid request" });

  const prompt = validateRequestBody(req.body);
  if (!prompt) return sendJson(res, 400, { error: "Invalid request" });

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (typeof anthropicApiKey !== "string" || anthropicApiKey.length === 0) {
    return sendJson(res, 503, { error: "Service unavailable" });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicApiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: prompt }]
      }),
      signal: controller.signal
    });

    if (!upstream.ok) return sendJson(res, 502, { error: "Generation unavailable" });

    let providerResponse;
    try {
      providerResponse = JSON.parse(await readResponseLimited(upstream, MAX_RESPONSE_BYTES));
    } catch {
      return sendJson(res, 502, { error: "Generation unavailable" });
    }

    if (!providerResponse || !Array.isArray(providerResponse.content)) {
      return sendJson(res, 502, { error: "Generation unavailable" });
    }

    const content = providerResponse.content
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => ({ type: "text", text: part.text }));
    if (content.length === 0) return sendJson(res, 502, { error: "Generation unavailable" });

    return sendJson(res, 200, { content });
  } catch {
    return sendJson(res, controller.signal.aborted ? 504 : 502, { error: "Generation unavailable" });
  } finally {
    clearTimeout(timeout);
  }
};
