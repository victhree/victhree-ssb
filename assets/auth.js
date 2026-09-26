/* VicThree SSB — course-student sign-in + tracking bridge.
   Loaded before trainer.js on every page. Recognises a course student via the
   portal Worker (shared bearer token), exposes helpers, and shows a light
   "signed in" strip. Anonymous practice is unaffected: if nothing is signed in,
   this does nothing beyond offering an unobtrusive sign-in link.

   Public API (window.V3):
     V3.getToken()   -> the stored bearer token, or ""
     V3.getStudent() -> {name,email,product} or null
     V3.isSignedIn() -> boolean
     V3.getSSB()     -> Promise of GET /api/ssb/me (cached once), or null
     V3.signIn()     -> opens the email-code sign-in flow
     V3.ready        -> Promise that resolves once the initial token is validated
*/
(function () {
  "use strict";

  var CFG = window.VICTHREE_CONFIG || {};
  var PORTAL = (CFG.portalEndpoint || "").replace(/\/+$/, "");
  var PROGRESS_URL = CFG.portalProgressUrl || "";
  var TOKKEY = "vt_portal_token";

  var student = null;   // {name,email,product}
  var ssbCache = null;  // Promise of /api/ssb/me

  function getToken() { try { return localStorage.getItem(TOKKEY) || ""; } catch (e) { return ""; } }
  function setToken(t) { try { if (t) localStorage.setItem(TOKKEY, t); else localStorage.removeItem(TOKKEY); } catch (e) {} }
  function authHeaders(extra) {
    var h = extra || {};
    var t = getToken();
    if (t) h["Authorization"] = "Bearer " + t;
    return h;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // 1) Token handoff: the portal links here with #vt=<token>. Store it, then
  //    strip it from the URL so it is not bookmarked or shared.
  (function grabHash() {
    try {
      var m = location.hash.match(/[#&]vt=([^&]+)/);
      if (m) {
        setToken(decodeURIComponent(m[1]));
        var clean = location.hash.replace(/([#&])vt=[^&]+/, "$1").replace(/^#&/, "#").replace(/^#$/, "");
        history.replaceState(null, "", location.pathname + location.search + clean);
      }
    } catch (e) {}
  })();

  // 2) Validate a stored token against the portal.
  function validate() {
    var t = getToken();
    if (!t || !PORTAL) return Promise.resolve(null);
    return fetch(PORTAL + "/api/me", { headers: authHeaders() })
      .then(function (r) {
        if (r.status === 200) return r.json();
        if (r.status === 401) setToken("");
        return null;
      })
      .then(function (d) {
        if (d && d.email) { student = d; window.V3_STUDENT = d; }
        renderStrip();
        return student;
      })
      .catch(function () { renderStrip(); return null; });
  }

  // Cached SSB picture (profile + focus_olqs). Fetched at most once per page.
  function getSSB() {
    if (!student) return Promise.resolve(null);
    if (!ssbCache) {
      ssbCache = fetch(PORTAL + "/api/ssb/me", { headers: authHeaders() })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
    }
    return ssbCache;
  }

  // 3) Fallback email-code sign-in. Reuses the popup styles (.lead-*).
  function signIn() {
    if (!PORTAL) return;
    var overlay = document.createElement("div");
    overlay.className = "lead-overlay";
    overlay.innerHTML =
      '<div class="lead-card"><div class="lead-body">' +
      '<h2 class="lead-title">Course student sign in</h2>' +
      '<form class="lead-form" novalidate>' +
      '<div class="v3-step v3-step-email">' +
        '<label class="lead-field"><span>Your course email</span>' +
        '<input type="email" name="email" autocomplete="email" required></label>' +
        '<p class="lead-error" role="alert"></p>' +
        '<button type="button" class="lead-btn" data-act="code">Send me a code</button>' +
      '</div>' +
      '<div class="v3-step v3-step-code" style="display:none">' +
        '<label class="lead-field"><span>6-digit code</span>' +
        '<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6"></label>' +
        '<p class="lead-error" role="alert"></p>' +
        '<button type="button" class="lead-btn" data-act="verify">Sign in</button>' +
      '</div>' +
      '<p class="lead-note"><button type="button" class="link-btn" data-act="cancel">Keep practising without signing in</button></p>' +
      '</form></div></div>';
    document.body.appendChild(overlay);
    document.documentElement.classList.add("lead-open");

    var stepEmail = overlay.querySelector(".v3-step-email");
    var stepCode = overlay.querySelector(".v3-step-code");
    var emailEl = overlay.querySelector('input[name="email"]');
    var codeEl = overlay.querySelector('input[name="code"]');
    var errEmail = stepEmail.querySelector(".lead-error");
    var errCode = stepCode.querySelector(".lead-error");

    function close() {
      overlay.remove();
      document.documentElement.classList.remove("lead-open");
    }

    overlay.addEventListener("click", function (e) {
      var act = e.target && e.target.getAttribute && e.target.getAttribute("data-act");
      if (!act) return;

      if (act === "cancel") { close(); return; }

      if (act === "code") {
        var email = (emailEl.value || "").trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errEmail.textContent = "Please enter a valid email."; return; }
        errEmail.textContent = "";
        e.target.disabled = true; e.target.textContent = "Sending...";
        fetch(PORTAL + "/api/request-code", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email })
        }).then(function () {
          stepEmail.style.display = "none";
          stepCode.style.display = "";
          try { codeEl.focus(); } catch (x) {}
        }).catch(function () {
          errEmail.textContent = "Could not send the code. Try again.";
          e.target.disabled = false; e.target.textContent = "Send me a code";
        });
      }

      if (act === "verify") {
        var email2 = (emailEl.value || "").trim();
        var code = (codeEl.value || "").trim();
        if (code.length < 4) { errCode.textContent = "Enter the code from your email."; return; }
        errCode.textContent = "";
        e.target.disabled = true; e.target.textContent = "Signing in...";
        fetch(PORTAL + "/api/verify", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email2, code: code })
        }).then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) {
            if (d && d.token) {
              setToken(d.token);
              student = { name: d.name, email: email2, product: d.product };
              window.V3_STUDENT = student;
              ssbCache = null;
              close();
              renderStrip();
            } else {
              errCode.textContent = "That code did not work. Check it and try again.";
              e.target.disabled = false; e.target.textContent = "Sign in";
            }
          }).catch(function () {
            errCode.textContent = "Could not sign you in right now. Try again.";
            e.target.disabled = false; e.target.textContent = "Sign in";
          });
      }
    });
  }

  // 5) Light strip: "Signed in as X" when signed in, else an unobtrusive
  //    sign-in link. Never any AI wording.
  function renderStrip() {
    var existing = document.querySelector(".v3-strip");
    if (existing) existing.remove();

    var strip = document.createElement("div");
    strip.className = "v3-strip" + (student ? " in" : "");
    if (student) {
      var link = PROGRESS_URL ? ' <a class="v3-link" href="' + esc(PROGRESS_URL) + '">View your progress</a>' : "";
      strip.innerHTML = '<span class="v3-msg">Signed in as ' + esc(student.name || student.email) +
        '. Your performance is being tracked.' + link + '</span>';
    } else {
      strip.innerHTML = '<span class="v3-msg">Course student? <button type="button" class="v3-link" data-v3signin>Sign in</button></span>';
      strip.addEventListener("click", function (e) {
        if (e.target && e.target.hasAttribute("data-v3signin")) signIn();
      });
    }

    var header = document.querySelector("header.topbar");
    if (header && header.parentNode) header.parentNode.insertBefore(strip, header.nextSibling);
    else document.body.insertBefore(strip, document.body.firstChild);
  }

  var ready = validate();

  window.V3 = {
    getToken: getToken,
    getStudent: function () { return student; },
    isSignedIn: function () { return !!student; },
    getSSB: getSSB,
    signIn: signIn,
    ready: ready
  };
})();
