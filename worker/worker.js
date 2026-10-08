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
  "https://ssb.victhreedefence.com",
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

    const mode = payload && (payload.mode === "SRT" || payload.mode === "SDT" || payload.mode === "TAT" || payload.mode === "PPDT" || payload.mode === "GPE") ? payload.mode : "WAT";
    const items = Array.isArray(payload && payload.items) ? payload.items.slice(0, 80) : [];
    if (!items.length) return json({ error: "No items" }, 400, cors);

    // Optional: the qualities this candidate is currently weakest on, so the
    // analysis can steer its suggestions toward them. Keys only, capped.
    const focus = Array.isArray(payload && payload.focus_olqs)
      ? payload.focus_olqs.filter((x) => typeof x === "string" && OLQ_KEYS.indexOf(x) !== -1).slice(0, 5)
      : [];

    if (!env.GEMINI_API_KEY) {
      return json({ error: "Server not configured (missing GEMINI_API_KEY)" }, 500, cors);
    }

    const body = {
      contents: buildContents(mode, items, focus),
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

// The 15 canonical OLQ keys the course portal aggregates on. The model must
// emit reflected_keys / work_keys using ONLY these exact strings.
const OLQ_KEYS = [
  "effective_intelligence", "reasoning_ability", "organising_ability",
  "power_of_expression", "social_adaptability", "cooperation",
  "sense_of_responsibility", "initiative", "self_confidence",
  "speed_of_decision", "ability_to_influence_the_group", "liveliness",
  "determination", "courage", "stamina"
];

// Shared trailing instruction: force the machine-readable keys, and (optionally)
// steer suggestions toward the qualities the candidate is currently weak on.
function keyGuidance(focus) {
  const lines = [
    ``,
    `ALSO return two machine-readable arrays named "reflected_keys" and "work_keys".`,
    `Use ONLY these exact snake_case keys, nothing else (no spaces, no capitals, no new strings):`,
    OLQ_KEYS.join(", ") + ".",
    `"reflected_keys" must correspond to the strengths you described in "olqs_reflected", and "work_keys" to the weak points in "olqs_to_work_on". Put one or more keys in each array; never invent a key outside the list.`
  ];
  if (Array.isArray(focus) && focus.length) {
    lines.push(``);
    lines.push(`This candidate is currently weak on: ${focus.join(", ")}. Where genuinely applicable, make your per-item "suggestion" show how the same response could have better demonstrated these specific qualities. Do not force it where it does not fit, and never invent facts about the candidate.`);
  }
  return lines.join("\n");
}

function buildPrompt(mode, items, focus) {
  if (mode === "SDT") return buildSdtPrompt(items, focus);
  if (mode === "TAT") return buildTatPrompt(items, focus);
  if (mode === "PPDT") return buildPpdtPrompt(items, focus);
  if (mode === "GPE") return buildGpePrompt(items, focus);
  const testName =
    mode === "SRT" ? "Situation Reaction Test (SRT)" : "Word Association Test (WAT)";
  const lines = items.map((it) => {
    const label = mode === "SRT" ? `Situation: ${it.prompt}` : `Word: ${it.prompt}`;
    const tag = it.tag ? ` [${it.tag}]` : "";
    return `#${it.n}${tag} — ${label}\n   Response (${it.seconds}s): ${it.response || "[left blank]"}`;
  });
  return [
`You are an experienced, fair SSB (Services Selection Board) psychologist analysing a candidate's ${testName} responses for Officer-Like Qualities (OLQs).
There are NO official "correct" answers. Judge the mindset behind each response: realism, constructiveness, action-orientation, and whether the response serves the mission and the group over the self. Do NOT reward manufactured heroics, artificial positivity, or bravado — these read as fake. Authenticity matters more than polish.

The 15 OLQs: effective intelligence, reasoning ability, organising ability, power of expression, social adaptability, cooperation, sense of responsibility, initiative, self-confidence, speed of decision, ability to influence the group, liveliness, determination, courage, stamina.
Weight these gatekeeper qualities most heavily: moral values, social adaptability, cooperation, sense of responsibility, liveliness, courage. A clear defect in these matters more than a gap in the developable qualities (intelligence, reasoning, organising, expression).

If this is the WORD ASSOCIATION TEST (WAT), judge the direction of thought in each sentence:
- Best: an OBSERVATIONAL sentence — a detached, insightful statement about the word (e.g. "Chair indicates a person's position in office"; "Sun is a source of light and energy").
- Acceptable: a FACTUAL or general-knowledge sentence — generic but valid, and better than a blank.
- Weak: a PERSONAL sentence that starts with I / we / they / he / she / a name (reads as self-referential).
- Weak: a PREACHY sentence using should / could / must / try (unsolicited advice).
- Flag specifically when seen: the word "try" (signals half-effort); negating a loaded word with "don't/no" ("accidents don't happen if..."); writing the dictionary meaning; bravado such as "an officer never feels fear" (reads as hiding something); more than a few blanks or a pattern of clipped non-sentences.
- For loaded or negative words (death, fear, knife, failure, murder): the aim is NOT to force a positive flip and NOT to negate — it is to place the word in a realistic, constructive or factual frame.

If this is the SITUATION REACTION TEST (SRT), first check each response for a MORAL or integrity problem (keeping or using found money or property, bribing, cheating, lying for personal gain, taking revenge personally, abandoning a duty for self-interest). Treat any such response as a serious concern that outweighs other strengths — integrity is judged first. Then judge:
- Does the response reach the stated objective rather than stop at a half-measure?
- Does it calibrate to the real threat (let pass / handle / confront as the situation demands) instead of a reflex reaction? Escaping when genuinely outnumbered is mature; foolhardy heroics are weak.
- Does it avoid inventing complications (no first aid or ambulance unless the prompt states an injury; do not make the situation more complex than it is)?
- Does it read constraints literally and use only realistic, context-available resources (no mobile, UPI, ATM or maps — the test checks social resourcefulness)?
- Is "inform the police or authority" used sensibly as a graduated step, not bolted onto an illogical first action and not used to avoid showing initiative in a situation the candidate could handle?
- Flag: "try"; unfinished or half-measure responses; superhero or illogical escalation; writing an idealised self; adverbs (calmly, bravely, immediately, swiftly) and stock phrases ("didn't panic", "raised morale"); wrong tense; taking the situation personally; "either/or".

If any response shows a serious integrity or disqualifying problem, list it in "red_flags" (quote the response and state why it is serious). If there are none, return an empty array. Do not inflate ordinary weaknesses into red flags — reserve this for genuinely serious concerns.

Return ONLY valid JSON with this exact shape:
{
  "summary": "a 3-5 sentence personality analysis of the candidate in the voice of an SSB psychologist, describing overall temperament, emotional stability and officer potential based on these responses; note any serious integrity concern if present",
  "olqs_reflected": ["<OLQ name> — brief evidence seen in the responses"],
  "olqs_to_work_on": ["<OLQ name> — brief, actionable note"],
  "reflected_keys": ["<one or more of the 15 canonical keys>"],
  "work_keys": ["<one or more of the 15 canonical keys>"],
  "red_flags": ["<serious integrity or disqualifying concern, quoting the response and why it is serious; for SRT especially (found-money use, bribery, cheating, revenge, abandoning duty). EMPTY ARRAY if none>"],
  "items": [ { "n": <number>, "prompt": "<the word/situation>", "comment": "one-sentence assessment naming the specific pattern (e.g. personal framing, reaches objective, uses 'try', superhero escalation)", "suggestion": "one better alternative response" } ]
}
List 3-6 OLQs reflected and 2-4 OLQs to work on, naming actual OLQs from the list. Weight gatekeeper qualities and any integrity concern most heavily. Include an items entry for every response. Be honest, concise and constructive.`,
    keyGuidance(focus),
    ``,
    `=== Candidate's ${mode} responses ===`,
    ...lines
  ].join("\n");
}

function buildSdtPrompt(items, focus) {
  const parts = items.map((it) => {
    return `#${it.n} — Prompt: ${it.prompt}\n   Answer: ${it.response || "[left blank]"}`;
  });
  return [
`You are an experienced, fair SSB (Services Selection Board) psychologist assessing a candidate's Self-Description Test (SDT), the written self-appraisal from the Day-2 psychology battery.
In the SDT the candidate describes themselves from up to five viewpoints: (1) their parents, (2) their teachers, superiors or employers, (3) their friends, (4) their own honest opinion, and (5) the kind of person they want to become / qualities they want to improve.

Judge it on:
- Self-awareness and honesty: real, specific evidence (one concrete example per quality) rather than stacked adjectives.
- Balance and placement of weaknesses: the first four viewpoints should carry no negatives; any genuine, moderate, owned weakness belongs ONLY in the fifth, forward-looking part, and must be paired with a concrete plan to improve it. A flawless self-portrait signals low self-awareness, not strength.
- Internal consistency: the four outside views and the candidate's own opinion should add up to one coherent person, and should be consistent with officer-like behaviour.
- A forward-looking, actionable fifth part that names concrete steps and ideally closes the loop with the weakness owned.
- Brevity and clear prose structure.
Watch for: manufactured positivity or only-strengths answers; claiming to be flawless; memorised or clichéd template language; self-contradiction between the parts; over-confession; negatives placed in parts one to four; a weakness with no improvement plan; and any disqualifying trait. Do not reward pretence, and do not punish an honest, moderate, improvable weakness placed correctly in part five.

The 15 Officer-Like Qualities (OLQs) are: effective intelligence, reasoning ability, organising ability, power of expression, social adaptability, cooperation, sense of responsibility, initiative, self-confidence, speed of decision, ability to influence the group, liveliness, determination, courage, and stamina.

Return ONLY valid JSON with this exact shape:
{
  "summary": "a 3-5 sentence personality analysis in the voice of an SSB psychologist: the candidate's self-awareness, emotional maturity, how consistent the five parts are with one another, and overall officer potential",
  "olqs_reflected": ["<OLQ name> — brief evidence seen in the self-description"],
  "olqs_to_work_on": ["<OLQ name> — brief, actionable note"],
  "reflected_keys": ["<one or more of the 15 canonical keys>"],
  "work_keys": ["<one or more of the 15 canonical keys>"],
  "red_flags": ["<any serious concern, e.g. a disqualifying trait disclosed, dishonesty, or self-contradiction that undermines credibility; EMPTY ARRAY if none>"],
  "items": [ { "n": <number>, "prompt": "<short label for the viewpoint, e.g. Parents' opinion>", "comment": "one-sentence assessment of this part: honesty, evidence, balance, correct placement of any weakness, and consistency", "suggestion": "one sharper, more authentic way to express this part, WITHOUT inventing new facts about the candidate's life" } ]
}
List 3-6 OLQs reflected and 2-4 to work on, naming actual OLQs from the list. Include an items entry for every prompt answered. Be honest, concise and constructive.`,
    keyGuidance(focus),
    ``,
    `=== Candidate's Self-Description responses ===`,
    ...parts
  ].join("\n");
}

function tatCriteria(focus) {
  return [
`You are an experienced, fair SSB (Services Selection Board) psychologist assessing a candidate's Thematic Apperception Test (TAT) stories from the Day-2 psychology battery.
For each item you are shown the same hazy picture the candidate saw (when a picture is provided) and the short story they wrote around a central "hero". The hero is a projection of the candidate; what matters is the traits, qualities and thoughts behind the story, not the plot itself.

IMPORTANT about the picture: TAT pictures are deliberately hazy and ambiguous, and there is NO correct interpretation. Use the picture ONLY to (a) check the story is plausibly connected to the scene rather than ignoring it, and (b) ground your comments. NEVER lower your assessment because the candidate read the picture differently than you would; a creative but plausible reading is fully valid. If no picture is provided, judge the story text alone.

Judge each story on:
- A clear central hero, roughly the candidate's own age, with a positive disposition (avoid heroes described as fearful, worried, depressed or anxious), who takes initiative and solves the problem through realistic effort and available resources — not luck, not rescue by others, not passivity.
- Teamwork: the hero takes others along, delegates and gives credit, rather than doing everything alone. A lone-wolf hero who single-handedly does everything is a weakness.
- Complete structure: a genuine build-up (past) leading into the present and a single logical, achieved outcome. A present-only story with an empty middle is a common, serious weakness. It is often stronger to set the hero's objective first and build the story towards it.
- Outcome: the hero should believably prevail through realistic effort and conviction. Do NOT reward forced cheerfulness, fantasy or superhuman success, and do NOT reward defeatist, tragic or self-pitying endings. A temporary setback followed by an earned recovery is ideal.
- OLQs shown through the hero's ACTION, not through adjectives. Avoid negative-emotion words and "try".
- Do not introduce negativity that is not in the picture (e.g. inventing a death or an addiction). For a technical picture (e.g. an aircraft or device), show accurate, justifiable terminology and a short, realistic, planned project, staying anchored to the main hint of the picture.

The 15 Officer-Like Qualities (OLQs) are: effective intelligence, reasoning ability, organising ability, power of expression, social adaptability, cooperation, sense of responsibility, initiative, self-confidence, speed of decision, ability to influence the group, liveliness, determination, courage, and stamina.

Return ONLY valid JSON with this exact shape:
{
  "summary": "a 3-5 sentence personality analysis in the voice of an SSB psychologist: recurring themes across the stories, the kind of hero the candidate projects, emotional tone, realism, teamwork and overall officer potential",
  "olqs_reflected": ["<OLQ name> — brief evidence seen in the stories"],
  "olqs_to_work_on": ["<OLQ name> — brief, actionable note"],
  "reflected_keys": ["<one or more of the 15 canonical keys>"],
  "work_keys": ["<one or more of the 15 canonical keys>"],
  "red_flags": ["<any serious concern across the stories, e.g. recurring violence/revenge, consistently defeatist or hopeless themes; EMPTY ARRAY if none>"],
  "items": [ { "n": <number>, "prompt": "<the slide label, e.g. Picture 1>", "comment": "one-sentence assessment of this story: hero, initiative, teamwork, past-to-outcome structure, tone and realism", "suggestion": "one concrete way to make this story stronger and more officer-like, grounded in the picture and what the candidate wrote" } ]
}
List 3-6 OLQs reflected and 2-4 to work on, naming actual OLQs from the list. Include an items entry for every story written. Be honest, concise and constructive.`,
    keyGuidance(focus)
  ].join("\n");
}
function buildTatPrompt(items, focus) {
  const lines = items.map((it) => `#${it.n} — ${it.prompt}\n   Story: ${it.response || "[left blank]"}`);
  return tatCriteria(focus) + "\n\n=== Candidate's TAT stories ===\n" + lines.join("\n");
}

function ppdtCriteria(focus) {
  return [
`You are an experienced, fair SSB (Services Selection Board) assessor evaluating a candidate's Picture Perception and Description Test (PPDT), the Day-1 screening test.
For each item you are shown the same hazy picture the candidate saw (when a picture is provided), followed by the candidate's typed "Perception" line (number of characters, and the main character's age, sex and mood) and their short hero "Story".

IMPORTANT about the picture: PPDT pictures are deliberately hazy and ambiguous, and there is NO single correct interpretation. Use the picture ONLY to (a) sanity-check that the perception and story are plausibly connected to the scene, and (b) ground your comments. NEVER lower your assessment merely because the candidate perceived the picture differently than you would; a plausible reading is fully valid. If no picture is provided, judge the text alone.

Judge each response on:
- Perception quality: a clear character count and the main character's age, sex and mood, leaning positive, coherent with the story that follows.
- One clear, positive, proactive hero who corresponds to the main perceived character — not a group, not a passive victim, not a bystander. The hero should take initiative using believable resources, ideally taking others along rather than acting entirely alone.
- A complete cause to action to positive, realistic outcome structure, ideally around 80-100 words. The hero should believably prevail through realistic effort; avoid forced heroics and avoid tragic or defeatist endings.
- OLQs shown through the hero's ACTION, not adjectives. Avoid negative-emotion words and "try".
Watch for: a perception-story mismatch (characters or hero not matching the noted count or details); no single hero or a group story; a passive or rescued hero; unrealistic or superhuman heroics; merely describing the scene; an incomplete story; introduced negativity not in the picture. Do not punish an honest, ordinary story that is positive and realistic.

The 15 Officer-Like Qualities (OLQs) are: effective intelligence, reasoning ability, organising ability, power of expression, social adaptability, cooperation, sense of responsibility, initiative, self-confidence, speed of decision, ability to influence the group, liveliness, determination, courage, and stamina.

Return ONLY valid JSON with this exact shape:
{
  "summary": "a 3-5 sentence assessment in the voice of an SSB screening assessor: the candidate's perception positivity, the kind of hero they project, story structure and realism, and whether this reads as screen-in material",
  "olqs_reflected": ["<OLQ name> — brief evidence seen in the responses"],
  "olqs_to_work_on": ["<OLQ name> — brief, actionable note"],
  "reflected_keys": ["<one or more of the 15 canonical keys>"],
  "work_keys": ["<one or more of the 15 canonical keys>"],
  "red_flags": ["<any serious concern, e.g. violent/negative themes or a strong perception-story mismatch; EMPTY ARRAY if none>"],
  "items": [ { "n": <number>, "prompt": "<the slide label, e.g. Picture 1>", "comment": "one-sentence assessment: perception coherence, hero, structure, tone and realism", "suggestion": "one concrete way to make this response stronger and more officer-like, grounded in the picture and what the candidate wrote" } ]
}
List 3-6 OLQs reflected and 2-4 to work on, naming actual OLQs from the list. Include an items entry for every response. Be honest, concise and constructive.`,
    keyGuidance(focus)
  ].join("\n");
}
function buildPpdtPrompt(items, focus) {
  const lines = items.map((it) => `#${it.n} — ${it.prompt}\n   ${it.response || "[left blank]"}`);
  return ppdtCriteria(focus) + "\n\n=== Candidate's PPDT responses ===\n" + lines.join("\n");
}

function buildGpePrompt(items, focus) {
  const parts = items.map((it) => {
    const label = it.title ? it.title : ("Scenario " + it.n);
    return `#${it.n} — ${label}\n   Scenario: ${it.prompt}\n   Candidate's plan: ${it.response || "[left blank]"}`;
  });
  return [
    `You are an experienced, fair SSB (Services Selection Board) Group Testing Officer (GTO) assessing a candidate's individual written plan for a Group Planning Exercise (GPE, also called the Military Planning Exercise).`,
    `In the GPE the candidate is given a scenario with several simultaneous problems and limited resources, and about ten minutes to write their own plan before the group discussion. For each item you are given the full scenario and the candidate's plan.`,
    `IMPORTANT: there is no single correct plan. Judge the plan on sound judgement, not on matching one ideal answer. A different but well-justified priority order is fully acceptable.`,
    ``,
    `Judge each plan on:`,
    `- Completeness: did the plan address EVERY problem in the scenario? Missing a problem is a major fault.`,
    `- Prioritisation: is the order sensible (human life in immediate danger first, then a threat to many lives or security, then a single life with some time, then property, then the trivial), and is it justified?`,
    `- Delegation: is the group split into named parties acting in parallel, rather than one hero doing everything?`,
    `- Realism and time: are actions time-bound and physically possible using the stated distances, speeds and deadlines, using ONLY the resources given (no invented phone, vehicle, helicopter or help)?`,
    `- Use of authorities: are the police, hospital, telephone or other given help used where appropriate?`,
    `- Structure and clarity: problems listed, prioritised, party-wise time-bound tasks, and a regroup point.`,
    `Watch for red flags: missing a problem, property before life, no delegation (a solo hero), ignoring time and distance, inventing resources, unrealistic or filmi solutions, illogical group-splitting, contradicting the scenario's facts.`,
    ``,
    `The relevant Officer-Like Qualities (OLQs) include: effective intelligence, reasoning ability, organising ability, power of expression, initiative, self-confidence, speed of decision, determination, and cooperation.`,
    ``,
    `Return ONLY valid JSON with this exact shape:`,
    `{`,
    `  "summary": "a 3-5 sentence assessment in the voice of a GTO: how well the candidate grasped the situation, prioritised human life, delegated and used resources, kept the plan time-bound and realistic, and their overall planning ability",`,
    `  "olqs_reflected": ["<OLQ name> — brief evidence seen in the plan"],`,
    `  "olqs_to_work_on": ["<OLQ name> — brief, actionable note"],`,
    `  "reflected_keys": ["<one or more of the 15 canonical keys>"],`,
    `  "work_keys": ["<one or more of the 15 canonical keys>"],`,
    `  "red_flags": ["<any serious concern, e.g. prioritising property over human life, or a plan that endangers people; EMPTY ARRAY if none>"],`,
    `  "items": [ { "n": <number>, "prompt": "<the scenario title>", "comment": "one-sentence assessment: completeness, prioritisation, delegation, realism and structure", "suggestion": "one concrete way to make this plan stronger and more officer-like, grounded in the scenario" } ]`,
    `}`,
    `List 3-6 OLQs reflected and 2-4 to work on, naming actual OLQs. Include an items entry for every scenario. Be honest, concise and constructive.`,
    keyGuidance(focus),
    ``,
    `=== Candidate's GPE plans ===`,
    ...parts
  ].join("\n");
}

// Build the Gemini "contents". For TAT/PPDT with pictures attached, interleave each
// picture with its story so the model can see what the candidate was looking at.
function buildContents(mode, items, focus) {
  const hasImg = Array.isArray(items) && items.some((it) => it && it.image);
  if ((mode === "TAT" || mode === "PPDT") && hasImg) {
    const parts = [{ text: mode === "PPDT" ? ppdtCriteria(focus) : tatCriteria(focus) }];
    parts.push({ text: mode === "PPDT" ? "\n=== Candidate's PPDT responses ===" : "\n=== Candidate's TAT stories ===" });
    for (const it of items) {
      parts.push({ text: `\n#${it.n} — ${it.prompt}` });
      if (it.image) parts.push({ inline_data: { mime_type: it.mimeType || "image/jpeg", data: it.image } });
      else parts.push({ text: "(no picture available for this item)" });
      parts.push({ text: mode === "PPDT" ? (it.response || "[left blank]") : ("Story: " + (it.response || "[left blank]")) });
    }
    return [{ role: "user", parts }];
  }
  return [{ role: "user", parts: [{ text: buildPrompt(mode, items, focus) }] }];
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
