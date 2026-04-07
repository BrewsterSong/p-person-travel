const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_REST_URL || "";
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_REST_TOKEN || "";

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!redisUrl || !redisToken) {
  fail("Missing Redis env vars. Expected UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.");
}

async function redisCommand(args) {
  const response = await fetch(redisUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${redisToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  try {
    const parsed = JSON.parse(text);
    return parsed?.result;
  } catch {
    return text;
  }
}

try {
  const now = new Date().toISOString();
  const ttlSeconds = 60 * 60 * 24 * 7;

  const payload = JSON.stringify({
    source: "manual-keepalive",
    touchedAt: now,
  });

  await redisCommand(["SETEX", "codex:redis:keepalive", ttlSeconds, payload]);
  const stored = await redisCommand(["GET", "codex:redis:keepalive"]);

  console.log("Keepalive written at:", now);
  console.log("Stored value:", stored);
} catch (error) {
  fail(`Redis keepalive failed: ${error instanceof Error ? error.message : String(error)}`);
}
