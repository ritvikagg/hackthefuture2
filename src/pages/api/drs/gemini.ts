import type { APIRoute } from "astro";

export const prerender = false;

function isConfigured(value: string | undefined): boolean {
  const v = String(value || "").trim();
  if (!v) return false;
  if (v.toLowerCase().startsWith("your_")) return false;
  return true;
}

export const POST: APIRoute = async ({ request }) => {
  const apiKey = import.meta.env.GEMINI_API_KEY;
  const model = import.meta.env.GEMINI_MODEL || "gemini-3.1-pro-preview";

  if (!isConfigured(apiKey)) {
    return new Response(
      JSON.stringify({ ok: false, error: "GEMINI_API_KEY is not configured" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  const body = await request.json().catch(() => ({}));
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return new Response(
      JSON.stringify({ ok: false, error: "prompt is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const geminiBody = {
    contents: [
      {
        parts: [
          {
            text: `You are Resolv DRS. Reply with one concise mitigation statement for this prompt: ${prompt}`,
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 140,
    },
  };

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geminiBody),
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errorMessage =
        payload?.error?.message || payload?.message || `gemini http ${response.status}`;
      return new Response(
        JSON.stringify({ ok: false, error: errorMessage }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      );
    }

    const reply = (payload?.candidates?.[0]?.content?.parts || [])
      .map((part: { text?: string }) => part.text || "")
      .join(" ")
      .trim();

    return new Response(
      JSON.stringify({
        ok: true,
        provider: "gemini",
        model,
        reply: reply || "No model response returned.",
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
        error: error instanceof Error ? error.message : "gemini request failed",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
