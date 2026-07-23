/* VicThree SSB — Gemini analysis Worker (Cloudflare)
   ------------------------------------------------------------------
   This runs on Cloudflare Workers (free tier). It holds your Gemini
   API key as a SECRET so it is never exposed in the public website.

   The website POSTs the student's responses here; this Worker calls
   Gemini and returns a structured analysis that the site displays.

   SETUP (all in the browser — no Node needed): see README.md →
   "Enabling Gemini analysis". In short:
     1. Get a free Gemini API key from Google AI Studio.
     2. Create a Worker at dash.cloudflare.com, paste this code.
     3. Add a Variable/Secret named GEMINI_API_KEY = your key.
     4. Copy the Worker URL into assets/config.js (aiEndpoint).
   ------------------------------------------------------------------ */

// Only these origins may call the Worker (browser requests). Add your
// custom domain here too if you set one up later.
const ALLOWED_ORIGINS = [
  "https://victhree.github.io",
  "http://localhost:8099"   // local testing; remove if you like
];

// Gemini model. "gemini-2.0-flash" is fast and cheap; you can switch to
// another current Flash model from Google AI Studio if you prefer.
const MODEL = "gemini-2.0-flash";

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "POST") {
      return json({ error: "Use POST" }, 405, cors);
    }
    // Basic origin guard (note: browsers enforce this; non-browser clients
    // can spoof Origin, so ALSO set a usage cap on your Google API key).
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: "Origin not allowed" }, 403, cors);
    }

    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return json({ error: "Invalid JSON" }, 400, cors);
    }
    const mode = payload && payload.mode === "SRT" ? "SRT" : "WAT";
    const items = Array.isArray(payload && payload.items) ? payload.items.slice(0, 80) : [];
    if (!items.length) return json({ error: "No items" }, 400, cors);

    if (!env.GEMINI_API_KEY) {
      return json({ error: "Server not configured (missing GEMINI_API_KEY)" }, 500, cors);
    }

    const prompt = buildPrompt(mode, items);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.6,
        responseMimeType: "application/json"
      }
    };

    let gemRes;
    try {
      gemRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (e) {
      return json({ error: "Upstream fetch failed" }, 502, cors);
    }

    if (!gemRes.ok) {
      const t = await gemRes.text();
      return json({ error: "Gemini error " + gemRes.status, detail: t.slice(0, 300) }, 502, cors);
    }

    const data = await gemRes.json();
    const text =
      data &&
      data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text;

    if (!text) return json({ error: "Empty response from Gemini" }, 502, cors);

    // The model was asked for JSON; parse it, else pass raw text as summary.
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      parsed = { summary: text };
    }
    return json(parsed, 200, cors);
  }
};

function buildPrompt(mode, items) {
  const testName =
    mode === "SRT" ? "Situation Reaction Test (SRT)" : "Word Association Test (WAT)";
  const lines = items.map((it) => {
    const label = mode === "SRT" ? `Situation: ${it.prompt}` : `Word: ${it.prompt}`;
    const tag = it.tag ? ` [${it.tag}]` : "";
    return `#${it.n}${tag} — ${label}\n   Response (${it.seconds}s): ${it.response || "[left blank]"}`;
  });
  return [
    `You are an experienced, fair SSB (Services Selection Board) psychologist analysing a candidate's ${testName} responses for Officer-Like Qualities (OLQs).`,
    `Remember: there are NO official "correct" answers. Judge the mindset — positivity, realism, and whether the response protects the mission and group over the self. Do not reward manufactured heroics or artificial positivity.`,
    ``,
    `Return ONLY valid JSON with this exact shape:`,
    `{`,
    `  "summary": "2-4 sentence overall read of the candidate",`,
    `  "strengths": ["short bullet", "short bullet"],`,
    `  "improve": ["short, actionable bullet", "short, actionable bullet"],`,
    `  "items": [ { "n": <number>, "prompt": "<the word/situation>", "comment": "one-sentence assessment", "suggestion": "one sharper example response" } ]`,
    `}`,
    `Include an items entry for every response. Keep comments concise and constructive.`,
    ``,
    `=== Candidate's ${mode} responses ===`,
    ...lines
  ].join("\n");
}

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, cors || {})
  });
}
