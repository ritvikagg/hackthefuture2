import type { APIRoute } from "astro";

export const prerender = false;

function isConfigured(value: string | undefined): boolean {
  const v = String(value || "").trim();
  if (!v) return false;
  if (v.toLowerCase().startsWith("your_")) return false;
  return true;
}

export const GET: APIRoute = async () => {
  const hasNewsKey = isConfigured(import.meta.env.NEWSDATA_API_KEY);
  const hasGeminiKey = isConfigured(import.meta.env.GEMINI_API_KEY);
  const geminiModel = import.meta.env.GEMINI_MODEL || "gemini-3.1-pro-preview";

  return new Response(
    JSON.stringify({
      ok: true,
      hasNewsKey,
      hasGeminiKey,
      geminiModel,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
};
