"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Session, SupabaseClient, User } from "@supabase/supabase-js";
import {
  createSupabaseBrowserClient,
  isSupabaseConfigured,
} from "@/lib/supabase/client";
import {
  claimActiveDevice,
  getAuthState,
  getOrCreateDeviceId,
  getProfile,
  syncProfileBase,
  type PersistedProfile,
} from "@/lib/supabase/appData";

type AuthContextType = {
  isConfigured: boolean;
  isLoading: boolean;
  session: Session | null;
  user: User | null;
  profile: PersistedProfile | null;
  client: SupabaseClient | null;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | null>(null);

async function bootstrapProfile(client: SupabaseClient, user: User) {
  const {
    data: { user: freshUser },
  } = await client.auth.getUser();
  const userToSync = freshUser ?? user;

  const profile = await syncProfileBase(client, userToSync);
  const deviceId = getOrCreateDeviceId();
  await claimActiveDevice(client, userToSync.id, deviceId);
  const freshProfile = await getProfile(client, userToSync.id);
  return freshProfile ?? profile;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const configured = isSupabaseConfigured();
  const [client] = useState<SupabaseClient | null>(() =>
    configured ? createSupabaseBrowserClient() : null
  );

  const [isLoading, setIsLoading] = useState(() => configured);
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<PersistedProfile | null>(null);

  useEffect(() => {
    if (!configured || !client) {
      return;
    }

    const supabase = client;
    let isMounted = true;

    const bootstrap = async () => {
      const {
        data: { session: initialSession },
      } = await supabase.auth.getSession();

      if (!isMounted) return;

      setSession(initialSession);
      setUser(initialSession?.user ?? null);

      if (initialSession?.user) {
        try {
          const nextProfile = await bootstrapProfile(supabase, initialSession.user);
          if (!isMounted) return;
          setProfile(nextProfile);
        } catch (error) {
          console.warn("[auth] Failed to bootstrap profile:", error);
        }
      }

      setIsLoading(false);
    };

    void bootstrap();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_, nextSession) => {
      setSession(nextSession);
      setUser(nextSession?.user ?? null);
      setIsLoading(false);

      if (nextSession?.user) {
        void (async () => {
          try {
            const nextProfile = await bootstrapProfile(supabase, nextSession.user);
            setProfile(nextProfile);
          } catch (error) {
            console.warn("[auth] Failed to sync profile after auth change:", error);
          }
        })();
      } else {
        setProfile(null);
      }
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, [client, configured]);

  useEffect(() => {
    if (!client || !user) return;

    let cancelled = false;
    const deviceId = getOrCreateDeviceId();

    const verifyCurrentDevice = async () => {
      try {
        const authState = await getAuthState(client, user.id);
        if (!cancelled && authState?.active_device_id && authState.active_device_id !== deviceId) {
          await client.auth.signOut();
        }
      } catch (error) {
        console.warn("[auth] Failed to verify active device:", error);
      }
    };

    void verifyCurrentDevice();
    const onFocus = () => {
      void verifyCurrentDevice();
    };

    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, [client, user]);

  const signInWithGoogle = async () => {
    if (!client) return;

    const redirectTo =
      typeof window !== "undefined"
        ? `${window.location.origin}/auth/callback?next=/`
        : undefined;

    const { error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
        queryParams: {
          prompt: "select_account",
        },
      },
    });

    if (error) {
      throw error;
    }
  };

  const signOut = async () => {
    if (!client) return;
    const { error } = await client.auth.signOut();
    if (error) {
      throw error;
    }
  };

  return (
    <AuthContext.Provider
      value={{
        isConfigured: configured,
        isLoading,
        session,
        user,
        profile,
        client,
        signInWithGoogle,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuthContext() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuthContext must be used within AuthProvider");
  }
  return context;
}
