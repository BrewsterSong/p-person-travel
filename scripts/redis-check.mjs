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
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  return parsed?.result;
}

try {
  const ping = await redisCommand(["PING"]);
  console.log("PING:", ping);

  const key = "codex:redis:healthcheck";
  const value = new Date().toISOString();
  await redisCommand(["SETEX", key, 60, value]);
  const roundtrip = await redisCommand(["GET", key]);

  console.log("SETEX/GET:", roundtrip);
  console.log("Redis looks reachable and writable.");
} catch (error) {
  fail(`Redis check failed: ${error instanceof Error ? error.message : String(error)}`);
}
