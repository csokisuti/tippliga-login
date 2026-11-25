// activity logger (NB1 TippLiga)
// Include on pages with: <script type="module" src="logger.js"></script>

import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, addDoc, Timestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { app, auth, db } from "./firebase-init.js";


// app, auth, db: lásd firebase-init.js



function logEvent(ev){
  try{
    const u = auth.currentUser;
    addDoc(collection(db,"activityLogs"),{
      ts: Timestamp.fromDate(new Date()),
      event: ev.event,
      path: location.pathname + location.search + location.hash,
      userEmail: u?.email || null,
      ua: navigator.userAgent
    }).catch(()=>{});
  }catch(_){}
}

onAuthStateChanged(auth, ()=>{
  // Log a view on load
  logEvent({event:"view"});
  // Log clicks
  document.addEventListener("click", ()=> logEvent({event:"click"}), {capture:true});
  // Optional SPA-ish navigation tracking
  window.addEventListener("hashchange", ()=> logEvent({event:"view"}));
  window.addEventListener("popstate",  ()=> logEvent({event:"view"}));
});
