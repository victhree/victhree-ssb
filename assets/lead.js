/* VicThree Defence — welcome popup / lead capture.
   Shows a one-time gate asking for name, phone and email, then posts the
   details to a Google Sheet (via an Apps Script Web App set in config.js).
   Once submitted, it never shows again for that visitor (localStorage). */
(function () {
  "use strict";

  var KEY = "v3_lead_done";
  var CFG = window.VICTHREE_CONFIG || {};
  var ENDPOINT = CFG.sheetEndpoint || "";

  // Already captured this visitor? Do nothing.
  try { if (localStorage.getItem(KEY)) return; } catch (e) {}

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
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
        }, 260);
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", show);
  } else {
    show();
  }
})();
