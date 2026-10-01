/* VicThree SSB — identity, access tiers, and the entry popup.
   Loaded before trainer.js on every page.

   Two kinds of signed-in user:
     - course: has the portal login token (vt_portal_token). Unlimited, all tests.
     - free:   gave name/phone/email once (vt_ssb_free token). PPDT/WAT/SRT only,
               one of each per 24h. Enforced by the portal; this file just shows
               the right UI and gates test starts.

   Public API (window.V3):
     V3.getToken()    -> active bearer token ("" if none)
     V3.hasToken()    -> boolean
     V3.getStudent()  -> {name,email} or null
     V3.getTier()     -> "course" | "free" | null
     V3.isSignedIn()  -> true only for a course student
     V3.allow(mode)   -> Promise<{allowed,reason?,retry_after_ms?,tier?}>
     V3.getSSB()      -> Promise of /api/ssb/me (course only; null otherwise)
     V3.openGate(step)-> open the entry popup ("choice" | "signin" | "free")
     V3.ready         -> Promise resolved once the stored token is validated
*/
(function () {
  "use strict";

  var CFG = window.VICTHREE_CONFIG || {};
  var PORTAL = (CFG.portalEndpoint || "").replace(/\/+$/, "");
  var COURSE_URL = CFG.courseUrl || "https://victhreedefence.com";
  var PROGRESS_URL = CFG.portalProgressUrl || "";
  var GFORM = CFG.googleForm || null;
  var COURSE_KEY = "vt_portal_token";
  var FREE_KEY = "vt_ssb_free";

  var student = null;   // {name,email}
  var tier = null;      // "course" | "free" | null
  var ssbCache = null;

  function lsGet(k) { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } }
  function lsSet(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) {} }
  function courseToken() { return lsGet(COURSE_KEY); }
  function freeToken() { return lsGet(FREE_KEY); }
  function getToken() { return courseToken() || freeToken(); }
  function hasToken() { return !!getToken(); }
  function authHeaders(extra) { var h = extra || {}; var t = getToken(); if (t) h["Authorization"] = "Bearer " + t; return h; }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function el(tag, cls, html) { var n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; }
  function firstName(name) { var f = (name || "").trim().split(/\s+/)[0] || ""; return f ? f.charAt(0).toUpperCase() + f.slice(1) : ""; }

  // assets/ folder, so the banner resolves from any page depth.
  var BASE = (function () {
    var s = document.currentScript;
    if (!s) { var all = document.getElementsByTagName("script"); for (var i = all.length - 1; i >= 0; i--) { if (/auth\.js/.test(all[i].src)) { s = all[i]; break; } } }
    return (s && s.src ? s.src : "").replace(/[^\/]*$/, "");
  })();

  // Token handoff: the portal links here with #vt=<course token>.
  (function grabHash() {
    try {
      var m = location.hash.match(/[#&]vt=([^&]+)/);
      if (m) {
        lsSet(COURSE_KEY, decodeURIComponent(m[1]));
        var clean = location.hash.replace(/([#&])vt=[^&]+/, "$1").replace(/^#&/, "#").replace(/^#$/, "");
        history.replaceState(null, "", location.pathname + location.search + clean);
      }
    } catch (e) {}
  })();

  function setIdentity(name, email, t) {
    student = { name: name, email: email };
    tier = t;
    window.V3_STUDENT = student;
    try { if (name) localStorage.setItem("v3_lead_data", JSON.stringify({ name: name, email: email })); } catch (e) {}
    document.dispatchEvent(new Event("v3:identity"));
  }

  function fitToViewport(overlay) {
    var vv = window.visualViewport;
    if (!vv) return function () {};
    function apply() { overlay.style.height = vv.height + "px"; overlay.style.top = vv.offsetTop + "px"; overlay.style.bottom = "auto"; }
    apply(); vv.addEventListener("resize", apply); vv.addEventListener("scroll", apply);
    return function () { vv.removeEventListener("resize", apply); vv.removeEventListener("scroll", apply); overlay.style.height = ""; overlay.style.top = ""; overlay.style.bottom = ""; };
  }

  // ---- validate stored token ----
  function validate(depth) {
    depth = depth || 0;
    var t = getToken();
    if (!t || !PORTAL) { renderStrip(); maybeGate(); return Promise.resolve(null); }
    return fetch(PORTAL + "/api/me", { headers: authHeaders() })
      .then(function (r) {
        if (r.status === 200) return r.json();
        if (r.status === 401) { if (t === courseToken()) lsSet(COURSE_KEY, ""); else lsSet(FREE_KEY, ""); }
        return null;
      })
      .then(function (d) {
        if (d && d.tier) { setIdentity(d.name, d.email, d.tier); }
        else if (depth < 1 && getToken()) { return validate(depth + 1); } // try the other token
        renderStrip(); maybeGate();
        return d;
      })
      .catch(function () { renderStrip(); maybeGate(); return null; });
  }

  // ---- allow a test start ----
  function allow(mode) {
    if (!getToken()) return Promise.resolve({ allowed: false, reason: "auth" });
    if (tier === "course") return Promise.resolve({ allowed: true, tier: "course" });
    if (!PORTAL) return Promise.resolve({ allowed: false, reason: "network" });
    return fetch(PORTAL + "/api/ssb/allow?mode=" + encodeURIComponent(mode), { headers: authHeaders() })
      .then(function (r) { if (r.status === 401) return { allowed: false, reason: "auth" }; return r.json(); })
      .catch(function () { return { allowed: false, reason: "network" }; });
  }

  function getSSB() {
    if (tier !== "course") return Promise.resolve(null);
    if (!ssbCache) {
      ssbCache = fetch(PORTAL + "/api/ssb/me", { headers: authHeaders() })
        .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    }
    return ssbCache;
  }

  function captureToSheet(data) {
    if (!GFORM || !GFORM.action || !GFORM.fields) return;
    try {
      var b = new URLSearchParams();
      if (GFORM.fields.name) b.set(GFORM.fields.name, data.name);
      if (GFORM.fields.phone) b.set(GFORM.fields.phone, data.phone);
      if (GFORM.fields.email) b.set(GFORM.fields.email, data.email);
      fetch(GFORM.action, { method: "POST", mode: "no-cors", body: b }).catch(function () {});
    } catch (e) {}
  }

  function freeRegister(data) {
    if (!PORTAL) return Promise.resolve({ ok: false, error: "network" });
    return fetch(PORTAL + "/api/ssb/free-register", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (res) {
        if (res.status === 200 && res.body && res.body.token) {
          lsSet(FREE_KEY, res.body.token);
          ssbCache = null;
          setIdentity(res.body.name || data.name, data.email, "free");
          return { ok: true };
        }
        if (res.body && res.body.error === "bad_email") return { ok: false, error: "bad_email" };
        return { ok: false, error: "server" };
      }).catch(function () { return { ok: false, error: "network" }; });
  }

  // ---- the entry popup ----
  function openGate(initial) {
    if (document.querySelector(".lead-overlay")) return;
    var overlay = el("div", "lead-overlay");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.innerHTML =
      '<div class="lead-card">' +
        '<div class="lead-banner"><img src="' + BASE + 'banner.png" alt="VicThree Defence, by Anmol Sharma"></div>' +
        '<div class="lead-body">' +
          '<div class="v3-step" data-step="choice">' +
            '<h2 class="lead-title">Welcome to VicThree Defence</h2>' +
            '<p class="v3-q">Are you a VicThree Defence course student?</p>' +
            '<div class="v3-choice">' +
              '<button type="button" class="lead-btn" data-go="signin">Yes, I am enrolled</button>' +
              '<button type="button" class="btn ghost v3-ghost" data-go="free">Not yet</button>' +
            '</div>' +
          '</div>' +

          '<div class="v3-step" data-step="signin" style="display:none">' +
            '<h2 class="lead-title">Course student sign in</h2>' +
            '<div class="v3-sub" data-sub="email">' +
              '<label class="lead-field"><span>Your course email</span><input type="email" name="s_email" autocomplete="email" placeholder="you@email.com"></label>' +
              '<p class="lead-error" data-err="s_email"></p>' +
              '<button type="button" class="lead-btn" data-act="send-code">Send me a code</button>' +
            '</div>' +
            '<div class="v3-sub" data-sub="code" style="display:none">' +
              '<label class="lead-field"><span>6-digit code</span><input type="text" name="s_code" inputmode="numeric" autocomplete="one-time-code" maxlength="6"></label>' +
              '<p class="lead-error" data-err="s_code"></p>' +
              '<button type="button" class="lead-btn" data-act="verify">Sign in</button>' +
            '</div>' +
            '<p class="lead-note"><button type="button" class="link-btn" data-go="choice">Back</button></p>' +
          '</div>' +

          '<div class="v3-step" data-step="free" style="display:none">' +
            '<h2 class="lead-title">Start practising, free</h2>' +
            '<p class="v3-sub-line">Enter your details to unlock PPDT, WAT and SRT. One of each, free, every day.</p>' +
            '<form class="lead-form" novalidate>' +
              '<label class="lead-field"><span>Name</span><input type="text" name="f_name" autocomplete="name" placeholder="Your full name" required></label>' +
              '<label class="lead-field"><span>Phone</span><input type="tel" name="f_phone" autocomplete="tel" inputmode="numeric" placeholder="10-digit mobile" required></label>' +
              '<label class="lead-field"><span>Email</span><input type="email" name="f_email" autocomplete="email" placeholder="you@email.com" required></label>' +
              '<p class="lead-error" data-err="free"></p>' +
              '<button type="submit" class="lead-btn">Start free practice</button>' +
              '<p class="lead-fine">No payment. No OTP. You can start right away.</p>' +
              '<p class="lead-micro">Free tier gives you PPDT, WAT and SRT, one attempt each per day, with a performance report each time. TAT, GPE and SDT, unlimited practice and your saved progress open up in the course.</p>' +
            '</form>' +
            '<p class="lead-note"><button type="button" class="link-btn" data-go="choice">Back</button></p>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);
    document.documentElement.classList.add("lead-open");
    var unfit = fitToViewport(overlay);
    function close() { unfit(); overlay.remove(); document.documentElement.classList.remove("lead-open"); }
    function showStep(name) {
      overlay.querySelectorAll(".v3-step").forEach(function (s) { s.style.display = (s.getAttribute("data-step") === name) ? "" : "none"; });
    }
    showStep(initial === "signin" ? "signin" : (initial === "free" ? "free" : "choice"));

    overlay.addEventListener("click", function (e) {
      var go = e.target.getAttribute && e.target.getAttribute("data-go");
      if (go) { showStep(go); if (go === "signin") { var em = overlay.querySelector('[name="s_email"]'); setTimeout(function () { try { em.focus(); } catch (x) {} }, 60); } return; }
      var act = e.target.getAttribute && e.target.getAttribute("data-act");
      if (act === "send-code") { onSendCode(overlay, e.target); return; }
      if (act === "verify") { onVerify(overlay, e.target, close); return; }
    });

    overlay.querySelector('.v3-step[data-step="free"] .lead-form')
      .addEventListener("submit", function (ev) { ev.preventDefault(); onFreeSubmit(overlay, close); });

    overlay.addEventListener("focusin", function (e) {
      setTimeout(function () { try { e.target.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (x) {} }, 260);
    });
  }

  function onSendCode(overlay, btn) {
    var email = (overlay.querySelector('[name="s_email"]').value || "").trim();
    var err = overlay.querySelector('[data-err="s_email"]');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = "Please enter a valid email to continue."; return; }
    err.textContent = ""; btn.disabled = true; btn.textContent = "Sending...";
    fetch(PORTAL + "/api/request-code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email }) })
      .then(function () {
        overlay.querySelector('[data-sub="email"]').style.display = "none";
        overlay.querySelector('[data-sub="code"]').style.display = "";
        var c = overlay.querySelector('[name="s_code"]'); setTimeout(function () { try { c.focus(); } catch (x) {} }, 60);
      }).catch(function () { err.textContent = "Something went wrong at our end. Please try again in a moment."; btn.disabled = false; btn.textContent = "Send me a code"; });
  }

  function onVerify(overlay, btn, close) {
    var email = (overlay.querySelector('[name="s_email"]').value || "").trim();
    var code = (overlay.querySelector('[name="s_code"]').value || "").trim();
    var err = overlay.querySelector('[data-err="s_code"]');
    if (code.length < 4) { err.textContent = "Enter the code from your email."; return; }
    err.textContent = ""; btn.disabled = true; btn.textContent = "Signing in...";
    fetch(PORTAL + "/api/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email, code: code }) })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.token) { lsSet(COURSE_KEY, d.token); ssbCache = null; setIdentity(d.name, email, "course"); close(); renderStrip(); }
        else { err.textContent = "That code did not work. Check it and try again."; btn.disabled = false; btn.textContent = "Sign in"; }
      }).catch(function () { err.textContent = "Something went wrong at our end. Please try again in a moment."; btn.disabled = false; btn.textContent = "Sign in"; });
  }

  function onFreeSubmit(overlay, close) {
    var name = (overlay.querySelector('[name="f_name"]').value || "").trim();
    var phone = (overlay.querySelector('[name="f_phone"]').value || "").trim();
    var email = (overlay.querySelector('[name="f_email"]').value || "").trim();
    var err = overlay.querySelector('[data-err="free"]');
    var digits = phone.replace(/\D/g, "");
    if (name.length < 2) { err.textContent = "Please enter your name."; return; }
    if (digits.length !== 10) { err.textContent = "Please enter your 10-digit mobile number."; return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = "Please enter a valid email to continue."; return; }
    err.textContent = "";
    var btn = overlay.querySelector('.v3-step[data-step="free"] .lead-btn');
    btn.disabled = true; btn.textContent = "Just a moment...";
    var data = { name: name, phone: phone, email: email };
    captureToSheet(data); // keep the Google Sheet lead record too
    freeRegister(data).then(function (res) {
      if (res.ok) {
        var step = overlay.querySelector('.v3-step[data-step="free"]');
        step.innerHTML = '<h2 class="lead-title">You\'re in, ' + esc(firstName(name)) + '.</h2><p class="v3-sub-line">Pick a test to begin.</p>';
        setTimeout(function () { close(); renderStrip(); }, 1500);
      } else if (res.error === "bad_email") {
        err.textContent = "Please enter a valid email to continue."; btn.disabled = false; btn.textContent = "Start free practice";
      } else {
        err.textContent = "Something went wrong at our end. Please try again in a moment."; btn.disabled = false; btn.textContent = "Start free practice";
      }
    });
  }

  // ---- persistent strip ----
  function renderStrip() {
    var old = document.querySelector(".v3-strip"); if (old) old.remove();
    var strip = el("div", "v3-strip");
    if (tier === "course") {
      strip.className = "v3-strip in";
      var link = PROGRESS_URL ? ' <a class="v3-link" href="' + esc(PROGRESS_URL) + '">View your progress</a>' : "";
      strip.innerHTML = '<span class="v3-msg">Signed in as ' + esc(student && (student.name || student.email)) +
        ' &middot; Course access: all tests unlocked.' + link + '</span>';
    } else if (tier === "free") {
      strip.className = "v3-strip free";
      strip.innerHTML = '<span class="v3-msg">Free tier: PPDT &middot; WAT &middot; SRT, once a day each. ' +
        '<a class="v3-link" href="' + esc(COURSE_URL) + '">See the full course &rarr;</a>' +
        ' &middot; <button type="button" class="v3-link" data-v3signin>Course student? Sign in</button></span>';
      strip.addEventListener("click", function (e) { if (e.target && e.target.hasAttribute("data-v3signin")) openGate("signin"); });
    } else {
      strip.innerHTML = '<span class="v3-msg">Course student or exploring? <button type="button" class="v3-link" data-v3open>Get started</button></span>';
      strip.addEventListener("click", function (e) { if (e.target && e.target.hasAttribute("data-v3open")) openGate("choice"); });
    }
    var header = document.querySelector("header.topbar");
    if (header && header.parentNode) header.parentNode.insertBefore(strip, header.nextSibling);
    else document.body.insertBefore(strip, document.body.firstChild);
  }

  function maybeGate() {
    if (hasToken()) return;
    try { if (sessionStorage.getItem("v3_gate_seen")) return; } catch (e) {}
    setTimeout(function () {
      if (!hasToken() && !document.querySelector(".lead-overlay")) {
        try { sessionStorage.setItem("v3_gate_seen", "1"); } catch (e) {}
        openGate("choice");
      }
    }, 5000);
  }

  var ready = validate();

  window.V3 = {
    getToken: getToken,
    hasToken: hasToken,
    getStudent: function () { return student; },
    getTier: function () { return tier; },
    isSignedIn: function () { return tier === "course"; },
    allow: allow,
    getSSB: getSSB,
    openGate: openGate,
    courseUrl: COURSE_URL,
    ready: ready
  };
})();
