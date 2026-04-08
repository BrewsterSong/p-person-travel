import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json(
    { error: "Post detail fetch is not implemented in the SerpApi discovery-only Reddit integration." },
    { status: 501 }
  );
}
