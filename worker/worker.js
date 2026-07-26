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
    const mode = payload && (payload.mode === "SRT" || payload.mode === "SDT" || payload.mode === "TAT" || payload.mode === "PPDT") ? payload.mode : "WAT";
    const items = Array.isArray(payload && payload.items) ? payload.items.slice(0, 80) : [];
    if (!items.length) return json({ error: "No items" }, 400, cors);

    if (!env.GEMINI_API_KEY) {
      return json({ error: "Server not configured (missing GEMINI_API_KEY)" }, 500, cors);
    }

    const body = {
      contents: buildContents(mode, items),
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
  if (mode === "SDT") return buildSdtPrompt(items);
  if (mode === "TAT") return buildTatPrompt(items);
  if (mode === "PPDT") return buildPpdtPrompt(items);
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

function buildSdtPrompt(items) {
  const parts = items.map((it) => {
    return `#${it.n} — Prompt: ${it.prompt}\n   Answer: ${it.response || "[left blank]"}`;
  });
  return [
    `You are an experienced, fair SSB (Services Selection Board) psychologist assessing a candidate's Self-Description Test (SDT), the written self-appraisal from the Day-2 psychology battery.`,
    `In the SDT the candidate describes themselves from up to five viewpoints: (1) their parents, (2) their teachers, superiors or employers, (3) their friends, (4) their own honest opinion, and (5) the kind of person they want to become.`,
    ``,
    `The SDT is a cross-check on the rest of the candidate's personality. Judge it on:`,
    `- Self-awareness and honesty: real, specific evidence rather than stacked adjectives.`,
    `- Balance: genuine strengths paired with at least one moderate, owned, fixable weakness. A flawless self-portrait signals low self-awareness, not strength.`,
    `- Internal consistency: the four outside views and the candidate's own opinion should add up to one coherent person.`,
    `- A forward-looking, actionable fifth part that names concrete steps and, ideally, closes the loop with the weakness the candidate owned.`,
    `- Brevity and clear structure.`,
    `Watch for red flags: manufactured positivity or only-strengths answers, memorised or clichéd template language, self-contradiction between the parts, over-confession, and any disqualifying trait (aggression or short temper, dishonesty, substance use, a habit of quitting). Do not reward pretence, and do not punish an honest, moderate weakness.`,
    ``,
    `The 15 Officer-Like Qualities (OLQs) are: effective intelligence, reasoning ability, organising ability, power of expression, social adaptability, cooperation, sense of responsibility, initiative, self-confidence, speed of decision, ability to influence the group, liveliness, determination, courage, and stamina.`,
    ``,
    `Return ONLY valid JSON with this exact shape:`,
    `{`,
    `  "summary": "a 3-5 sentence personality analysis in the voice of an SSB psychologist: the candidate's self-awareness, emotional maturity, how consistent the five parts are with one another, and overall officer potential",`,
    `  "olqs_reflected": ["<OLQ name> — brief evidence seen in the self-description"],`,
    `  "olqs_to_work_on": ["<OLQ name> — brief, actionable note"],`,
    `  "items": [ { "n": <number>, "prompt": "<short label for the viewpoint, e.g. Parents' opinion>", "comment": "one-sentence assessment of this part: honesty, evidence, balance and consistency", "suggestion": "one sharper, more authentic way to express this part, WITHOUT inventing new facts about the candidate's life" } ]`,
    `}`,
    `List 3-6 OLQs reflected and 2-4 to work on, naming actual OLQs from the list. Include an items entry for every prompt answered. Be honest, concise and constructive.`,
    ``,
    `=== Candidate's Self-Description responses ===`,
    ...parts
  ].join("\n");
}

function tatCriteria() {
  return [
    `You are an experienced, fair SSB (Services Selection Board) psychologist assessing a candidate's Thematic Apperception Test (TAT) stories from the Day-2 psychology battery.`,
    `For each item you are shown the same hazy picture the candidate saw (when a picture is provided) and the short story they wrote around a central "hero". The hero is a projection of the candidate.`,
    ``,
    `IMPORTANT about the picture: TAT pictures are deliberately hazy, blurred and ambiguous, and there is NO correct interpretation. Use the picture ONLY to (a) check the story is plausibly connected to the scene rather than ignoring it entirely, and (b) make your comments and suggestions more grounded and specific. NEVER lower your assessment because the candidate read the picture differently than you would; a creative but plausible reading is fully valid. If no picture is provided for an item, judge the story text alone.`,
    ``,
    `Judge each story on:`,
    `- A clear central hero who takes initiative and actively solves the problem using realistic, available resources (not luck, not rescue by others, not passivity).`,
    `- A positive, believable, action-oriented theme and outcome. Reward realism; do not reward superhuman heroics or manufactured positivity.`,
    `- Complete structure: what led to the situation (past), what is happening now (present), what the hero thinks and feels, and a constructive outcome (result).`,
    `- Officer-Like Qualities shown through the hero's ACTION, not through adjectives.`,
    `Watch for red flags: negative, tragic or hopeless endings; a helpless-victim or passive hero; violence, revenge or aggression; unrealistic heroics; no identifiable hero; purely describing the scene with no story; incomplete stories. Do not punish an honest, ordinary story that is positive and realistic.`,
    ``,
    `The 15 Officer-Like Qualities (OLQs) are: effective intelligence, reasoning ability, organising ability, power of expression, social adaptability, cooperation, sense of responsibility, initiative, self-confidence, speed of decision, ability to influence the group, liveliness, determination, courage, and stamina.`,
    ``,
    `Return ONLY valid JSON with this exact shape:`,
    `{`,
    `  "summary": "a 3-5 sentence personality analysis in the voice of an SSB psychologist: the recurring themes across the stories, the kind of hero the candidate projects, emotional tone, realism, and overall officer potential",`,
    `  "olqs_reflected": ["<OLQ name> — brief evidence seen in the stories"],`,
    `  "olqs_to_work_on": ["<OLQ name> — brief, actionable note"],`,
    `  "items": [ { "n": <number>, "prompt": "<the slide label, e.g. Picture 1>", "comment": "one-sentence assessment of this story: hero, initiative, structure, tone and realism", "suggestion": "one concrete way to make this story stronger and more officer-like, grounded in the picture and what the candidate wrote" } ]`,
    `}`,
    `List 3-6 OLQs reflected and 2-4 to work on, naming actual OLQs from the list. Include an items entry for every story written. Be honest, concise and constructive.`
  ].join("\n");
}
function buildTatPrompt(items) {
  const lines = items.map((it) => `#${it.n} — ${it.prompt}\n   Story: ${it.response || "[left blank]"}`);
  return tatCriteria() + "\n\n=== Candidate's TAT stories ===\n" + lines.join("\n");
}

function ppdtCriteria() {
  return [
    `You are an experienced, fair SSB (Services Selection Board) assessor evaluating a candidate's Picture Perception and Description Test (PPDT), the Day-1 screening test.`,
    `For each item you are shown the same hazy picture the candidate saw (when a picture is provided), followed by the candidate's typed "Perception" line (number of characters, and the main character's age, sex and mood) and their short hero "Story".`,
    ``,
    `IMPORTANT about the picture: PPDT pictures are deliberately hazy, blurred and ambiguous, and there is NO single correct interpretation. Use the picture ONLY to (a) sanity-check that the perception and story are plausibly connected to the scene, and (b) make your comments and suggestions more grounded. NEVER lower your assessment merely because the candidate perceived the picture differently than you would; a plausible reading is fully valid. If no picture is provided, judge the text alone.`,
    ``,
    `Judge each response on:`,
    `- Perception quality: a clear character count and the main character's age/sex/mood, leaning positive, coherent with the story that follows.`,
    `- One clear, positive, proactive hero who corresponds to the main perceived character (not a group, not a passive victim, not a bystander).`,
    `- A complete cause -> action -> positive, realistic outcome structure, ideally around 80-100 words, with the hero taking initiative and using believable resources.`,
    `- Officer-Like Qualities shown through the hero's ACTION, not adjectives.`,
    `Watch for red flags: negative, violent or tragic themes; a perception-story mismatch (characters or hero that do not match the noted count/details); no single hero or a group story; a passive or rescued hero; unrealistic or superhuman heroics; merely describing the scene; an incomplete story. Do not punish an honest, ordinary story that is positive and realistic.`,
    ``,
    `The 15 Officer-Like Qualities (OLQs) are: effective intelligence, reasoning ability, organising ability, power of expression, social adaptability, cooperation, sense of responsibility, initiative, self-confidence, speed of decision, ability to influence the group, liveliness, determination, courage, and stamina.`,
    ``,
    `Return ONLY valid JSON with this exact shape:`,
    `{`,
    `  "summary": "a 3-5 sentence assessment in the voice of an SSB screening assessor: the candidate's perception positivity, the kind of hero they project, story structure and realism, and whether this reads as screen-in material",`,
    `  "olqs_reflected": ["<OLQ name> — brief evidence seen in the responses"],`,
    `  "olqs_to_work_on": ["<OLQ name> — brief, actionable note"],`,
    `  "items": [ { "n": <number>, "prompt": "<the slide label, e.g. Picture 1>", "comment": "one-sentence assessment: perception coherence, hero, structure, tone and realism", "suggestion": "one concrete way to make this response stronger and more officer-like, grounded in the picture and what the candidate wrote" } ]`,
    `}`,
    `List 3-6 OLQs reflected and 2-4 to work on, naming actual OLQs from the list. Include an items entry for every response. Be honest, concise and constructive.`
  ].join("\n");
}
function buildPpdtPrompt(items) {
  const lines = items.map((it) => `#${it.n} — ${it.prompt}\n   ${it.response || "[left blank]"}`);
  return ppdtCriteria() + "\n\n=== Candidate's PPDT responses ===\n" + lines.join("\n");
}

// Build the Gemini "contents". For TAT/PPDT with pictures attached, interleave each
// picture with its story so the model can see what the candidate was looking at.
function buildContents(mode, items) {
  const hasImg = Array.isArray(items) && items.some((it) => it && it.image);
  if ((mode === "TAT" || mode === "PPDT") && hasImg) {
    const parts = [{ text: mode === "PPDT" ? ppdtCriteria() : tatCriteria() }];
    parts.push({ text: mode === "PPDT" ? "\n=== Candidate's PPDT responses ===" : "\n=== Candidate's TAT stories ===" });
    for (const it of items) {
      parts.push({ text: `\n#${it.n} — ${it.prompt}` });
      if (it.image) parts.push({ inline_data: { mime_type: it.mimeType || "image/jpeg", data: it.image } });
      else parts.push({ text: "(no picture available for this item)" });
      parts.push({ text: mode === "PPDT" ? (it.response || "[left blank]") : ("Story: " + (it.response || "[left blank]")) });
    }
    return [{ role: "user", parts }];
  }
  return [{ role: "user", parts: [{ text: buildPrompt(mode, items) }] }];
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
