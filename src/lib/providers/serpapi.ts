type SerpApiOrganicResult = {
  title?: string;
  link?: string;
  snippet?: string;
  source?: string;
  displayed_link?: string;
  thumbnail?: string;
};

type SerpApiSearchResponse = {
  error?: string;
  organic_results?: SerpApiOrganicResult[];
};

const SERPAPI_KEY = process.env.SERPAPI_KEY || "";

function assertSerpApiConfigured() {
  if (!SERPAPI_KEY) {
    throw new Error("Missing SERPAPI_KEY");
  }
}

export type GoogleOrganicResult = SerpApiOrganicResult;

export async function searchGoogleWithSerpApi(params: {
  query: string;
  num?: number;
}): Promise<GoogleOrganicResult[]> {
  assertSerpApiConfigured();

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google");
  url.searchParams.set("q", params.query);
  url.searchParams.set("api_key", SERPAPI_KEY);
  url.searchParams.set("num", String(params.num || 10));

  const response = await fetch(url.toString(), {
    next: { revalidate: 300 },
    signal: AbortSignal.timeout(6000),
  });

  if (!response.ok) {
    throw new Error(`SerpApi request failed: ${response.status}`);
  }

  const data = (await response.json()) as SerpApiSearchResponse;
  if (data.error) {
    throw new Error(`SerpApi error: ${data.error}`);
  }

  return Array.isArray(data.organic_results) ? data.organic_results : [];
}
