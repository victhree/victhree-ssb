# VicThree SSB — WAT & SRT Preparation Site

A static, mobile-first study site for the SSB interview psychology tests, hosted on GitHub Pages. Phase 1 covers the **Word Association Test (WAT)** and **Situation Reaction Test (SRT)** — teaching pages plus two timed interactive trainers.

- **No backend, no build step** — plain HTML/CSS/JS. Just push and it works.
- **Optional AI analysis** via Gemini (through a Cloudflare Worker that keeps your API key secret).
- Design: deep navy `#0f2340` + gold `#b8912f` + paper `#fbfaf6`, serif body.

---

## Folder structure

```
victhree-ssb/
├── index.html                      Home / landing
├── about/index.html                About + disclaimer
├── assets/
│   ├── styles.css                  Shared theme (all pages)
│   ├── banner.png                  Header logo
│   ├── config.js                   ← set your Gemini Worker URL here
│   └── trainer.js                  Shared trainer engine (WAT + SRT)
├── data/
│   ├── wat-practice.js             36 WAT words (edit to add more)
│   └── srt-practice.js             16 SRT situations (edit to add more)
├── psychology/
│   ├── index.html                  Overview — "The One Reframe"
│   ├── wat/
│   │   ├── index.html              WAT module landing
│   │   ├── basics/                 Lesson 1
│   │   ├── negative-words/         Lesson 2
│   │   ├── positive-trap/          Lesson 3
│   │   └── practice/               Timed WAT trainer
│   └── srt/
│       ├── index.html              SRT module landing
│       ├── basics/                 Lesson 1
│       ├── dilemmas/               Lesson 2
│       ├── double-bind/            Lesson 3
│       ├── ethical/                Deep dive
│       ├── personal/               Deep dive
│       └── practice/               Timed SRT trainer
└── worker/worker.js                Cloudflare Worker for Gemini (deploy separately)
```

---

## Deploy to GitHub Pages

1. Create a repo named **`victhree-ssb`** under the `victhree` account.
2. Upload the whole `victhree-ssb` folder contents (or `git push`).
3. Repo → **Settings → Pages** → Source: **Deploy from a branch** → Branch: `main`, folder `/ (root)` → Save.
4. Your site goes live at **`https://victhree.github.io/victhree-ssb/`** within a minute or two.

All internal links are **relative**, so it works both at that URL and if you open files locally.

> **Local preview:** double-click `index.html` in your browser (Chrome/Edge). The interactive trainers run fully from `file://` in a normal browser.

---

## Add a new lesson page

1. Copy an existing lesson folder, e.g. `psychology/wat/basics/`, to a new folder like `psychology/wat/my-lesson/`.
2. Edit the `index.html`: update `<title>`, the `<h1>`, and the body content.
3. Keep the relative asset paths correct for the depth (a page 3 levels deep uses `../../../assets/styles.css`).
4. Add a link to it from the module landing page (`psychology/wat/index.html`) in the `.lesson-list`.

**Content building blocks** (see any lesson for examples):
- Callouts: `<div class="callout sop|principle|trap|example">` with a `<div class="label">…</div>`.
- Compare boxes: `<div class="compare"><div class="cbox bad">…</div><div class="cbox good">…</div></div>`.
- Dilemma tags: `<span class="tag emergency|ethical|interpersonal|team|personal|bind">…</span>`.
- Tables: wrap in `<div class="tbl-scroll">` so they scroll on mobile.

## Add / edit practice items

- **WAT:** edit `data/wat-practice.js` — each item `{ word, type }` where type is `"P"` (positive), `"N"` (negative) or `"X"` (neutral).
- **SRT:** edit `data/srt-practice.js` — each item `{ situation, tag }` where tag is `EMERGENCY | ETHICAL | INTERPERSONAL | TEAM | PERSONAL | BIND`.

The trainers pick up changes automatically — no other edits needed.

---

## Enabling Gemini analysis (optional)

The trainers work fully without AI (self-review + self-audit checklist + offline heuristic read + a "copy for AI" button). To have **Gemini analyse responses in-page**, set up a small Cloudflare Worker so your API key stays secret. All steps are in the browser — no Node needed.

### 1. Get a free Gemini API key
- Go to **Google AI Studio** → **Get API key** → create a key. Copy it.
- (Recommended) In Google Cloud, set a **usage cap / quota** on the key so it can never run up a surprise bill.

### 2. Create the Cloudflare Worker
1. Sign up at **dash.cloudflare.com** (free).
2. **Workers & Pages → Create → Worker**. Give it a name, e.g. `victhree-ssb-ai`. Deploy the starter, then **Edit code**.
3. Delete the starter code and paste the entire contents of **`worker/worker.js`** from this repo. Save & Deploy.
4. **Settings → Variables and Secrets → Add** a secret named exactly **`GEMINI_API_KEY`** with your key as the value. Save.
5. Copy your Worker URL — it looks like `https://victhree-ssb-ai.<your-subdomain>.workers.dev`.

### 3. Point the site at the Worker
- Open **`assets/config.js`** and set:
  ```js
  window.VICTHREE_CONFIG = { aiEndpoint: "https://victhree-ssb-ai.<your-subdomain>.workers.dev" };
  ```
- Commit/push. Done — the results screen now shows Gemini's analysis above the self-review.

### Notes on safety & cost
- The Worker only accepts requests from your GitHub Pages origin (`https://victhree.github.io`) — edit `ALLOWED_ORIGINS` in `worker/worker.js` if you add a custom domain.
- Origin checks stop casual abuse but can be spoofed by non-browser clients, so **also keep the Google API usage cap** as your real safety net.
- Gemini Flash is inexpensive and has a generous free tier; typical trainer analyses are small.
- If the Worker is down or misconfigured, the site degrades gracefully — the trainer still works and just shows the self-review.

---

## Disclaimer

Independent study material. Not affiliated with or endorsed by the Services Selection Board, UPSC, or the Ministry of Defence. There are no official "correct" answers in the SSB psychology tests — every example illustrates a mindset, not a script to memorise.
