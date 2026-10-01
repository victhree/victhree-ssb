/* VicThree SSB — homepage personalised greeting.
   The entry popup / sign-in now lives in auth.js. This file only shows the
   rotating, typed welcome line above the homepage heading, for a visitor whose
   name we know (course or free). It re-renders when identity is established. */
(function () {
  "use strict";

  function el(tag, cls, html) { var n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // [big line with {name}, smaller line below]. Rotated one per visit.
  var GREETINGS = [
    ["Welcome back, {name}.", "The academy gate opens for those who prepare when no one is watching."],
    ["Good to have you, {name}.", "Every officer once stood exactly where you stand today, one honest attempt at a time."],
    ["Discipline over mood, {name}.", "Train today the way you intend to lead tomorrow."],
    ["Steady on, {name}.", "Officer Like Qualities are built, not born, and yours are taking shape."],
    ["{name}, the Services ask for a calm mind and a willing heart.", "Practise both, right here."],
    ["Keep showing up, {name}.", "The uniform is earned in quiet hours like these."],
    ["Rise a little sharper each day, {name}.", "That is what selection really measures."],
    ["{name}, courage is a habit.", "Build it one session at a time."]
  ];

  function firstName() {
    var raw = "";
    try { raw = (JSON.parse(localStorage.getItem("v3_lead_data") || "{}").name) || ""; } catch (e) {}
    raw = raw.trim();
    if (!raw) return "";
    var f = raw.split(/\s+/)[0];
    return f.charAt(0).toUpperCase() + f.slice(1);
  }

  function typeGreeting(g, bigSegs, smallText) {
    var bigEl = g.querySelector(".greet-big");
    var smallEl = g.querySelector(".greet-small");
    bigEl.innerHTML = bigSegs.map(function (s) {
      return s.gold ? '<span class="greet-name">' + esc(s.text) + "</span>" : esc(s.text);
    }).join("");
    smallEl.textContent = smallText;
    g.style.minHeight = g.offsetHeight + "px";
    bigEl.textContent = ""; smallEl.textContent = "";

    var steps = [];
    bigSegs.forEach(function (s) { for (var i = 0; i < s.text.length; i++) steps.push({ ch: s.text[i], gold: s.gold, small: false }); });
    for (var j = 0; j < smallText.length; j++) steps.push({ ch: smallText[j], gold: false, small: true });

    var caret = el("span", "greet-caret"); bigEl.appendChild(caret);
    var goldSpan = null, k = 0, SPEED = 60;
    function tick() {
      if (k >= steps.length) { caret.remove(); return; }
      var st = steps[k++];
      var line = st.small ? smallEl : bigEl;
      if (st.gold) { if (!goldSpan) { goldSpan = el("span", "greet-name"); line.appendChild(goldSpan); } goldSpan.appendChild(document.createTextNode(st.ch)); }
      else { goldSpan = null; line.appendChild(document.createTextNode(st.ch)); }
      line.appendChild(caret);
      setTimeout(tick, SPEED);
    }
    setTimeout(tick, 260);
  }

  function renderGreeting() {
    var anchor = document.querySelector(".home-title"); // homepage only
    if (!anchor || document.querySelector(".greet")) return;
    var name = firstName();
    if (!name) return;

    var i = 0;
    try { i = parseInt(localStorage.getItem("v3_greet_i") || "0", 10) || 0; } catch (e) {}
    var msg = GREETINGS[i % GREETINGS.length];
    try { localStorage.setItem("v3_greet_i", String((i + 1) % GREETINGS.length)); } catch (e) {}

    var parts = msg[0].split("{name}");
    var bigSegs = [{ text: parts[0] || "", gold: false }, { text: name, gold: true }, { text: parts[1] || "", gold: false }];
    var g = el("div", "greet");
    g.innerHTML = '<p class="greet-big"></p><p class="greet-small"></p>';
    anchor.parentNode.insertBefore(g, anchor);

    var reduce = false;
    try { reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
    if (reduce) {
      g.querySelector(".greet-big").innerHTML = esc(bigSegs[0].text) + '<span class="greet-name">' + esc(name) + "</span>" + esc(bigSegs[2].text);
      g.querySelector(".greet-small").textContent = msg[1];
      return;
    }
    typeGreeting(g, bigSegs, msg[1]);
  }

  function boot() { renderGreeting(); }
  document.addEventListener("v3:identity", renderGreeting); // show it right after sign-in / free sign-up

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
