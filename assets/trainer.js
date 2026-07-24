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

  var S = { items: [], idx: 0, responses: [], remaining: 0, startTs: 0, tick: null };

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
    S.idx = 0; S.responses = [];
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

    // heuristics (collapsible)
    var neg=0,vio=0,shrt=0,slow=0;
    R.forEach(function(r){ analyse(r.text).forEach(function(f){ if(f.t.indexOf("Negative")===0)neg++; if(f.t.indexOf("Aggressive")===0)vio++; if(f.t.indexOf("Very short")===0)shrt++; }); if(timeFlag(r))slow++; });
    var ul=$("heur-list"); ul.innerHTML="";
    function li(x){ ul.appendChild(el("li",null,x)); }
    if(blanks===0) li("You attempted every item — not leaving blanks is a strong signal."); else li(blanks+" left blank. Aim for zero — attempting all shows quick thinking.");
    if(vio) li(vio+" response(s) had an aggressive/violent tone — prefer lawful, constructive reactions.");
    if(neg) li(neg+" response(s) used negative/defeatist words — reframe towards positive, solution-focused lines."); else if(attempted) li("No obviously negative wording detected.");
    if(shrt) li(shrt+" response(s) were very short — a complete short sentence beats a fragment.");
    if(slow) li(slow+" response(s) used most/all of the time — practise reacting faster."); else if(attempted) li("Good pace overall.");

    // self-review list
    var rev=$("t-review"); rev.innerHTML="";
    R.forEach(function(r,i){
      var card=el("div","t-rev");
      var p=el("p","p"); p.appendChild(el("span","i","#"+(i+1)));
      p.appendChild(document.createTextNode(promptOf(r.item)));
      var tg=tagOf(r.item); if(tg){ var b=el("span","tag "+tg.toLowerCase()); b.textContent=tg; b.style.marginLeft="8px"; p.appendChild(b); }
      card.appendChild(p);
      var a=el("p","ans"+(r.text?"":" blank"), r.text||"(left blank) · "+r.seconds+"s");
      if(r.text) a.textContent=r.text;
      card.appendChild(a);
      var flags=analyse(r.text), tf=timeFlag(r);
      if(flags.length||tf){ var ch=el("div","chips"); flags.forEach(function(f){ ch.appendChild(el("span","chip",f.t)); }); if(tf) ch.appendChild(el("span","chip time",tf)); card.appendChild(ch); }
      rev.appendChild(card);
    });

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
    if(typeof data==="string"){ body.appendChild(el("p",null,data)); return; }
    if(data.summary){ body.appendChild(el("p",null,data.summary)); }
    if(data.strengths&&data.strengths.length){ body.appendChild(el("h4",null,"Strengths")); var u=el("ul"); data.strengths.forEach(function(s){u.appendChild(el("li",null,s));}); body.appendChild(u); }
    if(data.improve&&data.improve.length){ body.appendChild(el("h4",null,"Work on")); var u2=el("ul"); data.improve.forEach(function(s){u2.appendChild(el("li",null,s));}); body.appendChild(u2); }
    if(data.items&&data.items.length){
      data.items.forEach(function(it){
        var d=el("div","ai-item");
        d.appendChild(el("div","qn","#"+(it.n||"")+"  "+(it.prompt||"")));
        if(it.comment) d.appendChild(el("p",null,it.comment));
        if(it.suggestion){ var s=el("p"); s.appendChild(el("strong",null,"Sharper: ")); var span=el("span","sugg",it.suggestion); s.appendChild(span); d.appendChild(s); }
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

  /* ---------- wire ---------- */
  document.addEventListener("DOMContentLoaded", function(){
    $("t-start").addEventListener("click", start);
    $("t-next").addEventListener("click", commit);
    $("t-skip").addEventListener("click", skip);
    $("t-quit").addEventListener("click", function(){ clearInterval(S.tick); panel("t-intro"); });
    $("t-restart").addEventListener("click", function(){ panel("t-intro"); });
    var copyBtn=$("t-copy"); if(copyBtn) copyBtn.addEventListener("click", copyText);
    $("t-input").addEventListener("keydown", function(e){ if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); commit(); } });
    if(hasSaved()){ var link=$("t-resume"); link.style.display="inline-block"; link.addEventListener("click", function(e){ e.preventDefault(); loadSaved(); }); }
    if(!AI){ var hint=$("ai-off-hint"); if(hint) hint.style.display="block"; }
  });
})();
