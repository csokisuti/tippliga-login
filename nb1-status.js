import { getApp, getApps, initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  serverTimestamp,
  updateDoc,
  where
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig={
  apiKey:"AIzaSyC2xpMW1xgaWIdI2JoEhK23vkC0FTF2PKc",
  authDomain:"tippliga-4b3af.firebaseapp.com",
  projectId:"tippliga-4b3af",
  storageBucket:"tippliga-4b3af.appspot.com",
  messagingSenderId:"720359845241",
  appId:"1:720359845241:web:d3d6edcac6b43ebff053a8"
};

const app=getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth=getAuth(app);
const db=getFirestore(app);
const VALID_CHOICES=new Set(["1","X","2"]);
const FINISHED_STATUSES=new Set(["FT","AET","PEN","AWD","CANC","ABD"]);

function matchRound(match){
  return String(match?.round??match?.roundId??"");
}

function isPostponedWithoutDate(match){
  return !!(
    match?.postponedWithoutDate||
    (match?.postponed&&String(match?.apiStatus||"").toUpperCase()==="PST")
  );
}

function matchHasFinished(match){
  return !!(
    String(match?.result||"").trim()||
    FINISHED_STATUSES.has(String(match?.apiStatus||"").toUpperCase())
  );
}

function matchStartDate(match){
  const value=match?.startTime;
  const date=value?.toDate ? value.toDate() : new Date(value);
  return date instanceof Date&&!Number.isNaN(date.getTime()) ? date : null;
}

function shouldSeparatePostponed(match,allMatches){
  if(!isPostponedWithoutDate(match)) return false;

  const otherPlayable=allMatches.filter(other=>
    other.id!==match.id&&
    matchRound(other)===matchRound(match)&&
    !isPostponedWithoutDate(other)
  );

  return otherPlayable.length>0&&otherPlayable.every(matchHasFinished);
}

function isFrozenDouble(tip,matchesById){
  const match=matchesById.get(tip?.matchId);

  if(!match||isPostponedWithoutDate(match)){
    return false;
  }

  const start=matchStartDate(match);
  return !!start&&start<=new Date();
}

function latestTipsByMatch(tips){
  const map=new Map();

  for(const tip of tips){
    if(!tip?.matchId) continue;

    const previous=map.get(tip.matchId);
    const previousTime=
      previous?.updatedAt?.toMillis?.()||
      previous?.createdAt?.toMillis?.()||0;
    const currentTime=
      tip?.updatedAt?.toMillis?.()||
      tip?.createdAt?.toMillis?.()||0;

    if(!previous||currentTime>=previousTime){
      map.set(tip.matchId,tip);
    }
  }

  return map;
}

async function cleanInvalidDoubles(tips,matchesById){
  const doublesByRound=new Map();

  for(const tip of tips){
    if(!(tip.double||tip.isDouble)) continue;

    const choice=tip.choice??tip.tip??"";
    const match=matchesById.get(tip.matchId);

    if(!VALID_CHOICES.has(choice)||!match){
      await updateDoc(doc(db,"tips",tip.id),{
        double:false,
        isDouble:false,
        updatedAt:serverTimestamp()
      }).catch(()=>{});
      continue;
    }

    const round=String(tip.round??matchRound(match));
    const previous=doublesByRound.get(round);

    if(!previous){
      doublesByRound.set(round,tip);
      continue;
    }

    const previousFrozen=
      isFrozenDouble(previous,matchesById);
    const currentFrozen=
      isFrozenDouble(tip,matchesById);
    const previousTime=
      previous?.updatedAt?.toMillis?.()||
      previous?.createdAt?.toMillis?.()||0;
    const currentTime=
      tip?.updatedAt?.toMillis?.()||
      tip?.createdAt?.toMillis?.()||0;

    const keep=
      previousFrozen&&!currentFrozen
        ? previous
        : currentFrozen&&!previousFrozen
          ? tip
          : currentTime>=previousTime
            ? tip
            : previous;
    const remove=keep===tip ? previous : tip;

    await updateDoc(doc(db,"tips",remove.id),{
      double:false,
      isDouble:false,
      updatedAt:serverTimestamp()
    }).catch(()=>{});

    doublesByRound.set(round,keep);
  }
}

function setBadge(count){
  document.querySelectorAll("#tipsBadge").forEach(badge=>{
    if(count>0){
      badge.textContent=String(count);
      badge.hidden=false;
    }else{
      badge.hidden=true;
      badge.textContent="";
    }
  });
}

function standingsComplete(data){
  const order=Array.isArray(data?.order)
    ? data.order
    : Array.isArray(data?.teams)
      ? data.teams
      : Array.isArray(data?.ranking)
        ? data.ranking
        : [];

  return order.length===12&&order.every(Boolean)&&new Set(order).size===12;
}

function showReminder({pendingMatches,positionsMissing}){
  if(/positions\.html$/i.test(location.pathname)) return;
  if(!pendingMatches&&!positionsMissing) return;
  if(document.getElementById("nb1StatusReminder")) return;

  const style=document.createElement("style");
  style.textContent=`
    .nb1-status-backdrop{position:fixed;inset:0;z-index:5000;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:18px}
    .nb1-status-dialog{width:min(520px,100%);background:#fff;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.25);overflow:hidden}
    .nb1-status-head{padding:14px 16px;font-weight:800;border-bottom:1px solid #e5e7eb;background:#f8fafc}
    .nb1-status-body{padding:16px;color:#334155;line-height:1.5}
    .nb1-status-actions{display:flex;flex-wrap:wrap;gap:8px;padding:0 16px 16px}
    .nb1-status-actions a,.nb1-status-actions button{border:1px solid #e5e7eb;border-radius:10px;padding:9px 12px;text-decoration:none;cursor:pointer;background:#fff;color:#111827;font-weight:700}
    .nb1-status-actions a{background:#2563eb;color:#fff;border-color:#2563eb}
  `;
  document.head.appendChild(style);

  const overlay=document.createElement("div");
  overlay.id="nb1StatusReminder";
  overlay.className="nb1-status-backdrop";

  const parts=[];
  if(pendingMatches){
    parts.push(`<strong>${pendingMatches}</strong> közelgő mérkőzésre még nincs érvényes 1/X/2 tipped.`);
  }
  if(positionsMissing){
    parts.push("A szezon végi 12 csapatos sorrended még nincs teljesen kitöltve.");
  }

  overlay.innerHTML=`
    <div class="nb1-status-dialog" role="dialog" aria-modal="true" aria-labelledby="nb1StatusTitle">
      <div class="nb1-status-head" id="nb1StatusTitle">Tippelési emlékeztető</div>
      <div class="nb1-status-body">${parts.map(x=>`<div>${x}</div>`).join("")}</div>
      <div class="nb1-status-actions">
        ${pendingMatches ? '<a href="matches.html">Meccstippek</a>' : ""}
        ${positionsMissing ? '<a href="positions.html">Szezon végi sorrend</a>' : ""}
        <button type="button" id="nb1StatusClose">Most nem</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.querySelector("#nb1StatusClose")?.addEventListener("click",()=>overlay.remove());
  overlay.addEventListener("click",event=>{
    if(event.target===overlay) overlay.remove();
  });
}

async function refreshStatus(user){
  const [matchesSnap,tipsSnap,standingSnap]=await Promise.all([
    getDocs(collection(db,"matches")),
    getDocs(query(collection(db,"tips"),where("user","==",user.email))),
    getDoc(doc(db,"standingsTips",user.email))
  ]);

  const allMatches=matchesSnap.docs.map(item=>({id:item.id,...item.data()}));
  const matchesById=new Map(allMatches.map(match=>[match.id,match]));
  const tips=tipsSnap.docs.map(item=>({id:item.id,...item.data()}));

  await cleanInvalidDoubles(tips,matchesById);

  const latest=latestTipsByMatch(tips);
  const now=new Date();
  const actionable=allMatches.filter(match=>{
    if(match.published===false) return false;

    if(isPostponedWithoutDate(match)){
      return !shouldSeparatePostponed(match,allMatches);
    }

    const start=matchStartDate(match);
    return !!start&&start>=now;
  });

  const pendingMatches=actionable.filter(match=>{
    const tip=latest.get(match.id);
    return !VALID_CHOICES.has(tip?.choice??tip?.tip??"");
  }).length;

  setBadge(pendingMatches);

  showReminder({
    pendingMatches,
    positionsMissing:!standingsComplete(
      standingSnap.exists()
        ? standingSnap.data()
        : null
    )
  });
}

onAuthStateChanged(auth,user=>{
  if(!user) return;
  refreshStatus(user).catch(error=>{
    console.warn("nb1-status hiba:",error);
  });
});
