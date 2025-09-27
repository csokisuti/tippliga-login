// activity logger (NB1 TippLiga)
// Include on pages with: <script type="module" src="logger.js"></script>

import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, addDoc, Timestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyC2xpMW1xgaWIdI2JoEhK23vkC0FTF2PKc",
  authDomain: "tippliga-4b3af.firebaseapp.com",
  projectId: "tippliga-4b3af",
  storageBucket: "tippliga-4b3af.appspot.com",
  messagingSenderId: "720359845241",
  appId: "1:720359845241:web:d3d6edcac6b43ebff053a8"
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

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
