"use client";

import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { ChatMessage } from "@/types/chat";
import type { Location } from "@/hooks/useLocation";

export const SESSION_TIMEOUT_MS = 72 * 60 * 60 * 1000;
export const INITIAL_MESSAGE_PAGE_SIZE = 5;
export const OLDER_MESSAGE_PAGE_SIZE = 10;

export type PersistedProfile = {
  id: string;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
  last_lat: number | null;
  last_lng: number | null;
  last_address: string | null;
  last_timezone: string | null;
  last_location_source: string | null;
  last_location_at: string | null;
  active_session_id: string | null;
  session_version: number | null;
  created_at: string;
  updated_at: string;
};

export type PersistedChatSession = {
  id: string;
  user_id: string;
  started_at: string;
  last_message_at: string;
  ended_at: string | null;
  status: string;
  timezone_at_start: string | null;
  location_snapshot: Record<string, unknown> | null;
  created_at: string;
};

export type PersistedChatMessage = {
  id: string;
  session_id: string;
  user_id: string;
  role: "system" | "user" | "assistant";
  message_type: "system" | "user" | "assistant";
  content: string;
  meta: Record<string, unknown> | null;
  created_at: string;
};

export type PersistedAuthState = {
  user_id: string;
  active_device_id: string | null;
  session_version: number;
  updated_at: string;
};

function toMeta(message: ChatMessage): Record<string, unknown> | null {
  const meta = {
    placesSnapshot: message.placesSnapshot ?? null,
    recommendations: message.recommendations ?? null,
    discussions: message.discussions ?? null,
    ...message.meta,
  };
  const hasValue = Object.values(meta).some((value) => value !== null && value !== undefined);
  return hasValue ? meta : null;
}

export function serializeChatMessage(message: ChatMessage & { id: string }, params: {
  sessionId: string;
  userId: string;
}): Omit<PersistedChatMessage, "id"> {
  return {
    session_id: params.sessionId,
    user_id: params.userId,
    role: message.role,
    message_type: message.messageType || message.role,
    content: message.content,
    meta: toMeta(message),
    created_at: message.createdAt || new Date().toISOString(),
  };
}

export function deserializeChatMessage(row: PersistedChatMessage): ChatMessage & { id: string } {
  const meta = row.meta || {};
  const placesSnapshot = Array.isArray(meta.placesSnapshot)
    ? meta.placesSnapshot
    : undefined;
  const recommendations = Array.isArray(meta.recommendations)
    ? meta.recommendations
    : undefined;
  const discussions = Array.isArray(meta.discussions)
    ? meta.discussions
    : undefined;

  return {
    id: row.id,
    role: row.role,
    messageType: row.message_type,
    content: row.content,
    createdAt: row.created_at,
    placesSnapshot,
    recommendations,
    discussions,
    meta,
  };
}

export function getOrCreateDeviceId() {
  if (typeof window === "undefined") return "server";

  const key = "auth_device_id";
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;

  const value =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `device-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  window.localStorage.setItem(key, value);
  return value;
}

export async function syncProfileBase(client: SupabaseClient, user: User) {
  const existingProfile = await getProfile(client, user.id);
  const metadata = user.user_metadata ?? {};
  const identities = Array.isArray(user.identities) ? user.identities : [];
  const identityAvatar = identities
    .map((identity) => {
      const identityData =
        identity && typeof identity === "object" && "identity_data" in identity
          ? identity.identity_data
          : null;
      if (!identityData || typeof identityData !== "object") return null;

      const avatarUrl =
        ("avatar_url" in identityData && typeof identityData.avatar_url === "string"
          ? identityData.avatar_url
          : null) ||
        ("picture" in identityData && typeof identityData.picture === "string"
          ? identityData.picture
          : null);

      if (!avatarUrl) return null;
      const trimmed = avatarUrl.trim();
      return trimmed && trimmed !== "null" && trimmed !== "undefined" ? trimmed : null;
    })
    .find((value): value is string => !!value);
  const nextName =
    (typeof metadata.full_name === "string" && metadata.full_name) ||
    (typeof metadata.name === "string" && metadata.name) ||
    existingProfile?.name ||
    null;
  const nextAvatarUrl =
    (typeof metadata.avatar_url === "string" && metadata.avatar_url.trim() && metadata.avatar_url.trim() !== "null" && metadata.avatar_url.trim() !== "undefined"
      ? metadata.avatar_url.trim()
      : null) ||
    (typeof metadata.picture === "string" && metadata.picture.trim() && metadata.picture.trim() !== "null" && metadata.picture.trim() !== "undefined"
      ? metadata.picture.trim()
      : null) ||
    identityAvatar ||
    existingProfile?.avatar_url ||
    null;

  const { data, error } = await client
    .from("profiles")
    .upsert(
      {
        id: user.id,
        email: user.email ?? null,
        name: nextName,
        avatar_url: nextAvatarUrl,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    )
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return data as PersistedProfile;
}

export async function claimActiveDevice(client: SupabaseClient, userId: string, deviceId: string) {
  const { data: existing, error: readError } = await client
    .from("user_auth_state")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (readError) {
    throw readError;
  }

  const nextVersion = ((existing as PersistedAuthState | null)?.session_version ?? 0) + 1;

  const { data, error } = await client
    .from("user_auth_state")
    .upsert(
      {
        user_id: userId,
        active_device_id: deviceId,
        session_version: nextVersion,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    )
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  await client
    .from("profiles")
    .update({
      session_version: nextVersion,
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId);

  return data as PersistedAuthState;
}

export async function getAuthState(client: SupabaseClient, userId: string) {
  const { data, error } = await client
    .from("user_auth_state")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data ?? null) as PersistedAuthState | null;
}

export async function saveProfileLocation(client: SupabaseClient, userId: string, location: Location) {
  const { error } = await client
    .from("profiles")
    .update({
      last_lat: location.lat,
      last_lng: location.lng,
      last_address: location.address ?? null,
      last_timezone: location.timezone ?? null,
      last_location_source: location.source ?? null,
      last_location_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId);

  if (error) {
    throw error;
  }
}

export async function getProfile(client: SupabaseClient, userId: string) {
  const { data, error } = await client
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data ?? null) as PersistedProfile | null;
}

export async function createChatSession(client: SupabaseClient, params: {
  userId: string;
  location: Location | null;
}) {
  const now = new Date().toISOString();
  const { data, error } = await client
    .from("chat_sessions")
    .insert({
      user_id: params.userId,
      started_at: now,
      last_message_at: now,
      status: "active",
      timezone_at_start: params.location?.timezone ?? null,
      location_snapshot: params.location
        ? {
            lat: params.location.lat,
            lng: params.location.lng,
            address: params.location.address ?? null,
            timezone: params.location.timezone ?? null,
            source: params.location.source ?? null,
          }
        : null,
    })
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  await client
    .from("profiles")
    .update({
      active_session_id: data.id,
      updated_at: now,
    })
    .eq("id", params.userId);

  return data as PersistedChatSession;
}

export async function markSessionInactive(client: SupabaseClient, sessionId: string) {
  const { error } = await client
    .from("chat_sessions")
    .update({
      status: "closed",
      ended_at: new Date().toISOString(),
    })
    .eq("id", sessionId);

  if (error) {
    throw error;
  }
}

export async function getChatSession(client: SupabaseClient, sessionId: string) {
  const { data, error } = await client
    .from("chat_sessions")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data ?? null) as PersistedChatSession | null;
}

export async function getLatestChatSession(client: SupabaseClient, userId: string) {
  const { data, error } = await client
    .from("chat_sessions")
    .select("*")
    .eq("user_id", userId)
    .order("last_message_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data ?? null) as PersistedChatSession | null;
}

export async function getPreviousChatSession(client: SupabaseClient, params: {
  userId: string;
  beforeLastMessageAt: string;
  excludeSessionId?: string;
}) {
  let query = client
    .from("chat_sessions")
    .select("*")
    .eq("user_id", params.userId)
    .lt("last_message_at", params.beforeLastMessageAt)
    .order("last_message_at", { ascending: false })
    .limit(1);

  if (params.excludeSessionId) {
    query = query.neq("id", params.excludeSessionId);
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    throw error;
  }

  return (data ?? null) as PersistedChatSession | null;
}

export async function appendChatMessages(client: SupabaseClient, messages: Array<Omit<PersistedChatMessage, "id">>) {
  if (messages.length === 0) return [] as PersistedChatMessage[];

  const { data, error } = await client
    .from("chat_messages")
    .insert(messages)
    .select("*");

  if (error) {
    throw error;
  }

  const last = messages[messages.length - 1];
  await client
    .from("chat_sessions")
    .update({
      last_message_at: last.created_at,
    })
    .eq("id", last.session_id);

  return ((data ?? []) as PersistedChatMessage[]).sort((a, b) => {
    const timeDiff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    if (timeDiff !== 0) return timeDiff;

    const roleOrder = { system: 0, user: 1, assistant: 2 } as const;
    return roleOrder[a.role] - roleOrder[b.role];
  });
}

export async function fetchChatMessagesPage(client: SupabaseClient, params: {
  sessionId: string;
  limit: number;
  beforeCreatedAt?: string;
}) {
  let query = client
    .from("chat_messages")
    .select("*")
    .eq("session_id", params.sessionId)
    .order("created_at", { ascending: false })
    .limit(params.limit);

  if (params.beforeCreatedAt) {
    query = query.lt("created_at", params.beforeCreatedAt);
  }

  const { data, error } = await query;
  if (error) {
    throw error;
  }

  const rows = ((data ?? []) as PersistedChatMessage[]).reverse();
  return rows;
}

export function shouldRotateSession(session: PersistedChatSession | null) {
  if (!session?.last_message_at) return true;
  return Date.now() - new Date(session.last_message_at).getTime() > SESSION_TIMEOUT_MS;
}
