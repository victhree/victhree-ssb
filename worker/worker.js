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

// Gemini models to try, in order. The Worker uses the first one that
// succeeds for your account's free tier. Reorder / trim as you like.
const MODELS = [
  "gemini-2.5-flash",
  "gemini-flash-latest",
  "gemini-3-flash-preview",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite"
];

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

    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.6,
        responseMimeType: "application/json"
      }
    };

    // Try each model in turn; use the first that your free tier serves.
    let text = null, usedModel = null, lastErr = "";
    for (const model of MODELS) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
      let gemRes;
      try {
        gemRes = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
      } catch (e) {
        lastErr = "fetch failed for " + model;
        continue;
      }
      if (!gemRes.ok) {
        const t = await gemRes.text();
        lastErr = model + " → " + gemRes.status + ": " + t.slice(0, 400);
        continue;
      }
      const data = await gemRes.json();
      const t =
        data &&
        data.candidates &&
        data.candidates[0] &&
        data.candidates[0].content &&
        data.candidates[0].content.parts &&
        data.candidates[0].content.parts[0] &&
        data.candidates[0].content.parts[0].text;
      if (t) { text = t; usedModel = model; break; }
      lastErr = "empty response from " + model;
    }

    if (!text) {
      return json({ error: "All models failed", detail: lastErr }, 502, cors);
    }

    // The model was asked for JSON; parse it, else pass raw text as summary.
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      parsed = { summary: text };
    }
    if (parsed && typeof parsed === "object") parsed._model = usedModel;
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
    `The 15 OLQs include: effective intelligence, reasoning ability, organising ability, power of expression, social adaptability, cooperation, sense of responsibility, initiative, self-confidence, speed of decision, ability to influence the group, liveliness, determination, courage, and stamina.`,
    ``,
    `Return ONLY valid JSON with this exact shape:`,
    `{`,
    `  "summary": "a 3-5 sentence personality analysis of the candidate in the voice of an SSB psychologist, describing overall temperament, emotional stability and officer potential based on these responses",`,
    `  "olqs_reflected": ["<OLQ name> — brief evidence seen in the responses"],`,
    `  "olqs_to_work_on": ["<OLQ name> — brief, actionable note"],`,
    `  "items": [ { "n": <number>, "prompt": "<the word/situation>", "comment": "one-sentence assessment of this response", "suggestion": "one better alternative response" } ]`,
    `}`,
    `List 3-6 OLQs reflected and 2-4 OLQs to work on, naming actual OLQs from the list. Include an items entry for every response. Be honest, concise and constructive.`,
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
