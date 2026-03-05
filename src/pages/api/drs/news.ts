import type { APIRoute } from "astro";

export const prerender = false;

const BASE_URL = "https://newsdata.io/api/1/news";
function isConfigured(value: string | undefined): boolean {
  const v = String(value || "").trim();
  if (!v) return false;
  if (v.toLowerCase().startsWith("your_")) return false;
  return true;
}

export const GET: APIRoute = async ({ url }) => {
  const apiKey = import.meta.env.NEWSDATA_API_KEY;
  if (!isConfigured(apiKey)) {
    return new Response(
      JSON.stringify({ ok: false, error: "NEWSDATA_API_KEY is not configured" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }
  const safeApiKey = String(apiKey);

  const params = new URLSearchParams({
    apikey: safeApiKey,
    language: "en",
    category: "business",
    size: "10",
    image: "1",
    q: "(supply chain OR logistics OR semiconductor OR tariffs OR manufacturing disruption)",
  });
  const page = url.searchParams.get("page");
  if (page) {
    params.set("page", page);
  }

  try {
    const response = await fetch(`${BASE_URL}?${params.toString()}`, {
      headers: { Accept: "application/json" },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.status !== "success") {
      const errorMessage =
        payload?.results?.message || payload?.message || `newsdata http ${response.status}`;
      return new Response(
        JSON.stringify({ ok: false, error: errorMessage }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        results: Array.isArray(payload?.results) ? payload.results : [],
        nextPage: typeof payload?.nextPage === "string" ? payload.nextPage : "",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : "news fetch failed",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
