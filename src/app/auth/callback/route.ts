import { NextResponse } from "next/server";
import {
  createSupabaseServerClient,
  isSupabaseServerConfigured,
} from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") || "/";

  if (code && isSupabaseServerConfigured()) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
      console.error("[auth] Failed to exchange OAuth code for session:", error);
      return NextResponse.redirect(new URL("/?auth_error=callback_failed", url.origin));
    }
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
