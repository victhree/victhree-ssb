/* VicThree SSB — site config.
   ----------------------------------------------------------------
   AI ANALYSIS (optional):
   To turn on real Gemini analysis of trainer responses, paste the URL of your
   deployed Cloudflare Worker between the quotes below, e.g.
       aiEndpoint: "https://victhree-ssb-ai.yourname.workers.dev"
   Leave it as "" to keep AI OFF — the trainer still works fully with
   self-review + the offline heuristic read + the copy-to-AI export.
   Setup steps are in README.md (section "Enabling Gemini analysis").
   ---------------------------------------------------------------- */
window.VICTHREE_CONFIG = {
  aiEndpoint: "https://victhree-ssb-ai.anmolxsharma.workers.dev",

  /* LEAD CAPTURE (welcome popup -> Google Sheet).
     Easiest method: a Google Form linked to a Sheet. Fill the three
     "entry.xxxx" ids and the form action URL below (Vanshika will paste a
     pre-filled link and Claude fills these in). Leave the ids blank to keep
     the popup working without recording yet. */
  googleForm: {
    action: "https://docs.google.com/forms/d/e/1FAIpQLSdsJepraQ-FX9GLkol9RyCEs9QewyyogUfdRPCBo50xDagxAQ/formResponse",
    fields: {
      name:  "entry.1536510871",
      phone: "entry.1840223658",
      email: "entry.547499315"
    }
  },

  /* Advanced alternative (Apps Script Web App). Ignored if googleForm above
     is filled in. See google-sheet/SETUP.md. */
  sheetEndpoint: ""
};
