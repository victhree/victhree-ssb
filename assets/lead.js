/* VicThree Defence — welcome popup / lead capture.
   Shows a one-time gate asking for name, phone and email, then posts the
   details to a Google Sheet (via an Apps Script Web App set in config.js).
   Once submitted, it never shows again for that visitor (localStorage). */
(function () {
  "use strict";

  var KEY = "v3_lead_done";
  var CFG = window.VICTHREE_CONFIG || {};
  var ENDPOINT = CFG.sheetEndpoint || "";

  // Has this visitor already given their details?
  var done = false;
  try { done = !!localStorage.getItem(KEY); } catch (e) {}

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Personalised motivating lines shown on the homepage to returning visitors.
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

    // Render the final text once to lock in the card height (no layout jump),
    // then clear it and type it back out.
    bigEl.innerHTML = bigSegs.map(function (s) {
      return s.gold ? '<span class="greet-name">' + esc(s.text) + "</span>" : esc(s.text);
    }).join("");
    smallEl.textContent = smallText;
    g.style.minHeight = g.offsetHeight + "px";
    bigEl.textContent = "";
    smallEl.textContent = "";

    // Flatten to per-character steps.
    var steps = [];
    bigSegs.forEach(function (s) {
      for (var i = 0; i < s.text.length; i++) steps.push({ ch: s.text[i], gold: s.gold, small: false });
    });
    for (var j = 0; j < smallText.length; j++) steps.push({ ch: smallText[j], gold: false, small: true });

    var caret = el("span", "greet-caret");
    bigEl.appendChild(caret);

    var goldSpan = null, k = 0, SPEED = 60;
    function tick() {
      if (k >= steps.length) { caret.remove(); return; }
      var st = steps[k++];
      var line = st.small ? smallEl : bigEl;
      if (st.gold) {
        if (!goldSpan) { goldSpan = el("span", "greet-name"); line.appendChild(goldSpan); }
        goldSpan.appendChild(document.createTextNode(st.ch));
      } else {
        goldSpan = null;
        line.appendChild(document.createTextNode(st.ch));
      }
      line.appendChild(caret); // move caret to the end of the active line
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
    var bigSegs = [
      { text: parts[0] || "", gold: false },
      { text: name, gold: true },
      { text: parts[1] || "", gold: false }
    ];
    var smallText = msg[1];

    var g = el("div", "greet");
    g.innerHTML = '<p class="greet-big"></p><p class="greet-small"></p>';
    anchor.parentNode.insertBefore(g, anchor);

    var reduce = false;
    try { reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
    if (reduce) {
      g.querySelector(".greet-big").innerHTML =
        esc(bigSegs[0].text) + '<span class="greet-name">' + esc(name) + "</span>" + esc(bigSegs[2].text);
      g.querySelector(".greet-small").textContent = smallText;
      return;
    }
    typeGreeting(g, bigSegs, smallText);
  }

  function build() {
    var overlay = el("div", "lead-overlay");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "lead-title");

    var card = el("div", "lead-card");
    card.innerHTML =
      '<div class="lead-banner"><img src="assets/banner.png" alt="VicThree Defence, by Anmol Sharma"></div>' +
      '<div class="lead-body">' +
        '<h2 id="lead-title" class="lead-title">Welcome to VicThree Defence</h2>' +
        '<form class="lead-form" novalidate>' +
          '<label class="lead-field"><span>Name</span>' +
            '<input type="text" name="name" autocomplete="name" required></label>' +
          '<label class="lead-field"><span>Phone number</span>' +
            '<input type="tel" name="phone" autocomplete="tel" inputmode="numeric" required></label>' +
          '<label class="lead-field"><span>Email address</span>' +
            '<input type="email" name="email" autocomplete="email" required></label>' +
          '<p class="lead-error" role="alert"></p>' +
          '<button type="submit" class="lead-btn">Let\'s get started</button>' +
        '</form>' +
      '</div>';

    overlay.appendChild(card);
    return overlay;
  }

  function post(data) {
    // Preferred: Google Form (no server to deploy).
    var gf = CFG.googleForm;
    if (gf && gf.action && gf.fields && gf.fields.name) {
      var fb = new URLSearchParams();
      fb.set(gf.fields.name, data.name);
      if (gf.fields.phone) fb.set(gf.fields.phone, data.phone);
      if (gf.fields.email) fb.set(gf.fields.email, data.email);
      return fetch(gf.action, { method: "POST", mode: "no-cors", body: fb })
        .catch(function () {});
    }
    // Alternative: Apps Script Web App.
    if (ENDPOINT) {
      var body = new URLSearchParams();
      body.set("name", data.name);
      body.set("phone", data.phone);
      body.set("email", data.email);
      body.set("page", location.href);
      body.set("ts", new Date().toISOString());
      return fetch(ENDPOINT, { method: "POST", mode: "no-cors", body: body })
        .catch(function () {});
    }
    return Promise.resolve();
  }

  function show() {
    var overlay = build();
    document.body.appendChild(overlay);
    document.documentElement.classList.add("lead-open");

    var form = overlay.querySelector(".lead-form");
    var errBox = overlay.querySelector(".lead-error");
    var btn = overlay.querySelector(".lead-btn");
    var nameEl = form.name, phoneEl = form.phone, emailEl = form.email;

    // focus first field shortly after paint
    setTimeout(function () { try { nameEl.focus(); } catch (e) {} }, 60);

    function fail(msg, field) {
      errBox.textContent = msg;
      if (field) try { field.focus(); } catch (e) {}
    }

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      errBox.textContent = "";

      var name = (nameEl.value || "").trim();
      var email = (emailEl.value || "").trim();
      var phoneRaw = (phoneEl.value || "").trim();
      var digits = phoneRaw.replace(/[^\d]/g, "");

      if (name.length < 2) return fail("Please enter your name.", nameEl);
      if (digits.length < 10 || digits.length > 13)
        return fail("Please enter a valid phone number.", phoneEl);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return fail("Please enter a valid email address.", emailEl);

      btn.disabled = true;
      btn.textContent = "Just a moment...";

      var data = { name: name, phone: phoneRaw, email: email };
      // Keep a local backup regardless of network result.
      try { localStorage.setItem("v3_lead_data", JSON.stringify(data)); } catch (e) {}

      post(data).then(function () {
        try { localStorage.setItem(KEY, "1"); } catch (e) {}
        overlay.classList.add("lead-closing");
        setTimeout(function () {
          overlay.remove();
          document.documentElement.classList.remove("lead-open");
          renderGreeting(); // welcome them by name straight away
        }, 260);
      });
    });
  }

  // Show the popup 5 seconds after a new visitor lands on the site.
  var DELAY = 5000;
  function schedule() { setTimeout(show, DELAY); }

  function boot() {
    renderGreeting();          // returning visitors: greet by name
    if (!done) schedule();     // new visitors: popup after 5s
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
