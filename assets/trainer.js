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

  /* ---------- download report (direct PDF via jsPDF, no print dialog) ---------- */
  function downloadReport(){
    var img=document.querySelector(".brand-img");
    if(img && img.src){
      fetch(img.src).then(function(r){return r.blob();}).then(function(b){
        var fr=new FileReader();
        fr.onload=function(){ buildPdf(fr.result, img.naturalWidth||0, img.naturalHeight||0); };
        fr.onerror=function(){ buildPdf(null,0,0); };
        fr.readAsDataURL(b);
      }).catch(function(){ buildPdf(null,0,0); });
    } else { buildPdf(null,0,0); }
  }
  function buildPdf(banner, bw, bh){
    var JS = window.jspdf && window.jspdf.jsPDF;
    if(!JS){ alert("The PDF tool didn't finish loading. Please reconnect and tap Download PDF again."); return; }
    var R=S.responses, A=S.analysis, mode=CFG.mode;
    var testName = mode==="SRT" ? "Situation Reaction Test (SRT)" : "Word Association Test (WAT)";
    var when = new Date().toLocaleString();
    var attempted = R.filter(function(r){return r.text.length>0;}).length;

    var doc=new JS({unit:"pt", format:"a4"});
    var PW=doc.internal.pageSize.getWidth(), PH=doc.internal.pageSize.getHeight();
    var M=42, x=M, y=M, cw=PW-2*M;
    var navy=[15,35,64], ink=[28,35,49], soft=[74,82,101], green=[63,107,58], gold2=[138,109,30];

    function br(h){ if(y+h > PH-M){ doc.addPage(); y=M; } }
    // wrapped text with per-line page breaks; advances y
    function text(str, o){
      o=o||{};
      var size=o.size||11, lh=o.lh||Math.round(size*1.4), col=o.color||ink, font=o.font||"times", style=o.style||"normal";
      var maxw=(o.maxw!=null?o.maxw:cw), xx=(o.x!=null?o.x:x);
      doc.setFont(font,style); doc.setFontSize(size); doc.setTextColor(col[0],col[1],col[2]);
      var arr=doc.splitTextToSize(String(str), maxw);
      for(var i=0;i<arr.length;i++){ br(lh); doc.text(arr[i], xx, y+size*0.9); y+=lh; }
      if(o.gap) y+=o.gap;
    }
    // coloured card: title + optional paragraph + optional bullet list
    function card(bg, headCol, title, bodyStr, bullets){
      var pad=13, iw=cw-2*pad, lhT=14, lhB=15.4;
      doc.setFont("helvetica","bold"); doc.setFontSize(10.5);
      var tl=doc.splitTextToSize(title, iw);
      doc.setFont("times","normal"); doc.setFontSize(11);
      var bl = bodyStr ? doc.splitTextToSize(bodyStr, iw) : [];
      var bu=[]; if(bullets){ bullets.forEach(function(s){ bu=bu.concat(doc.splitTextToSize("•  "+s, iw)); }); }
      var h = pad + tl.length*lhT + 5 + (bl.length+bu.length)*lhB + pad;
      if(y+h > PH-M){ doc.addPage(); y=M; }
      doc.setFillColor(bg[0],bg[1],bg[2]); doc.roundedRect(x,y,cw,h,7,7,"F");
      var cy=y+pad;
      doc.setFont("helvetica","bold"); doc.setFontSize(10.5); doc.setTextColor(headCol[0],headCol[1],headCol[2]);
      tl.forEach(function(t){ doc.text(t, x+pad, cy+9); cy+=lhT; });
      cy+=5;
      doc.setFont("times","normal"); doc.setFontSize(11); doc.setTextColor(ink[0],ink[1],ink[2]);
      bl.forEach(function(t){ doc.text(t, x+pad, cy+9); cy+=lhB; });
      bu.forEach(function(t){ doc.text(t, x+pad, cy+9); cy+=lhB; });
      y += h + 13;
    }

    // Banner on a navy bar
    if(banner && bw>0 && bh>0){
      var bpad=14, iw=cw-2*bpad, ih=iw*(bh/bw), rectH=ih+2*bpad;
      br(rectH+8);
      doc.setFillColor(navy[0],navy[1],navy[2]); doc.roundedRect(x,y,cw,rectH,8,8,"F");
      try{ doc.addImage(banner,"PNG", x+bpad, y+bpad, iw, ih); }catch(e){}
      y += rectH + 16;
    }
    // Title, meta, stat
    text("Performance Report", {font:"times", style:"bold", size:22, color:navy, lh:26});
    text(testName+"   ·   "+when, {font:"helvetica", style:"normal", size:9.5, color:soft, lh:14, gap:4});
    text("Attempted "+attempted+" of "+R.length+".", {font:"times", style:"normal", size:11.5, color:ink, gap:10});

    // Analysis cards
    if(A){
      if(A.summary) card([238,242,248], navy, "Personality snapshot", A.summary, null);
      var refl=A.olqs_reflected||A.strengths;
      if(refl&&refl.length) card([238,244,236], green, "Officer-Like Qualities reflected", null, refl);
      var work=A.olqs_to_work_on||A.improve;
      if(work&&work.length) card([248,242,226], gold2, "OLQs to work on", null, work);
    }

    // Response-by-response
    y+=4;
    text("Response-by-response", {font:"times", style:"bold", size:15, color:navy, lh:20, gap:2});
    R.forEach(function(r,i){
      var it=(A&&A.items)?A.items.filter(function(z){return z.n===(i+1);})[0]:null;
      br(30);
      y+=5; doc.setDrawColor(228,225,214); doc.setLineWidth(0.6); doc.line(x,y,x+cw,y); y+=9;
      text("#"+(i+1)+"   "+promptOf(r.item), {font:"helvetica", style:"bold", size:10.5, color:navy, lh:14});
      text("Your response: "+(r.text||"(left blank)"), {font:"times", style:"normal", size:11, color:soft});
      if(it&&it.comment) text(it.comment, {font:"times", style:"normal", size:11, color:ink});
      if(it&&it.suggestion) text("Better alternative: "+it.suggestion, {font:"times", style:"italic", size:11, color:green});
      y+=3;
    });

    // Footer note
    y+=8; br(30);
    text("There are no official correct answers in the SSB psychology tests. This report is guidance to help improve your performance, not a verdict.", {font:"helvetica", style:"normal", size:9, color:soft, lh:13});

    doc.save("VicThree-SSB-"+mode+"-Report.pdf");
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
    // Keep the timer/progress header aligned to the top of the visible area
    // when the on-screen keyboard opens (safety net for browsers that pin
    // sticky elements to the layout viewport rather than the visual one).
    if(window.visualViewport){
      var vv=window.visualViewport;
      var pin=function(){ var h=$("t-head-el")||document.querySelector("#t-run .t-head"); if(h) h.style.top=Math.max(0, vv.offsetTop)+"px"; };
      vv.addEventListener("resize", pin);
      vv.addEventListener("scroll", pin);
    }
  });
})();
