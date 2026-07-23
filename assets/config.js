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
  aiEndpoint: "https://victhree-ssb-ai.anmolxsharma.workers.dev"
};
