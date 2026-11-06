/* DB Board Designer website: sign in / register, saving boards to the account,
   and reading board photos through the "read-board" server function. */
(function(){
"use strict";
const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const cfg=window.DBB_CONFIG||{};
const configured=/^https:\/\//.test(cfg.SUPABASE_URL||"")&&(cfg.SUPABASE_ANON_KEY||"").length>20;
const here=location.origin+location.pathname;

/* ---------- sign-in screen ---------- */
const gate=document.createElement("div");
gate.className="gate"; gate.id="gate";
document.body.appendChild(gate);
let mode="signin";
function gateHtml(inner){gate.innerHTML=`<div class="gate-card"><h1>DB Board <span style="color:var(--live)">Designer</span></h1>${inner}</div>`}
function gateMsg(t,err){const m=$("gateMsg"); if(m){m.textContent=t; m.className="gate-msg"+(err?" err":"")}}
function showGate(){
  gate.hidden=false;
  if(!configured){
    gateHtml(`<p>This website isn't connected to its account service yet.</p><p class="hint">The owner still needs to add the Supabase details to <code>app/config.js</code>.</p>`);
    return;
  }
  const reg=mode==="register";
  gateHtml(`
    <p class="sub">${reg?"Create a free account to draw, save and report on DB boards.":"Sign in to draw, save and report on DB boards."}</p>
    <div class="seg" role="group" aria-label="Sign in or register">
      <button type="button" id="tabIn" aria-pressed="${!reg}">Sign in</button>
      <button type="button" id="tabReg" aria-pressed="${reg}">Register</button>
    </div>
    <form id="authForm" novalidate>
      <label>Email<input type="email" id="authEmail" autocomplete="email" required></label>
      <label>Password<input type="password" id="authPass" autocomplete="${reg?"new-password":"current-password"}" minlength="8" required></label>
      ${reg?`<label class="agree"><input type="checkbox" id="authAgree"> <span>I agree to the <a href="privacy.html" target="_blank" rel="noopener">privacy notice</a>, including that my boards and photos are stored to provide this service.</span></label>`:""}
      <button type="submit" class="btn" id="authGo">${reg?"Create account":"Sign in"}</button>
    </form>
    ${reg?"":`<button type="button" class="linkbtn" id="forgot">Forgot your password?</button>`}
    <p class="gate-msg" id="gateMsg" aria-live="polite"></p>`);
  $("tabIn").onclick=()=>{mode="signin"; showGate()};
  $("tabReg").onclick=()=>{mode="register"; showGate()};
  if($("forgot")) $("forgot").onclick=forgot;
  $("authForm").onsubmit=submitAuth;
}
function showRecovery(){
  gate.hidden=false;
  gateHtml(`<p class="sub">Choose a new password.</p>
    <form id="newPassForm" novalidate>
      <label>New password<input type="password" id="newPass" autocomplete="new-password" minlength="8" required></label>
      <button type="submit" class="btn">Save new password</button>
    </form>
    <p class="gate-msg" id="gateMsg" aria-live="polite"></p>`);
  $("newPassForm").onsubmit=async e=>{
    e.preventDefault();
    const p=$("newPass").value;
    if(p.length<8){gateMsg("Use at least 8 characters.",true); return}
    const {error}=await sb.auth.updateUser({password:p});
    if(error) gateMsg(error.message,true);
    else {gateMsg("Password saved."); setTimeout(()=>{gate.hidden=true},800)}
  };
}
async function submitAuth(e){
  e.preventDefault();
  const email=$("authEmail").value.trim(), pass=$("authPass").value;
  if(!/^\S+@\S+\.\S+$/.test(email)){gateMsg("Enter a valid email address.",true); return}
  if(pass.length<8){gateMsg("The password must be at least 8 characters.",true); return}
  $("authGo").disabled=true;
  try{
    if(mode==="register"){
      if(!$("authAgree").checked){gateMsg("Please agree to the privacy notice first.",true); return}
      const {data,error}=await sb.auth.signUp({email,password:pass,options:{emailRedirectTo:here}});
      if(error) gateMsg(error.message,true);
      else if(!data.session){mode="signin"; showGate(); gateMsg("Check your email and click the link to confirm your account, then sign in.")}
    }else{
      const {error}=await sb.auth.signInWithPassword({email,password:pass});
      if(error) gateMsg(/confirm/i.test(error.message)?"Please confirm your email first. Check your inbox for the link.":"That email and password don't match.",true);
    }
  }finally{ if($("authGo")) $("authGo").disabled=false }
}
async function forgot(){
  const email=$("authEmail").value.trim();
  if(!/^\S+@\S+\.\S+$/.test(email)){gateMsg("Type your email address above first.",true); return}
  const {error}=await sb.auth.resetPasswordForEmail(email,{redirectTo:here});
  gateMsg(error?error.message:"If that email has an account, we've sent a link to reset the password.",!!error);
}

/* ---------- account bar ---------- */
const bar=document.createElement("div");
bar.className="acct"; bar.hidden=true;
bar.innerHTML=`<span class="who" id="who"></span>
  <span class="status" id="saveStatus" aria-live="polite"></span>
  <button type="button" class="btn ghost" id="myBoards">My boards</button>
  <button type="button" class="btn ghost" id="newBoardBtn">New board</button>
  <button type="button" class="btn ghost" id="signOut">Sign out</button>`;
const header=document.querySelector(".wrap header");
header.insertAdjacentElement("afterend",bar);
const status=t=>{$("saveStatus").textContent=t};

/* ---------- my boards ---------- */
const ov=document.createElement("div");
ov.className="overlay"; ov.hidden=true;
ov.innerHTML=`<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="bTitle" style="width:min(640px,100%)">
  <p id="bTitle"><strong>My boards</strong></p>
  <div class="boards-list" id="boardsList"></div>
  <div class="toolbar"><button type="button" class="btn" id="closeBoards">Close</button></div></div>`;
document.body.appendChild(ov);
let delConfirm=null;
async function openBoards(){
  ov.hidden=false; $("boardsList").innerHTML=`<p class="hint">Loading…</p>`;
  await flush();
  const {data,error}=await sb.from("boards").select("id,name,updated_at").order("updated_at",{ascending:false});
  if(error){$("boardsList").innerHTML=`<p class="hint">Your boards couldn't be loaded. Check your internet connection.</p>`; return}
  if(!data.length){$("boardsList").innerHTML=`<p class="hint">No saved boards yet.</p>`; return}
  $("boardsList").innerHTML=data.map(b=>`<div class="board-row${b.id===currentId?" current":""}" data-id="${b.id}">
    <span class="bn"><strong>${esc(b.name||"Board")}</strong><span>${b.id===currentId?"Open now · ":""}Saved ${new Date(b.updated_at).toLocaleString(undefined,{day:"numeric",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"})}</span></span>
    ${delConfirm===b.id
      ?`<span class="confirm"><span>Delete this board?</span><button type="button" class="btn" data-b="del-yes">Delete</button><button type="button" class="btn ghost" data-b="del-no">Keep</button></span>`
      :`<button type="button" class="btn ghost" data-b="open">Open</button><button type="button" class="btn ghost" data-b="del">Delete</button>`}
  </div>`).join("");
}
ov.addEventListener("click",async e=>{
  if(e.target===ov){ov.hidden=true; return}
  const b=e.target.closest("button"); if(!b) return;
  if(b.id==="closeBoards"){ov.hidden=true; return}
  const id=b.closest(".board-row")&&b.closest(".board-row").dataset.id; if(!id) return;
  if(b.dataset.b==="open"){
    const {data,error}=await sb.from("boards").select("id,data").eq("id",id).single();
    if(error||!data){status("Couldn't open that board."); return}
    loadInto(data.id,data.data); ov.hidden=true; status("Opened");
  }else if(b.dataset.b==="del"){delConfirm=id; openBoards()}
  else if(b.dataset.b==="del-no"){delConfirm=null; openBoards()}
  else if(b.dataset.b==="del-yes"){
    delConfirm=null;
    const {error}=await sb.from("boards").delete().eq("id",id);
    if(error) status("Couldn't delete that board.");
    if(id===currentId){currentId=null; window.DBB.newBoard()}
    openBoards();
  }
});
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!ov.hidden) ov.hidden=true});

/* ---------- saving ---------- */
let sb=null, user=null, currentId=null, saveTimer=null, loading=false, saving=null;
function loadInto(id,data){loading=true; currentId=id; try{window.DBB.importAll(data)}finally{loading=false}}
function schedule(){
  if(loading||!user) return;
  status("Saving…");
  clearTimeout(saveTimer); saveTimer=setTimeout(saveNow,1500);
}
async function saveNow(){
  clearTimeout(saveTimer); saveTimer=null;
  if(!user) return;
  const run=async()=>{
    const data=window.DBB.exportAll(), name=window.DBB.boardName().slice(0,80);
    if(currentId){
      const {error}=await sb.from("boards").update({name,data,updated_at:new Date().toISOString()}).eq("id",currentId);
      status(error?"Not saved: check your internet connection":"Saved");
    }else{
      const {data:row,error}=await sb.from("boards").insert({name,data}).select("id").single();
      if(!error&&row) currentId=row.id;
      status(error?"Not saved: check your internet connection":"Saved");
    }
  };
  saving=(saving||Promise.resolve()).then(run,run);
  return saving;
}
async function flush(){ if(saveTimer) await saveNow(); else if(saving) await saving }
window.addEventListener("beforeunload",()=>{ if(saveTimer) saveNow() });

/* ---------- reading photos on the server ---------- */
async function shrink(file){
  let bmp;
  try{ bmp=await createImageBitmap(file,{imageOrientation:"from-image"}) }
  catch(e){
    bmp=await new Promise((res,rej)=>{const i=new Image(); i.onload=()=>res(i); i.onerror=rej; i.src=URL.createObjectURL(file)});
  }
  const w=bmp.width, h=bmp.height, k=Math.min(1,1568/Math.max(w,h));
  const c=document.createElement("canvas"); c.width=Math.round(w*k); c.height=Math.round(h*k);
  c.getContext("2d").drawImage(bmp,0,0,c.width,c.height);
  return c.toDataURL("image/jpeg",0.85).split(",")[1];
}
async function readViaServer(file,extra,signal){
  let image;
  try{ image=await shrink(file) }catch(e){ throw {code:"image_rejected"} }
  if(signal&&signal.aborted) throw {code:"cancelled"};
  const {data,error}=await sb.functions.invoke("read-board",{body:{image,mediaType:"image/jpeg",extra}});
  if(signal&&signal.aborted) throw {code:"cancelled"};
  if(error){
    let info=null;
    try{ info=error.context&&typeof error.context.json==="function"?await error.context.json():null }catch(e){}
    throw {code:(info&&info.code)||"upstream_error",userMessage:(info&&info.error)||"Photo reading isn't working right now. Check your internet connection and try again."};
  }
  if(!data||!data.reading) throw {code:"invalid_json"};
  await flush(); currentId=null;   // a photo becomes a new saved board, not a replacement
  return data.reading;
}

/* ---------- start ---------- */
async function onSignedIn(u){
  if(user&&user.id===u.id){gate.hidden=true; return}
  user=u;
  gate.hidden=true; bar.hidden=false;
  $("who").innerHTML=`Signed in as <strong>${esc(u.email||"")}</strong>`;
  window.DBB.setPhotoReader(readViaServer);
  status("Loading your boards…");
  const {data,error}=await sb.from("boards").select("id,data").order("updated_at",{ascending:false}).limit(1);
  if(error){status("Couldn't load your boards"); return}
  if(data&&data.length){loadInto(data[0].id,data[0].data); status("Saved")}
  else {currentId=null; await saveNow()}
}
function start(){
  if(!configured||!window.supabase||!window.supabase.createClient){ showGate(); return }
  sb=window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_ANON_KEY,{auth:{persistSession:true,detectSessionInUrl:true,autoRefreshToken:true}});
  window.DBB.onChange(schedule);
  $("myBoards").onclick=openBoards;
  $("newBoardBtn").onclick=async()=>{await flush(); currentId=null; window.DBB.newBoard(); status("New board")};
  $("signOut").onclick=async()=>{
    await flush();
    await sb.auth.signOut();
    try{localStorage.removeItem("dbboard.v2"); localStorage.removeItem("dbboard.v1")}catch(e){}
    location.replace(here);
  };
  let recovering=false;
  sb.auth.onAuthStateChange((event,session)=>{
    if(event==="PASSWORD_RECOVERY"){recovering=true; showRecovery(); return}
    if(recovering) return;
    if(session&&session.user) setTimeout(()=>onSignedIn(session.user),0);
    else if(event==="SIGNED_OUT"||!user){ user=null; bar.hidden=true; showGate() }
  });
  sb.auth.getSession().then(({data})=>{ if(!(data&&data.session)&&!recovering) showGate() });
}
showGate();
start();
})();
