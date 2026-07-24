/* VicThree SSB — shared trainer engine (WAT & SRT).
   Each practice page sets window.TRAINER before this script loads:
     window.TRAINER = {
       mode: "WAT" | "SRT",
       seconds: 15,                // per-item time
       items: [...],               // from data/*-practice.js
       checklist: ["...", "..."]   // self-audit questions
     }
   Performance analysis is optional and controlled by window.VICTHREE_CONFIG.aiEndpoint (config.js). */
(function () {
  "use strict";
  var CFG = window.TRAINER || {};
  var AI = (window.VICTHREE_CONFIG && window.VICTHREE_CONFIG.aiEndpoint) || "";
  var STORE_KEY = "v3ssb_" + (CFG.mode || "x").toLowerCase();

  var NEGATIVE = ["fear","afraid","scared","cannot","can't","cant","never","impossible","quit","give up","gave up",
    "hopeless","useless","worthless","fail","failed","failure","sad","cry","cried","depressed","weak","coward","hate",
    "hated","angry","panic","panicked","worried","tension","nervous","alone","lonely","defeat","defeated","lose","loser",
    "run away","ran away","helpless","doomed","waste","pointless"];
  var VIOLENT = ["kill","killed","murder","stab","shoot","destroy","revenge","beat him","beat them","hit him","hit them",
    "slap","punch","bomb","curse"];

  var S = { items: [], idx: 0, responses: [], remaining: 0, startTs: 0, tick: null, analysis: null };

  function $(id){ return document.getElementById(id); }
  function el(t,c,x){ var e=document.createElement(t); if(c)e.className=c; if(x!=null)e.textContent=x; return e; }
  function panel(id){ ["t-intro","t-run","t-results"].forEach(function(p){ $(p).classList.toggle("active", p===id); }); window.scrollTo(0,0); }
  function promptOf(it){ return it.word!=null ? it.word : it.situation; }
  function tagOf(it){ return it.tag || it.type || ""; }
  function shuffle(a){ a=a.slice(); for(var i=a.length-1;i>0;i--){ var j=Math.floor(Math.random()*(i+1)); var t=a[i];a[i]=a[j];a[j]=t;} return a; }

  /* ---------- run ---------- */
  function start(){
    var pool = CFG.items || [];
    var chosen = shuffle(pool);
    var sel = $("t-count");
    var n = sel ? parseInt(sel.value, 10) : 0;
    if (n > 0 && n < chosen.length) chosen = chosen.slice(0, n);
    S.items = chosen;
    S.idx = 0; S.responses = []; S.analysis = null;
    panel("t-run");
    render();
  }

  function render(){
    var it = S.items[S.idx];
    $("t-kind").textContent = CFG.mode==="WAT" ? "Word" : "Situation";
    var pt = $("t-prompt");
    pt.className = CFG.mode==="WAT" ? "t-word" : "t-sit";
    pt.textContent = promptOf(it);
    $("t-counter").textContent = (S.idx+1)+" / "+S.items.length;
    $("t-progress").firstElementChild.style.width = (S.idx/S.items.length*100)+"%";
    var inp = $("t-input"); inp.value=""; inp.focus();
    S.remaining = CFG.seconds; S.startTs = performance.now();
    drawTimer();
    clearInterval(S.tick); S.tick = setInterval(onTick, 1000);
  }
  function drawTimer(){ var t=$("t-timer"); t.textContent=S.remaining; t.classList.toggle("low", S.remaining<=5); }
  function onTick(){ S.remaining--; drawTimer(); if(S.remaining<=0){ clearInterval(S.tick); commit(); } }

  function commit(){
    clearInterval(S.tick);
    var used = Math.min(CFG.seconds, Math.round((performance.now()-S.startTs)/1000));
    S.responses.push({ item: S.items[S.idx], text: $("t-input").value.trim(), seconds: used });
    S.idx++;
    if(S.idx>=S.items.length) finish(); else render();
  }
  function skip(){ $("t-input").value=""; commit(); }

  /* ---------- heuristics ---------- */
  function analyse(text){
    var f=[]; if(!text){ f.push({t:"Blank — no response"}); return f; }
    var low=" "+text.toLowerCase()+" ";
    var words=text.split(/\s+/).filter(Boolean);
    if(CFG.mode==="WAT" && words.length<3) f.push({t:"Very short"});
    if(CFG.mode==="SRT" && words.length<4) f.push({t:"Very short"});
    var v=VIOLENT.filter(function(w){return low.indexOf(w)!==-1;});
    var n=NEGATIVE.filter(function(w){return low.indexOf(w)!==-1;});
    if(v.length) f.push({t:"Aggressive/violent tone: "+v.join(", ")});
    if(n.length) f.push({t:"Negative/defeatist words: "+n.slice(0,4).join(", ")});
    return f;
  }
  function timeFlag(r){ if(!r.text) return null; if(r.seconds>=CFG.seconds) return "Ran out of time"; if(CFG.mode==="WAT"&&r.seconds>CFG.seconds*0.8) return "Slow ("+r.seconds+"s)"; return null; }
  function fmt(s){ var m=Math.floor(s/60), x=s%60; return m?(m+"m "+x+"s"):(x+"s"); }

  /* ---------- finish + results ---------- */
  function finish(){
    clearInterval(S.tick);
    $("t-progress").firstElementChild.style.width="100%";
    save();
    buildResults();
    panel("t-results");
    if(AI) requestAI();
  }

  function buildResults(){
    var R=S.responses;
    var attempted=R.filter(function(r){return r.text.length>0;}).length;
    var blanks=R.length-attempted;
    var total=R.reduce(function(s,r){return s+r.seconds;},0);
    var avg=R.length?total/R.length:0;

    var st=$("t-stats"); st.innerHTML="";
    [["Attempted",attempted+" / "+R.length],["Left blank",blanks],["Avg time",avg.toFixed(1)+"s"],["Total",fmt(total)]]
      .forEach(function(p){ var c=el("div","t-stat"); c.appendChild(el("div","n",String(p[1]))); c.appendChild(el("div","l",p[0])); st.appendChild(c); });

    // self-audit checklist
    var cl=$("t-checklist-items"); cl.innerHTML="";
    (CFG.checklist||[]).forEach(function(q){
      var lab=el("label"); var cb=document.createElement("input"); cb.type="checkbox";
      lab.appendChild(cb); lab.appendChild(document.createTextNode(" "+q)); cl.appendChild(lab);
    });
  }

  /* ---------- Performance analysis (via Worker) ---------- */
  function requestAI(){
    var box=$("t-ai"); box.style.display="block";
    var status=$("ai-status");
    status.innerHTML='<span class="spinner"></span>Analysing your responses… this may take a few moments.';
    $("ai-body").innerHTML="";
    var payload={ mode:CFG.mode, items:S.responses.map(function(r,i){ return { n:i+1, prompt:promptOf(r.item), tag:tagOf(r.item), response:r.text, seconds:r.seconds }; }) };
    fetch(AI, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload) })
      .then(function(res){ if(!res.ok) throw new Error("HTTP "+res.status); return res.json(); })
      .then(renderAI)
      .catch(function(err){ status.textContent="Your performance analysis isn't available right now. Your self-review below still works."; });
  }
  function renderAI(data){
    $("ai-status").textContent="";
    var body=$("ai-body"); body.innerHTML="";
    S.analysis = (data && typeof data === "object") ? data : null;
    if(typeof data==="string"){ body.appendChild(el("p",null,data)); return; }
    if(data.summary){ var c1=el("div","ai-card snapshot"); c1.appendChild(el("h4",null,"Personality snapshot")); c1.appendChild(el("p",null,data.summary)); body.appendChild(c1); }
    var reflected = data.olqs_reflected || data.strengths;
    if(reflected&&reflected.length){ var c2=el("div","ai-card reflected"); c2.appendChild(el("h4",null,"Officer-Like Qualities reflected")); var u=el("ul"); reflected.forEach(function(s){u.appendChild(el("li",null,s));}); c2.appendChild(u); body.appendChild(c2); }
    var work = data.olqs_to_work_on || data.improve;
    if(work&&work.length){ var c3=el("div","ai-card work"); c3.appendChild(el("h4",null,"OLQs to work on")); var u2=el("ul"); work.forEach(function(s){u2.appendChild(el("li",null,s));}); c3.appendChild(u2); body.appendChild(c3); }
    if(data.items&&data.items.length){
      data.items.forEach(function(it){
        var d=el("div","ai-item");
        d.appendChild(el("div","qn","#"+(it.n||"")+"  "+(it.prompt||"")));
        var resp=(S.responses[(it.n||0)-1]||{}).text;
        var yr=el("p","ai-your"); yr.appendChild(el("strong",null,"Your response: ")); yr.appendChild(document.createTextNode(resp||"(left blank)")); d.appendChild(yr);
        if(it.comment) d.appendChild(el("p",null,it.comment));
        if(it.suggestion){ var s=el("p"); s.appendChild(el("strong",null,"Better alternative: ")); var span=el("span","sugg",it.suggestion); s.appendChild(span); d.appendChild(s); }
        body.appendChild(d);
      });
    }
    if(!body.childNodes.length) body.appendChild(el("p",null,"(No analysis returned.)"));
  }

  /* ---------- copy responses (helper) ---------- */
  function copyText(){
    var lines=[];
    lines.push("You are an experienced SSB (Services Selection Board) psychologist.");
    lines.push("Analyse my "+CFG.mode+" responses for Officer-Like Qualities (OLQs).");
    lines.push("For each item, comment on positivity, practicality/realism and the OLQs shown, and give one sharper response. End with an overall summary of my strengths and the 2-3 things to work on.");
    lines.push(""); lines.push("=== My "+CFG.mode+" responses ===");
    S.responses.forEach(function(r,i){
      var label=CFG.mode==="WAT" ? ("Word: "+promptOf(r.item)) : ("Situation: "+promptOf(r.item));
      lines.push((i+1)+". "+label+(tagOf(r.item)?"  ["+tagOf(r.item)+"]":""));
      lines.push("   My response ("+r.seconds+"s): "+(r.text||"[left blank]"));
    });
    var text=lines.join("\n");
    var done=function(){ var n=$("t-copynote"); n.style.display="block"; setTimeout(function(){n.style.display="none";},4000); };
    if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done,function(){fallback(text);done();});
    else { fallback(text); done(); }
  }
  function fallback(text){ var ta=document.createElement("textarea"); ta.value=text; document.body.appendChild(ta); ta.select(); try{document.execCommand("copy");}catch(e){} document.body.removeChild(ta); }

  /* ---------- localStorage ---------- */
  function save(){
    try{ localStorage.setItem(STORE_KEY, JSON.stringify({ when:new Date().toISOString(), responses:S.responses.map(function(r){return {prompt:promptOf(r.item),tag:tagOf(r.item),text:r.text,seconds:r.seconds};}) })); }catch(e){}
  }
  function hasSaved(){ try{ return !!localStorage.getItem(STORE_KEY); }catch(e){ return false; } }
  function loadSaved(){
    try{
      var d=JSON.parse(localStorage.getItem(STORE_KEY)); if(!d) return;
      S.responses=d.responses.map(function(x){ return { item: (CFG.mode==="WAT"?{word:x.prompt,type:x.tag}:{situation:x.prompt,tag:x.tag}), text:x.text, seconds:x.seconds }; });
      buildResults(); panel("t-results");
    }catch(e){}
  }

  /* ---------- download report ---------- */
  function esc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
  function downloadReport(){
    var img=document.querySelector(".brand-img");
    if(img && img.src){
      fetch(img.src).then(function(r){return r.blob();}).then(function(b){
        var fr=new FileReader();
        fr.onload=function(){ buildReport(fr.result); };
        fr.onerror=function(){ buildReport(""); };
        fr.readAsDataURL(b);
      }).catch(function(){ buildReport(""); });
    } else { buildReport(""); }
  }
  function buildReport(banner){
    var R=S.responses, A=S.analysis, mode=CFG.mode;
    var testName = mode==="SRT" ? "Situation Reaction Test (SRT)" : "Word Association Test (WAT)";
    var when = new Date().toLocaleString();
    var attempted = R.filter(function(r){return r.text.length>0;}).length;
    var p=[];
    p.push('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">');
    p.push('<title>VicThree SSB — '+mode+' Performance Report</title>');
    p.push('<style>body{font-family:Georgia,serif;color:#1c2331;max-width:820px;margin:26px auto;padding:0 22px;line-height:1.6}h1{color:#0f2340;margin:0}h2{color:#0f2340;margin-top:1.5em}h4{margin:0 0 .4em}.banner{background:#0f2340;text-align:center;padding:12px 16px;border-radius:10px;margin:0 0 22px}.banner img{max-width:520px;width:100%;height:auto;display:block;margin:0 auto}.meta{color:#4a5265;font-family:Arial,sans-serif;font-size:14px;margin:.3em 0 1.2em}.stat{font-family:Arial,sans-serif}.card{border:1px solid #e2ddcd;border-radius:10px;padding:14px 18px;margin:14px 0}.snapshot{background:#eef2f8}.snapshot h4{color:#0f2340}.reflected{background:#eef4ec}.reflected h4{color:#3f6b3a}.work{background:#f8f2e2}.work h4{color:#8a6d1e}.card ul{margin:.3em 0 0;padding-left:20px}.item{border-top:1px solid #eee;padding-top:10px;margin-top:12px}.qn{font-family:Arial,sans-serif;font-weight:700;color:#0f2340}.your{color:#4a5265}.sugg{color:#3f6b3a}.note{color:#4a5265;font-family:Arial,sans-serif;font-size:13px;border-top:1px solid #e2ddcd;margin-top:26px;padding-top:12px}</style>');
    p.push('</head><body>');
    if(banner) p.push('<div class="banner"><img src="'+banner+'" alt="VicThree Defence"></div>');
    p.push('<h1>Performance Report</h1>');
    p.push('<p class="meta">'+testName+' &middot; '+esc(when)+'</p>');
    p.push('<p class="stat">Attempted '+attempted+' of '+R.length+'.</p>');
    if(A){
      if(A.summary){ p.push('<div class="card snapshot"><h4>Personality snapshot</h4><p>'+esc(A.summary)+'</p></div>'); }
      var refl=A.olqs_reflected||A.strengths;
      if(refl&&refl.length){ p.push('<div class="card reflected"><h4>Officer-Like Qualities reflected</h4><ul>'+refl.map(function(s){return '<li>'+esc(s)+'</li>';}).join('')+'</ul></div>'); }
      var work=A.olqs_to_work_on||A.improve;
      if(work&&work.length){ p.push('<div class="card work"><h4>OLQs to work on</h4><ul>'+work.map(function(s){return '<li>'+esc(s)+'</li>';}).join('')+'</ul></div>'); }
    }
    p.push('<h2>Response-by-response</h2>');
    R.forEach(function(r,i){
      var it = (A && A.items) ? A.items.filter(function(x){return x.n===(i+1);})[0] : null;
      p.push('<div class="item"><div class="qn">#'+(i+1)+'&nbsp; '+esc(promptOf(r.item))+'</div>');
      p.push('<p class="your"><b>Your response:</b> '+esc(r.text||"(left blank)")+'</p>');
      if(it && it.comment) p.push('<p>'+esc(it.comment)+'</p>');
      if(it && it.suggestion) p.push('<p><b>Better alternative:</b> <span class="sugg">'+esc(it.suggestion)+'</span></p>');
      p.push('</div>');
    });
    p.push('<p class="note">There are no official correct answers in the SSB psychology tests. This report is guidance to help improve your performance, not a verdict.</p>');
    p.push('</body></html>');
    var blob=new Blob([p.join("")], {type:"text/html"});
    var url=URL.createObjectURL(blob);
    var a=document.createElement("a");
    a.href=url; a.download="VicThree-SSB-"+mode+"-Report.html";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1500);
  }

  /* ---------- wire ---------- */
  document.addEventListener("DOMContentLoaded", function(){
    $("t-start").addEventListener("click", start);
    $("t-next").addEventListener("click", commit);
    $("t-skip").addEventListener("click", skip);
    $("t-quit").addEventListener("click", function(){ clearInterval(S.tick); panel("t-intro"); });
    $("t-restart").addEventListener("click", function(){ panel("t-intro"); });
    var dlBtn=$("t-download"); if(dlBtn) dlBtn.addEventListener("click", downloadReport);
    var copyBtn=$("t-copy"); if(copyBtn) copyBtn.addEventListener("click", copyText);
    $("t-input").addEventListener("keydown", function(e){ if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); commit(); } });
    if(hasSaved()){ var link=$("t-resume"); link.style.display="inline-block"; link.addEventListener("click", function(e){ e.preventDefault(); loadSaved(); }); }
    if(!AI){ var hint=$("ai-off-hint"); if(hint) hint.style.display="block"; }
  });
})();
