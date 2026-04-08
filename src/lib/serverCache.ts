type MemoryEntry = {
  value: string;
  expiresAt: number;
};

const memoryCache = new Map<string, MemoryEntry>();

const REDIS_REST_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.REDIS_REST_URL ||
  "";
const REDIS_REST_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.REDIS_REST_TOKEN ||
  "";

function isRedisEnabled() {
  return !!REDIS_REST_URL && !!REDIS_REST_TOKEN;
}

function memoryGet(key: string): string | null {
  const hit = memoryCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    memoryCache.delete(key);
    return null;
  }
  return hit.value;
}

function memorySet(key: string, value: string, ttlSeconds: number) {
  memoryCache.set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}

async function redisCommand(args: Array<string | number>): Promise<unknown | null> {
  if (!isRedisEnabled()) return null;

  try {
    const response = await fetch(REDIS_REST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_REST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
      cache: "no-store",
    });

    if (!response.ok) {
      const text = await response.text();
      console.warn("[serverCache] Redis request failed:", response.status, text.slice(0, 200));
      return null;
    }

    const data = await response.json();
    return (data as { result?: unknown } | null)?.result ?? null;
  } catch (error) {
    console.warn("[serverCache] Redis unavailable, falling back to memory:", error);
    return null;
  }
}

export async function getServerCacheString(key: string): Promise<string | null> {
  const memory = memoryGet(key);
  if (memory !== null) return memory;

  const remote = await redisCommand(["GET", key]);
  if (typeof remote === "string") {
    memorySet(key, remote, 60);
    return remote;
  }
  return null;
}

export async function setServerCacheString(params: {
  key: string;
  value: string;
  ttlSeconds: number;
}): Promise<void> {
  const { key, value, ttlSeconds } = params;
  memorySet(key, value, ttlSeconds);
  await redisCommand(["SETEX", key, ttlSeconds, value]);
}

export async function getServerCacheJson<T>(key: string): Promise<T | null> {
  const raw = await getServerCacheString(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function setServerCacheJson<T>(params: {
  key: string;
  value: T;
  ttlSeconds: number;
}): Promise<void> {
  await setServerCacheString({
    key: params.key,
    value: JSON.stringify(params.value),
    ttlSeconds: params.ttlSeconds,
  });
}

export function isSharedServerCacheEnabled() {
  return isRedisEnabled();
}
