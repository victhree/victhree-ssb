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

// Gemini models to try, in order. The first one your key actually serves goes
// first so normal requests succeed on the first try; the rest are fallbacks.
// (Dead/aliased names removed; they only wasted time failing.)
const MODELS = [
  "gemini-3-flash-preview",
  "gemini-3.8-flash"
];
// Abort a single model call if it stalls, so one slow model can't hang the whole
// request into a dropped connection. We make two passes with a short backoff so
// a transient 429/503 (free-tier throttling or model overload) can self-heal.
const MODEL_TIMEOUT_MS = 30000;
const PASSES = 2;
const PASS_BACKOFF_MS = 1500;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ error: "Use POST" }, 405, cors);

    const engineKey = request.headers.get("X-Engine-Key") || "";
    const hasSecret = !!env.ENGINE_SHARED_SECRET && engineKey === env.ENGINE_SHARED_SECRET;

    // Weekly synthesis: portal-only, server-to-server. Requires the shared secret.
    if (url.pathname === "/analyze/weekly") {
      if (!hasSecret) return json({ error: "Unauthorized" }, 401, cors);
      return handleWeekly(request, env, cors);
    }

    // Session analysis: "/analyze/session" or root. Allowed for a browser from an
    // allowed origin, or a server call carrying the shared secret.
    if (!hasSecret && origin && !ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: "Origin not allowed" }, 403, cors);
    }
    return handleSession(request, env, cors);
  }
};

async function handleSession(request, env, cors) {
  let payload;
  try { payload = await request.json(); } catch (e) { return json({ error: "Invalid JSON" }, 400, cors); }

  const mode = payload && (payload.mode === "SRT" || payload.mode === "SDT" || payload.mode === "TAT" || payload.mode === "PPDT" || payload.mode === "GPE") ? payload.mode : "WAT";
  const items = Array.isArray(payload && payload.items) ? payload.items.slice(0, 80) : [];
  if (!items.length) return json({ error: "No items" }, 400, cors);

  // Optional: the qualities this candidate is currently weakest on, so the
  // analysis can steer its suggestions toward them. Keys only, capped.
  const focus = Array.isArray(payload && payload.focus_olqs)
    ? payload.focus_olqs.filter((x) => typeof x === "string" && OLQ_KEYS.indexOf(x) !== -1).slice(0, 5)
    : [];

  if (!env.GEMINI_API_KEY) return json({ error: "Server not configured (missing GEMINI_API_KEY)" }, 500, cors);

  const result = await runGemini(env, buildContents(mode, items, focus));
  if (result.error) return json({ error: "All models failed", detail: result.error }, 502, cors);

  let parsed;
  try { parsed = JSON.parse(result.text); } catch (e) { parsed = { summary: result.text }; }
  if (parsed && typeof parsed === "object") {
    parsed._model = result.model;
    enrich(mode, items, parsed);   // adds per_item[] + metrics{} (WAT/SRT/TAT); keeps items[] clean
  }
  return json(parsed, 200, cors);
}

async function handleWeekly(request, env, cors) {
  let payload;
  try { payload = await request.json(); } catch (e) { return json({ error: "Invalid JSON" }, 400, cors); }
  if (!env.GEMINI_API_KEY) return json({ error: "Server not configured (missing GEMINI_API_KEY)" }, 500, cors);

  const contents = [{ role: "user", parts: [{ text: buildWeeklyPrompt(payload) }] }];
  const result = await runGemini(env, contents);
  if (result.error) return json({ error: "All models failed", detail: result.error }, 502, cors);

  let parsed;
  try { parsed = JSON.parse(result.text); }
  catch (e) { parsed = { studentReport: { headline: "", focus: [] }, adminReport: { overview: result.text } }; }
  if (parsed && typeof parsed === "object") parsed._model = result.model;
  return json(parsed, 200, cors);
}

// Shared model-fallback caller: two passes, per-model timeout, first success wins.
// Returns { text, model } on success or { error } when every model fails.
async function runGemini(env, contents) {
  const body = { contents, generationConfig: { temperature: 0.6, responseMimeType: "application/json" } };
  let lastErr = "";
  for (let pass = 0; pass < PASSES; pass++) {
    if (pass > 0) await new Promise((r) => setTimeout(r, PASS_BACKOFF_MS));
    for (const model of MODELS) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
      let gemRes;
      try {
        gemRes = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(MODEL_TIMEOUT_MS)
        });
      } catch (e) { lastErr = "fetch failed/timed out for " + model; continue; }
      if (!gemRes.ok) {
        const t = await gemRes.text();
        lastErr = model + " → " + gemRes.status + ": " + t.slice(0, 400);
        continue;
      }
      const data = await gemRes.json();
      const t =
        data && data.candidates && data.candidates[0] && data.candidates[0].content &&
        data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
        data.candidates[0].content.parts[0].text;
      if (t) return { text: t, model: model };
      lastErr = "empty response from " + model;
    }
  }
  return { error: lastErr };
}

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
  "items": [ { "n": <number>, "prompt": "<the word/situation>", "comment": "one-sentence assessment naming the specific pattern (e.g. personal framing, reaches objective, uses 'try', superhero escalation)", "suggestion": "one better alternative response", "bucket": "<WAT items only: observational|factual|personal|preachy>", "negation": <WAT items only: true or false>, "bravado": <WAT items only: true or false>, "dictionary_meaning": <WAT items only: true or false>, "reached_objective": <SRT items only: true or false>, "superhero_escalation": <SRT items only: true or false>, "moral_red_flag": <SRT items only: true or false> } ]
}
List 3-6 OLQs reflected and 2-4 OLQs to work on, naming actual OLQs from the list. Weight gatekeeper qualities and any integrity concern most heavily. Include an items entry for every response. Be honest, concise and constructive.
For each item, also set the classification booleans for THIS test type: a WORD ASSOCIATION TEST item gets bucket, negation, bravado and dictionary_meaning; a SITUATION REACTION TEST item gets reached_objective, superhero_escalation and moral_red_flag. Omit the fields that do not apply to this test type.`,
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
The candidate describes themselves from up to five viewpoints: (1) parents, (2) teachers/superiors/employers, (3) friends, (4) their own honest opinion, and (5) the kind of person they want to become / qualities to improve.

Judge on:
- Self-awareness and honesty: real, specific evidence (one concrete example per quality) rather than stacked adjectives.
- Placement of weaknesses: the first four viewpoints carry no negatives; any genuine, moderate, owned weakness belongs ONLY in the fifth, forward-looking part, paired with a concrete improvement plan. A flawless self-portrait signals low self-awareness, not strength.
- Internal consistency: the four outside views and the candidate's own opinion add up to one coherent person, consistent with officer-like behaviour.
- A forward-looking, actionable fifth part that names concrete steps and ideally closes the loop with the weakness owned.
- Brevity and clear prose.
Watch for: manufactured positivity / only-strengths; claiming to be flawless; memorised or clichéd template language; self-contradiction between parts; over-confession; negatives in parts one to four; a weakness with no plan; any disqualifying trait. Do not reward pretence; do not punish an honest, moderate, correctly-placed weakness.

The 15 Officer-Like Qualities (OLQs) are: effective intelligence, reasoning ability, organising ability, power of expression, social adaptability, cooperation, sense of responsibility, initiative, self-confidence, speed of decision, ability to influence the group, liveliness, determination, courage, stamina.

Return ONLY valid JSON with this exact shape:
{
  "summary": "a 3-5 sentence personality analysis in the voice of an SSB psychologist: self-awareness, emotional maturity, consistency across the five parts, and overall officer potential",
  "olqs_reflected": ["<OLQ name> — brief evidence"],
  "olqs_to_work_on": ["<OLQ name> — brief, actionable note"],
  "reflected_keys": ["<one or more of the 15 canonical keys>"],
  "work_keys": ["<one or more of the 15 canonical keys>"],
  "red_flags": ["<serious concern, e.g. a disqualifying trait disclosed, dishonesty, or self-contradiction undermining credibility; EMPTY ARRAY if none>"],
  "per_item": [ { "n": <int>, "response": "<the viewpoint answer>", "evidence_based": <bool>, "weakness_placement_ok": <bool>, "consistent": <bool> } ],
  "metrics": { "mode": "SDT", "items_count": <int>, "attempted_count": <int>, "evidence_based_rate": <float|null>, "weakness_placement_ok_rate": <float|null>, "consistent_rate": <float|null>, "reflected_keys": [...], "work_keys": [...], "red_flags": [...] },
  "items": [ { "n": <int>, "prompt": "<viewpoint label, e.g. Parents' opinion>", "comment": "one-sentence assessment: honesty, evidence, balance, placement of weakness, consistency", "suggestion": "one sharper, more authentic way to express this part, WITHOUT inventing new facts about the candidate's life" } ]
}
Rate definitions: each *_rate = that flag's TRUE count / attempted_count (null when 0). "consistent" is judged across the whole SDT (and, where available, against the candidate's other tests). List 3-6 OLQs reflected and 2-4 to work on. Include a per_item and items entry for every part answered. Be honest, concise and constructive.`,
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
  "items": [ { "n": <number>, "prompt": "<the slide label, e.g. Picture 1>", "comment": "one-sentence assessment of this story: hero, initiative, teamwork, past-to-outcome structure, tone and realism", "suggestion": "one concrete way to make this story stronger and more officer-like, grounded in the picture and what the candidate wrote", "past_outcome_structure": <true or false: does the story have a genuine past build-up leading to an achieved outcome, not a present-only scene>, "lone_wolf_hero": <true or false: does the hero do everything alone instead of taking others along> } ]
}
List 3-6 OLQs reflected and 2-4 to work on, naming actual OLQs from the list. Include an items entry for every story written. For each story also set the booleans past_outcome_structure and lone_wolf_hero. Be honest, concise and constructive.`,
    keyGuidance(focus)
  ].join("\n");
}
function buildTatPrompt(items, focus) {
  const lines = items.map((it) => `#${it.n} — ${it.prompt}\n   Story: ${it.response || "[left blank]"}`);
  return tatCriteria(focus) + "\n\n=== Candidate's TAT stories ===\n" + lines.join("\n");
}

function ppdtCriteria(focus) {
  return [
`You are an experienced, fair SSB (Services Selection Board) assessor evaluating a candidate's WRITTEN Picture Perception and Description Test (PPDT) response from the Day-1 screening stage. You assess only the written perception and story here (the in-person narration and group discussion are out of scope).
For each item you are shown the same hazy picture the candidate saw (when provided), the candidate's "Perception" line (number of characters, and the main character's age, sex, mood), and their short hero "Story".

IMPORTANT about the picture: PPDT pictures are hazy and ambiguous and there is NO single correct interpretation. Use the picture only to (a) check the perception and story are plausibly connected to the scene, and (b) ground your comments. NEVER lower your assessment because the candidate read the picture differently than you would; a plausible reading is fully valid. If no picture is provided, judge the text alone.

The master rubric is LRP: Logical, Relevant, Practical.
- RELEVANCE to the picture's main hint is the single biggest differentiator. A story that ignores the main hint, or pastes a pre-memorised theme onto the stimulus, is the top failure. Reward a story that clearly grew from what is in the picture.
- LOGICAL: the hero reaches the situation by design, not "by chance because a picture was shown". Every character shown should matter — if removing a character would not change the story, the reasoning did not fire.
- PRACTICAL: realistic, present-scale action in one flowing paragraph. No fantasy or mega-tasks (inventing an aircraft overnight); prefer prototype / project / NCC scale. Do not manufacture a problem just to solve it.

Judge each response on:
- Perception quality: a plausible character count, and the main character's age/sex/mood, coherent with the story. Mood should normally be positive, BUT a single, head-down or low figure is a negative/low mood, not "neutral" — reflexively calling a down-mood picture neutral is an observation error.
- One clear, positive, proactive HERO who matches the main perceived character (not a group, not a passive victim, not a bystander).
- DOER, NOT PREACHER (the sharpest single verdict): the hero must take concrete action. A hero who only "spreads awareness", "tells the villagers", "advises" or "informs people about schemes" is marked down. Reward building, organising, acting and solving at the root.
- A complete cause -> action -> positive, realistic outcome, with the task introduced fast (by the second or third line, not after a long intro).
- Teamwork when the picture shows a group: the hero keeps control but takes others along, delegates, seeks suggestions and gives credit. A hero who does everything alone on a group picture is a question mark.
- Technical stimulus (a device/machine/aircraft in the picture): use precise, justifiable terms (UAV, drone, glider — not vague "aircraft"), show genuine knowledge and service motivation, and never use words you cannot justify.
- OLQs shown through the hero's ACTION, not adjectives. Avoid negative-emotion words and "try" (the most damaging word).
Watch for: irrelevance to the main hint; a pre-memorised story; preaching instead of doing; fantasy / mega-tasks / create-a-problem-to-solve; negative or theatrical outcomes (crash, death); a passive, group, or rescued hero; merely describing the scene; point-form instead of a paragraph; introduced negativity not in the picture; a perception that does not match the story. Do not punish an honest, ordinary story that is relevant, positive and realistic.

The 15 Officer-Like Qualities (OLQs) are: effective intelligence, reasoning ability, organising ability, power of expression, social adaptability, cooperation, sense of responsibility, initiative, self-confidence, speed of decision, ability to influence the group, liveliness, determination, courage, stamina.

Return ONLY valid JSON with this exact shape:
{
  "summary": "a 3-5 sentence assessment in the voice of an SSB screening assessor: perception quality, the kind of hero projected, relevance to the hint, doer-vs-preacher, structure and realism, and whether the written response reads as screen-in material",
  "olqs_reflected": ["<OLQ name> — brief evidence"],
  "olqs_to_work_on": ["<OLQ name> — brief, actionable note"],
  "reflected_keys": ["<one or more of the 15 canonical keys>"],
  "work_keys": ["<one or more of the 15 canonical keys>"],
  "red_flags": ["<serious concern, e.g. violent/negative theme, a strongly irrelevant pasted story, or perception grossly mismatched to the picture; EMPTY ARRAY if none>"],
  "per_item": [ { "n": <int>, "response": "<the perception+story text>", "relevant_to_hint": <bool>, "doer_not_preacher": <bool>, "cause_action_outcome": <bool>, "positive_outcome": <bool>, "lone_wolf_hero": <bool>, "perception_count_plausible": <bool>, "mood_coded_correctly": <bool> } ],
  "metrics": { "mode": "PPDT", "items_count": <int>, "attempted_count": <int>, "relevant_to_hint_rate": <float|null>, "doer_not_preacher_rate": <float|null>, "cause_action_outcome_rate": <float|null>, "positive_outcome_rate": <float|null>, "lone_wolf_hero_rate": <float|null>, "perception_accuracy_rate": <float|null>, "reflected_keys": [...], "work_keys": [...], "red_flags": [...] },
  "items": [ { "n": <int>, "prompt": "<slide label>", "comment": "one-sentence assessment: relevance, doer-vs-preacher, hero, structure, realism", "suggestion": "one concrete way to make this response stronger and more officer-like, grounded in the picture and what the candidate wrote" } ]
}
Rate definitions: each *_rate = that flag's TRUE count / attempted_count (null when attempted_count is 0); perception_accuracy_rate = (perception_count_plausible AND mood_coded_correctly) count / attempted. List 3-6 OLQs reflected and 2-4 to work on. Include a per_item and items entry for every response. Be honest, concise and constructive.`,
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
`You are an experienced, fair SSB (Services Selection Board) Group Testing Officer (GTO) assessing a candidate's individual written plan for a Group Planning Exercise (GPE / Military Planning Exercise).
The candidate is given a scenario with several simultaneous, interrelated problems and limited resources, and about ten minutes to write their own plan before the group discussion. For each item you are given the full scenario and the candidate's plan.
IMPORTANT: there is no single correct plan. "No solution is wrong if it is sensible." Judge on sound judgement, logic and time/distance realism, not on matching one ideal answer. A different but well-justified priority order or destination is fully acceptable; penalise only genuinely illogical choices (e.g. crossing an unknown river and wasting time).

Judge each plan on:
- COMPLETENESS: every problem addressed, each taken to its logical end. After each problem there should be a "what next" (fall-back / regroup). Missing a problem is a major fault.
- PRIORITISATION: the written order is read as the candidate's priority. The hierarchy is: (1) immediate threat to life / medical emergency; (2) security / national interest / mass-casualty threat; (3) crime against a person; (4) property / personal / livelihood — last. Imminence and number of lives can re-order the top tiers (a crime in progress with people at risk can outrank a hazard threatening no one). Decoy/trivial problems (a lost cow, a lost mangalsutra) are seeded to look tempting: assign at least one person to them out of compassion, but NEVER rank them at the top. Putting a trivial problem first is a clear fault.
- DELEGATION: the group is split into parallel parties acting at once (e.g. a first-aid/evacuation party, an inform-authorities party, a party for the crime, a party for the minor task, then regroup) — not one hero doing everything serially.
- TIME-AND-DISTANCE REALISM: timings must be computed against realistic speeds, not guessed. Rough guide: car on pukka road 50-70 km/h; kaccha road 30-40; bus 40-50; motorcycle 60-80; bicycle 12-20; river downstream is fast and takes the shortest path. Check the plan fits the deadline. "I'll reach in half an hour" with no basis is a fault.
- INVOLVEMENT (explicitly graded): the plan must say WHAT, HOW and the candidate's own ROLE. "I'll take the injured to hospital" alone is NO involvement; "stop the bleeding by tying a cloth, lay him in the back with the leg raised, drive to the trauma centre at X, admit and inform family" shows involvement.
- OWNERSHIP / voice: written as the leader ("We will...", not "we should" or third person), ideally with an AIM stated at the top.
- EMPATHY: check "is anyone hurt / is everyone okay?" before mechanically assigning tasks; transport the injured humanely.
- RESOURCES: use only what is present. No invented phone, helicopter, or outside help.

Watch for: a missed problem; a trivial problem ranked first; serial or solo-hero action instead of parallel parties; guessed or impossible timings; "no-involvement" solutions (what, but not how or role); third-person "should" writing; no "what next"; no empathy check; unrealistic transport of the injured; inventing resources.

The relevant OLQs include: effective intelligence, reasoning ability, organising ability, power of expression, initiative, self-confidence, speed of decision, determination, cooperation.

Return ONLY valid JSON with this exact shape:
{
  "summary": "a 3-5 sentence assessment in the voice of a GTO: grasp of the situation, prioritisation (life first), delegation into parallel parties, time/distance realism, involvement/ownership, empathy, and overall planning ability",
  "olqs_reflected": ["<OLQ name> — brief evidence"],
  "olqs_to_work_on": ["<OLQ name> — brief, actionable note"],
  "reflected_keys": ["<one or more of the 15 canonical keys>"],
  "work_keys": ["<one or more of the 15 canonical keys>"],
  "red_flags": ["<serious concern, e.g. prioritising property/trivial over human life, or a plan that endangers people; EMPTY ARRAY if none>"],
  "per_item": [ { "n": <int>, "response": "<the plan text>", "all_problems_addressed": <bool>, "priority_order_correct": <bool>, "delegated_parallel": <bool>, "time_distance_computed": <bool>, "involvement_detailed": <bool>, "what_next_present": <bool>, "written_as_leader": <bool> } ],
  "metrics": { "mode": "GPE", "items_count": <int>, "attempted_count": <int>, "all_problems_addressed_rate": <float|null>, "priority_order_correct_rate": <float|null>, "delegated_parallel_rate": <float|null>, "time_distance_computed_rate": <float|null>, "involvement_detailed_rate": <float|null>, "what_next_present_rate": <float|null>, "written_as_leader_rate": <float|null>, "reflected_keys": [...], "work_keys": [...], "red_flags": [...] },
  "items": [ { "n": <int>, "prompt": "<scenario title>", "comment": "one-sentence assessment: completeness, prioritisation, delegation, time realism, involvement", "suggestion": "one concrete way to make this plan stronger and more officer-like, grounded in the scenario" } ]
}
Rate definitions: each *_rate = that flag's TRUE count / attempted_count (null when 0). List 3-6 OLQs reflected and 2-4 to work on. Include a per_item and items entry for every scenario. Be honest, concise and constructive.`,
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

/* ---- Structured per-item classification + session metrics (WAT/SRT/TAT) ----
   Judgment fields come from Gemini (in items[]); mechanical ones are computed
   here from the raw response; then items[] is cleaned for the open site and
   per_item[] + metrics{} are attached for the portal. */
const LOADED_WORDS = ["death","die","dead","fear","afraid","scared","knife","gun","failure","fail","failed","murder","accident","defeat","loss","lose","blood","fight","war","hate","angry","cry","sad","alone","lonely","danger","poison","fire","attack","enemy","problem","quit","weak","coward","revenge","injury","hurt","pain","threat","kill","bomb","theft","cheat","divorce","disease","terror","riot","flood","earthquake","drown"];
const ADVERBS = ["calmly","bravely","immediately","swiftly","quickly","confidently","politely","carefully","boldly","instantly","fearlessly","courageously","promptly","diligently"];
const STOCK_PHRASES = ["didn't panic","did not panic","without panic","raised morale","kept calm","keeping calm","stayed calm","remained calm","without fear","no fear","took charge","rose to the occasion","saved the day"];

function hasTry(s) { return /\b(try|tries|tried|trying)\b/i.test(s || ""); }
function hasAdverbStock(s) {
  const low = String(s || "").toLowerCase();
  for (const a of ADVERBS) { if (new RegExp("\\b" + a + "\\b").test(low)) return true; }
  for (const p of STOCK_PHRASES) { if (low.indexOf(p) !== -1) return true; }
  return false;
}
function normBucket(b) {
  b = String(b || "").toLowerCase().trim();
  return (b === "observational" || b === "factual" || b === "personal" || b === "preachy") ? b : null;
}
function isLoadedWord(word) {
  const w = String(word || "").toLowerCase().trim();
  if (w.length < 3) return false;
  return LOADED_WORDS.some((L) => w === L || w.indexOf(L) !== -1 || L.indexOf(w) !== -1);
}

// PPDT/GPE/SDT: all judgment fields come from Gemini inside per_item[].
const PGS_FIELDS = {
  PPDT: ["relevant_to_hint", "doer_not_preacher", "cause_action_outcome", "positive_outcome", "lone_wolf_hero", "perception_count_plausible", "mood_coded_correctly"],
  GPE: ["all_problems_addressed", "priority_order_correct", "delegated_parallel", "time_distance_computed", "involvement_detailed", "what_next_present", "written_as_leader"],
  SDT: ["evidence_based", "weakness_placement_ok", "consistent"]
};

// For PPDT/GPE/SDT, take Gemini's per_item judgment, rebuild response from the
// request (authoritative), and recompute metrics in the Worker for reliable rates.
function enrichPGS(mode, reqItems, parsed) {
  const FIELDS = PGS_FIELDS[mode];
  const gpi = Array.isArray(parsed.per_item) ? parsed.per_item : [];
  const byN = {};
  gpi.forEach((p) => { if (p && p.n != null) byN[p.n] = p; });
  const per_item = (Array.isArray(reqItems) ? reqItems : []).map((ri, idx) => {
    const n = (ri && ri.n != null) ? ri.n : (idx + 1);
    const g = byN[n] || {};
    const o = { n: n, response: (ri && ri.response) || "" };
    FIELDS.forEach((f) => { o[f] = !!g[f]; });
    return o;
  });
  parsed.per_item = per_item;
  parsed.metrics = computeMetrics(mode, reqItems, per_item, parsed);
}

function enrich(mode, reqItems, parsed) {
  if (PGS_FIELDS[mode]) { enrichPGS(mode, reqItems, parsed); return; }
  if (mode !== "WAT" && mode !== "SRT" && mode !== "TAT") return;
  const gItems = Array.isArray(parsed.items) ? parsed.items : [];
  const byN = {};
  gItems.forEach((it) => { if (it && it.n != null) byN[it.n] = it; });

  const per_item = [];
  (Array.isArray(reqItems) ? reqItems : []).forEach((ri, idx) => {
    const n = (ri && ri.n != null) ? ri.n : (idx + 1);
    const g = byN[n] || {};
    const response = (ri && ri.response) || "";
    if (mode === "WAT") {
      per_item.push({
        n: n, response: response,
        bucket: normBucket(g.bucket),
        flags: { try: hasTry(response), negation: !!g.negation, bravado: !!g.bravado, dictionary_meaning: !!g.dictionary_meaning }
      });
    } else if (mode === "SRT") {
      per_item.push({
        n: n, response: response,
        reached_objective: !!g.reached_objective,
        superhero_escalation: !!g.superhero_escalation,
        adverb_stock_phrase: hasAdverbStock(response),
        moral_red_flag: !!g.moral_red_flag
      });
    } else { // TAT
      per_item.push({
        n: n, response: response,
        past_outcome_structure: !!g.past_outcome_structure,
        lone_wolf_hero: !!g.lone_wolf_hero
      });
    }
  });

  // Keep items[] clean for the open site: strip the judgment fields Gemini added.
  gItems.forEach((g) => {
    if (!g) return;
    ["bucket", "negation", "bravado", "dictionary_meaning", "reached_objective",
     "superhero_escalation", "moral_red_flag", "past_outcome_structure", "lone_wolf_hero"]
      .forEach((k) => { delete g[k]; });
  });

  parsed.per_item = per_item;
  parsed.metrics = computeMetrics(mode, reqItems, per_item, parsed);
}

function computeMetrics(mode, reqItems, per_item, parsed) {
  const attempted = per_item.filter((p) => p.response && p.response.trim()).length;
  const rate = (num, den) => (den > 0 ? Math.round((num / den) * 100) / 100 : null);
  const promptOf = (n) => { const it = (reqItems || []).find((x) => x && x.n === n); return it ? it.prompt : ""; };
  const m = {
    mode: mode,
    items_count: per_item.length,
    attempted_count: attempted,
    reflected_keys: Array.isArray(parsed.reflected_keys) ? parsed.reflected_keys : [],
    work_keys: Array.isArray(parsed.work_keys) ? parsed.work_keys : [],
    red_flags: Array.isArray(parsed.red_flags) ? parsed.red_flags : []
  };
  if (mode === "WAT") {
    const mix = { observational: 0, factual: 0, personal: 0, preachy: 0 };
    let tryc = 0, loaded = 0, framed = 0;
    per_item.forEach((p) => {
      if (p.bucket && mix.hasOwnProperty(p.bucket)) mix[p.bucket]++;
      if (p.flags.try) tryc++;
      if (isLoadedWord(promptOf(p.n))) { loaded++; if ((p.bucket === "observational" || p.bucket === "factual") && !p.flags.negation) framed++; }
    });
    m.wat_bucket_mix = mix;
    m.try_count = tryc;
    m.loaded_framing_rate = rate(framed, loaded);
  } else if (mode === "SRT") {
    let ro = 0, se = 0, asp = 0, mrf = 0;
    per_item.forEach((p) => { if (p.reached_objective) ro++; if (p.superhero_escalation) se++; if (p.adverb_stock_phrase) asp++; if (p.moral_red_flag) mrf++; });
    m.srt_attempt_count = attempted;
    m.srt_completion_rate = rate(ro, attempted);
    m.superhero_escalation_rate = rate(se, attempted);
    m.adverb_stock_phrase_rate = rate(asp, attempted);
    m.moral_red_flag_count = mrf;
  } else if (mode === "TAT") {
    let st = 0, lw = 0;
    per_item.forEach((p) => { if (p.past_outcome_structure) st++; if (p.lone_wolf_hero) lw++; });
    m.tat_structure_rate = rate(st, attempted);
    m.lone_wolf_hero_rate = rate(lw, attempted);
  } else if (mode === "PPDT") {
    const c = (f) => per_item.filter((p) => p[f]).length;
    m.relevant_to_hint_rate = rate(c("relevant_to_hint"), attempted);
    m.doer_not_preacher_rate = rate(c("doer_not_preacher"), attempted);
    m.cause_action_outcome_rate = rate(c("cause_action_outcome"), attempted);
    m.positive_outcome_rate = rate(c("positive_outcome"), attempted);
    m.lone_wolf_hero_rate = rate(c("lone_wolf_hero"), attempted);
    m.perception_accuracy_rate = rate(per_item.filter((p) => p.perception_count_plausible && p.mood_coded_correctly).length, attempted);
  } else if (mode === "GPE") {
    const c = (f) => per_item.filter((p) => p[f]).length;
    m.all_problems_addressed_rate = rate(c("all_problems_addressed"), attempted);
    m.priority_order_correct_rate = rate(c("priority_order_correct"), attempted);
    m.delegated_parallel_rate = rate(c("delegated_parallel"), attempted);
    m.time_distance_computed_rate = rate(c("time_distance_computed"), attempted);
    m.involvement_detailed_rate = rate(c("involvement_detailed"), attempted);
    m.what_next_present_rate = rate(c("what_next_present"), attempted);
    m.written_as_leader_rate = rate(c("written_as_leader"), attempted);
  } else if (mode === "SDT") {
    const c = (f) => per_item.filter((p) => p[f]).length;
    m.evidence_based_rate = rate(c("evidence_based"), attempted);
    m.weakness_placement_ok_rate = rate(c("weakness_placement_ok"), attempted);
    m.consistent_rate = rate(c("consistent"), attempted);
  }
  return m;
}

// Weekly synthesis over already-analysed data (no raw re-judging).
function buildWeeklyPrompt(payload) {
  const student = (payload && payload.student) || {};
  const data = JSON.stringify({
    student: { name: student.name || null },
    window: (payload && payload.window) || {},
    olq_profile: Array.isArray(payload && payload.olq_profile) ? payload.olq_profile : [],
    sessions: Array.isArray(payload && payload.sessions) ? payload.sessions : []
  });
  return [
    `You are an experienced, fair SSB (Services Selection Board) coach reviewing one candidate's WEEK of already-analysed practice. You are given their OLQ profile and each session's metrics, per-item classifications and summaries. Do NOT re-judge individual responses; reason over the structured data and the trends across the week.`,
    `Gatekeeper OLQs (moral values, social adaptability, cooperation, sense of responsibility, liveliness, courage) weigh most. Treat any moral or integrity red flag as the top priority in both reports.`,
    ``,
    `Produce TWO things in one JSON object:`,
    `- studentReport: the 3 to 4 most important things to focus on next, in plain, encouraging language, no jargon, no metric dumps, framed as practice and not the real board. Each focus item is pattern, then why it matters, then one specific action.`,
    `- adminReport: the full technical breakdown for the mentor: how the metrics moved across the week, movement in the Officer-Like Qualities, gatekeeper-OLQ concerns, recurring patterns, and any serious red flags. Detailed is fine here.`,
    ``,
    `Return ONLY valid JSON with this exact shape:`,
    `{`,
    `  "studentReport": {`,
    `    "headline": "one short, encouraging, practice-not-the-board line",`,
    `    "focus": [ { "pattern": "<what keeps happening, plainly>", "why": "<why it matters for an officer, plainly>", "action": "<one specific thing to do next session>" } ]`,
    `  },`,
    `  "adminReport": {`,
    `    "overview": "2-4 sentence technical summary of the week",`,
    `    "metrics_movement": [ { "metric": "<metric name>", "from": <number or null>, "to": <number or null>, "trend": "up|down|flat" } ],`,
    `    "olq_movement": [ { "olq": "<canonical OLQ key>", "reflected_delta": <integer>, "work_delta": <integer> } ],`,
    `    "gatekeeper_flags": ["<concern on a gatekeeper OLQ; empty array if none>"],`,
    `    "recurring_patterns": ["<pattern seen across sessions>"],`,
    `    "red_flags": ["<serious integrity or disqualifying concern this week; empty array if none>"]`,
    `  }`,
    `}`,
    `Keep studentReport.focus to 3 or 4 items. Be honest, specific and constructive.`,
    ``,
    `=== Candidate's week (structured data) ===`,
    data
  ].join("\n");
}

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Engine-Key",
    "Vary": "Origin"
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, cors || {})
  });
}
