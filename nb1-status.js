import {
  initializeApp,
  getApps,
  getApp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";

import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import {
  getFirestore,
  doc,
  getDoc,
  collection,
  getDocs,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyC2xpMW1xgaWIdI2JoEhK23vkC0FTF2PKc",
  authDomain: "tippliga-4b3af.firebaseapp.com",
  projectId: "tippliga-4b3af",
  storageBucket: "tippliga-4b3af.appspot.com",
  messagingSenderId: "720359845241",
  appId: "1:720359845241:web:d3d6edcac6b43ebff053a8"
};

const app = getApps().length
  ? getApp()
  : initializeApp(firebaseConfig);

const auth = getAuth(app);
const db = getFirestore(app);

export const ACTIVE_NB1_TEAMS = [
  "Debreceni VSC",
  "Kispest-Honvéd FC",
  "Ferencváros",
  "ETO FC Győr",
  "Vasas FC",
  "Kisvárda FC",
  "MTK Budapest",
  "Nyíregyháza Spartacus",
  "Paksi FC",
  "Puskás Akadémia",
  "Újpest FC",
  "Zalaegerszegi TE FC"
];

const VALID_TIP_CHOICES = new Set([
  "1",
  "X",
  "2"
]);

let currentUserEmail = "";
let pendingRefreshTimer = null;
let pendingRefreshTimer2 = null;
let matchObserver = null;

function normalizeTeamName(value){
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function timestampMillis(value){
  if (!value){
    return 0;
  }

  if (typeof value.toMillis === "function"){
    return value.toMillis();
  }

  if (typeof value.seconds === "number"){
    return value.seconds * 1000;
  }

  return 0;
}

export function getTipChoice(tip){
  return String(
    tip?.choice ??
    tip?.tip ??
    ""
  )
    .trim()
    .toUpperCase();
}

export function isValidTipChoice(value){
  return VALID_TIP_CHOICES.has(
    String(value || "")
      .trim()
      .toUpperCase()
  );
}

function tipTimestamp(tip){
  return (
    timestampMillis(tip?.updatedAt) ||
    timestampMillis(tip?.createdAt) ||
    0
  );
}

function latestTipsByMatch(tipDocs){
  const latest = new Map();

  for (const tipDoc of tipDocs){
    const tip = tipDoc.data() || {};
    const matchId = String(tip.matchId || "");

    if (!matchId){
      continue;
    }

    const candidate = {
      id: tipDoc.id,
      ...tip
    };

    const previous = latest.get(matchId);

    if (!previous){
      latest.set(matchId, candidate);
      continue;
    }

    const previousTime = tipTimestamp(previous);
    const candidateTime = tipTimestamp(candidate);

    if (candidateTime > previousTime){
      latest.set(matchId, candidate);
      continue;
    }

    if (candidateTime === previousTime){
      const previousIsValid = isValidTipChoice(
        getTipChoice(previous)
      );

      const candidateIsValid = isValidTipChoice(
        getTipChoice(candidate)
      );

      if (
        candidateIsValid ||
        !previousIsValid
      ){
        latest.set(matchId, candidate);
      }
    }
  }

  return latest;
}

function injectStatusStyles(){
  if (
    document.getElementById(
      "nb1StatusStyles"
    )
  ){
    return;
  }

  const style = document.createElement("style");

  style.id = "nb1StatusStyles";

  style.textContent = `
    .pill-badge {
      display:inline-flex;
      align-items:center;
      justify-content:center;
      min-width:18px;
      height:18px;
      padding:0 6px;
      margin-left:6px;
      border-radius:999px;
      background:#ef4444;
      color:#fff;
      font-size:12px;
      font-weight:700;
      line-height:1;
      vertical-align:middle;
    }

    .pill-badge[hidden] {
      display:none !important;
    }

    #nb1StandingsReminder {
      position:fixed;
      inset:0;
      z-index:5000;
      display:flex;
      align-items:center;
      justify-content:center;
      padding:20px;
      background:rgba(15,23,42,.58);
      box-sizing:border-box;
    }

    #nb1StandingsReminder[hidden] {
      display:none !important;
    }

    .nb1-status-dialog {
      width:min(520px,100%);
      background:#fff;
      color:#111827;
      border:1px solid var(--line,#e6eaf1);
      border-radius:16px;
      box-shadow:0 24px 70px rgba(0,0,0,.28);
      overflow:hidden;
    }

    .nb1-status-dialog-head {
      padding:18px 20px 12px;
      font-size:20px;
      font-weight:800;
    }

    .nb1-status-dialog-body {
      padding:0 20px 18px;
      color:#475569;
      font-size:14px;
      line-height:1.5;
    }

    .nb1-status-dialog-body p {
      margin:0 0 10px;
    }

    .nb1-status-dialog-actions {
      display:flex;
      justify-content:flex-end;
      gap:10px;
      padding:14px 20px;
      border-top:1px solid var(--line,#e6eaf1);
      background:#f8fafc;
    }

    .nb1-status-button {
      min-height:40px;
      padding:9px 14px;
      border:0;
      border-radius:10px;
      cursor:pointer;
      font-weight:700;
    }

    .nb1-status-button-secondary {
      color:#111827;
      background:#e5e7eb;
    }

    .nb1-status-button-primary {
      color:#fff;
      background:var(--accent,#3b82f6);
    }

    @media (max-width:520px) {
      .nb1-status-dialog-actions {
        flex-direction:column-reverse;
      }

      .nb1-status-button {
        width:100%;
      }
    }
  `;

  document.head.appendChild(style);
}

function ensureTipsBadge(){
  let badge = document.getElementById(
    "tipsBadge"
  );

  if (badge){
    return badge;
  }

  const matchesLink = Array.from(
    document.querySelectorAll("a[href]")
  ).find(link => {
    const href =
      link.getAttribute("href") ||
      "";

    return /(^|\/)matches\.html(?:[?#]|$)/i.test(
      href
    );
  });

  if (!matchesLink){
    return null;
  }

  const title =
    matchesLink.querySelector(".title") ||
    matchesLink;

  badge = document.createElement("span");

  badge.id = "tipsBadge";
  badge.className = "pill-badge";
  badge.hidden = true;

  title.appendChild(
    document.createTextNode(" ")
  );

  title.appendChild(badge);

  return badge;
}

export async function refreshNb1PendingTips({
  db: suppliedDb = db,
  userEmail = currentUserEmail,
  now = new Date()
} = {}){
  if (
    !suppliedDb ||
    !userEmail
  ){
    return {
      pending: 0,
      upcoming: 0,
      tipped: 0
    };
  }

  const badge = ensureTipsBadge();

  try{
    const [
      upcomingSnap,
      tipsSnap
    ] = await Promise.all([
      getDocs(
        query(
          collection(
            suppliedDb,
            "matches"
          ),
          where(
            "startTime",
            ">=",
            now
          )
        )
      ),

      getDocs(
        query(
          collection(
            suppliedDb,
            "tips"
          ),
          where(
            "user",
            "==",
            userEmail
          )
        )
      )
    ]);

    const upcomingIds =
      upcomingSnap.docs.map(
        matchDoc => matchDoc.id
      );

    const latest = latestTipsByMatch(
      tipsSnap.docs
    );

    const validTippedIds = new Set();

    for (const [
      matchId,
      tip
    ] of latest.entries()){
      if (
        isValidTipChoice(
          getTipChoice(tip)
        )
      ){
        validTippedIds.add(matchId);
      }
    }

    const pending =
      upcomingIds.filter(
        matchId =>
          !validTippedIds.has(matchId)
      ).length;

    if (badge){
      if (pending > 0){
        badge.textContent = String(pending);
        badge.hidden = false;

        badge.title =
          `${pending} közelgő mérkőzésre nincs leadott tipped`;
      }else{
        badge.textContent = "";
        badge.hidden = true;
        badge.removeAttribute("title");
      }
    }

    return {
      pending,
      upcoming: upcomingIds.length,
      tipped:
        upcomingIds.length -
        pending
    };
  }catch(error){
    console.warn(
      "A függő tippek számolása sikertelen:",
      error
    );

    if (badge){
      badge.textContent = "";
      badge.hidden = true;
    }

    return {
      pending: 0,
      upcoming: 0,
      tipped: 0,
      error
    };
  }
}

function standingsOrderFromData(data){
  if (Array.isArray(data?.order)){
    return data.order;
  }

  if (Array.isArray(data?.teams)){
    return data.teams;
  }

  if (Array.isArray(data?.ranking)){
    return data.ranking;
  }

  return [];
}

export function isCompleteStandingsOrder(order){
  if (
    !Array.isArray(order) ||
    order.length !== 12
  ){
    return false;
  }

  const normalizedOrder = order.map(
    normalizeTeamName
  );

  if (
    normalizedOrder.some(
      team => !team
    )
  ){
    return false;
  }

  if (
    new Set(normalizedOrder).size !== 12
  ){
    return false;
  }

  const activeTeams = new Set(
    ACTIVE_NB1_TEAMS.map(
      normalizeTeamName
    )
  );

  return normalizedOrder.every(
    team => activeTeams.has(team)
  );
}

export async function hasCompleteStandingsTip({
  db: suppliedDb = db,
  userEmail = currentUserEmail
} = {}){
  if (
    !suppliedDb ||
    !userEmail
  ){
    return false;
  }

  try{
    const snap = await getDoc(
      doc(
        suppliedDb,
        "standingsTips",
        userEmail
      )
    );

    if (!snap.exists()){
      return false;
    }

    return isCompleteStandingsOrder(
      standingsOrderFromData(
        snap.data() || {}
      )
    );
  }catch(error){
    console.warn(
      "A szezonvégi sorrend ellenőrzése sikertelen:",
      error
    );

    return null;
  }
}

function isPositionsPage(){
  return /(^|\/)positions\.html$/i.test(
    window.location.pathname
  );
}

function isMatchesPage(){
  return /(^|\/)matches\.html$/i.test(
    window.location.pathname
  );
}

function closeStandingsReminder(){
  document
    .getElementById(
      "nb1StandingsReminder"
    )
    ?.remove();
}

export function showStandingsReminder(){
  if (
    document.getElementById(
      "nb1StandingsReminder"
    )
  ){
    return;
  }

  injectStatusStyles();

  const overlay =
    document.createElement("div");

  overlay.id =
    "nb1StandingsReminder";

  overlay.setAttribute(
    "role",
    "dialog"
  );

  overlay.setAttribute(
    "aria-modal",
    "true"
  );

  overlay.setAttribute(
    "aria-labelledby",
    "nb1StandingsReminderTitle"
  );

  overlay.innerHTML = `
    <div class="nb1-status-dialog">
      <div
        id="nb1StandingsReminderTitle"
        class="nb1-status-dialog-head"
      >
        Még nem adtad le a szezon végi sorrendedet
      </div>

      <div class="nb1-status-dialog-body">
        <p>
          Rendezd sorba az NB I mind a 12 csapatát
          a várható szezon végi helyezésük szerint.
        </p>

        <p>
          A sorrend alapján a szezon végén legfeljebb
          <strong>+12% bónusz</strong> szerezhető.
        </p>

        <p>
          Most kihagyhatod, de ez a figyelmeztetés
          minden új oldalbetöltésnél ismét megjelenik,
          amíg nem adsz le teljes sorrendet.
        </p>
      </div>

      <div class="nb1-status-dialog-actions">
        <button
          type="button"
          class="nb1-status-button nb1-status-button-secondary"
          id="nb1StandingsSkip"
        >
          Most kihagyom
        </button>

        <button
          type="button"
          class="nb1-status-button nb1-status-button-primary"
          id="nb1StandingsOpen"
        >
          Sorrend megadása
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  document
    .getElementById(
      "nb1StandingsSkip"
    )
    ?.addEventListener(
      "click",
      closeStandingsReminder
    );

  document
    .getElementById(
      "nb1StandingsOpen"
    )
    ?.addEventListener(
      "click",
      () => {
        window.location.href =
          "positions.html";
      }
    );

  const escapeHandler = event => {
    if (event.key !== "Escape"){
      return;
    }

    closeStandingsReminder();

    document.removeEventListener(
      "keydown",
      escapeHandler
    );
  };

  document.addEventListener(
    "keydown",
    escapeHandler
  );
}

export async function refreshStandingsReminder({
  db: suppliedDb = db,
  userEmail = currentUserEmail,
  showOnPositionsPage = false
} = {}){
  if (
    !showOnPositionsPage &&
    isPositionsPage()
  ){
    closeStandingsReminder();

    return {
      complete: false,
      skippedBecausePositionsPage: true
    };
  }

  const complete =
    await hasCompleteStandingsTip({
      db: suppliedDb,
      userEmail
    });

  if (complete === false){
    showStandingsReminder();
  }else{
    closeStandingsReminder();
  }

  return {
    complete
  };
}

function getMatchRow(element){
  return element?.closest?.(".match") || null;
}

function getMatchTipSelect(row){
  if (!row){
    return null;
  }

  return Array.from(
    row.querySelectorAll("select")
  ).find(select => {
    const value = String(
      select.value || ""
    ).toUpperCase();

    return (
      value === "" ||
      value === "1" ||
      value === "X" ||
      value === "2"
    );
  }) || null;
}

function getMatchDoubleCheckbox(row){
  return row?.querySelector(
    'input[type="checkbox"][data-kind="double"]'
  ) || null;
}

function schedulePendingRefresh(){
  if (!currentUserEmail){
    return;
  }

  clearTimeout(pendingRefreshTimer);
  clearTimeout(pendingRefreshTimer2);

  pendingRefreshTimer = setTimeout(
    () => {
      refreshNb1PendingTips({
        db,
        userEmail: currentUserEmail
      });
    },
    700
  );

  pendingRefreshTimer2 = setTimeout(
    () => {
      refreshNb1PendingTips({
        db,
        userEmail: currentUserEmail
      });
    },
    1700
  );
}

function sanitizeVisibleMatchRows(){
  if (!isMatchesPage()){
    return;
  }

  const rows =
    document.querySelectorAll(".match");

  rows.forEach(row => {
    const select =
      getMatchTipSelect(row);

    const doubleCheckbox =
      getMatchDoubleCheckbox(row);

    if (
      select &&
      !select.dataset.nb1LastChoice
    ){
      select.dataset.nb1LastChoice =
        isValidTipChoice(select.value)
          ? String(select.value)
          : "";
    }

    if (
      doubleCheckbox?.checked &&
      !isValidTipChoice(select?.value)
    ){
      doubleCheckbox.checked = false;

      doubleCheckbox.dispatchEvent(
        new Event(
          "change",
          {
            bubbles: true
          }
        )
      );
    }
  });
}

function initMatchesGuard(){
  if (
    !isMatchesPage() ||
    document.documentElement.dataset
      .nb1MatchesGuard === "1"
  ){
    return;
  }

  document.documentElement.dataset
    .nb1MatchesGuard = "1";

  document.addEventListener(
    "focusin",
    event => {
      const select = event.target;

      if (
        !(select instanceof HTMLSelectElement)
      ){
        return;
      }

      const row = getMatchRow(select);

      if (!row){
        return;
      }

      select.dataset.nb1LastChoice =
        isValidTipChoice(select.value)
          ? String(select.value)
          : "";
    },
    true
  );

  document.addEventListener(
    "change",
    event => {
      const target = event.target;

      if (
        target instanceof HTMLInputElement &&
        target.matches(
          'input[type="checkbox"][data-kind="double"]'
        )
      ){
        const row = getMatchRow(target);
        const select =
          getMatchTipSelect(row);

        if (
          target.checked &&
          !isValidTipChoice(select?.value)
        ){
          event.preventDefault();
          event.stopImmediatePropagation();

          target.checked = false;

          alert(
            "Előbb válassz 1, X vagy 2 tippet, és csak utána jelöld meg duplának a mérkőzést."
          );

          schedulePendingRefresh();

          return;
        }

        schedulePendingRefresh();

        return;
      }

      if (
        target instanceof HTMLSelectElement
      ){
        const row = getMatchRow(target);

        if (!row){
          return;
        }

        const doubleCheckbox =
          getMatchDoubleCheckbox(row);

        if (
          !isValidTipChoice(target.value) &&
          doubleCheckbox?.checked
        ){
          event.preventDefault();
          event.stopImmediatePropagation();

          doubleCheckbox.checked = false;

          doubleCheckbox.dispatchEvent(
            new Event(
              "change",
              {
                bubbles: true
              }
            )
          );

          target.dataset.nb1LastChoice = "";

          schedulePendingRefresh();

          return;
        }

        target.dataset.nb1LastChoice =
          isValidTipChoice(target.value)
            ? String(target.value)
            : "";

        schedulePendingRefresh();
      }
    },
    true
  );

  const observeTarget =
    document.getElementById("matchList") ||
    document.body;

  matchObserver = new MutationObserver(
    () => {
      setTimeout(
        sanitizeVisibleMatchRows,
        0
      );
    }
  );

  matchObserver.observe(
    observeTarget,
    {
      childList: true,
      subtree: true
    }
  );

  setTimeout(
    sanitizeVisibleMatchRows,
    300
  );

  setTimeout(
    sanitizeVisibleMatchRows,
    1200
  );
}

export async function initNb1Status({
  db: suppliedDb = db,
  userEmail = currentUserEmail,
  showStandingsReminder = true,
  showOnPositionsPage = false
} = {}){
  currentUserEmail = userEmail;

  injectStatusStyles();

  const tasks = [
    refreshNb1PendingTips({
      db: suppliedDb,
      userEmail
    })
  ];

  if (showStandingsReminder){
    tasks.push(
      refreshStandingsReminder({
        db: suppliedDb,
        userEmail,
        showOnPositionsPage
      })
    );
  }

  if (isMatchesPage()){
    initMatchesGuard();
  }

  const results =
    await Promise.allSettled(tasks);

  setTimeout(
    () => {
      refreshNb1PendingTips({
        db: suppliedDb,
        userEmail
      });
    },
    1200
  );

  setTimeout(
    () => {
      refreshNb1PendingTips({
        db: suppliedDb,
        userEmail
      });
    },
    3000
  );

  return results;
}

function autoStart(){
  onAuthStateChanged(
    auth,
    user => {
      if (!user){
        return;
      }

      currentUserEmail = user.email || "";

      initNb1Status({
        db,
        userEmail: currentUserEmail,
        showStandingsReminder: true,
        showOnPositionsPage: false
      });
    }
  );
}

if (document.readyState === "loading"){
  document.addEventListener(
    "DOMContentLoaded",
    autoStart,
    {
      once: true
    }
  );
}else{
  autoStart();
}