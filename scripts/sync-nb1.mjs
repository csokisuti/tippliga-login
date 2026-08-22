import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const PROJECT_ID = "tippliga-4b3af";
const LEAGUE_ID = "4690";
const SEASON = "2026-2027";
const API_KEY = process.env.THESPORTSDB_API_KEY || "123";
const RELEASE_DELAY_HOURS = Number.parseInt(process.env.RELEASE_DELAY_HOURS || "26", 10);
const DRY_RUN = process.env.DRY_RUN !== "false";
const MATCHES_PER_ROUND = 6;
const MAX_DIRECT_LOOKUPS = 24;

const TEAMS = [
  "Debreceni VSC", "Kispest-Honvéd FC", "Ferencváros", "ETO FC Győr",
  "Vasas FC", "Kisvárda FC", "MTK Budapest", "Nyíregyháza Spartacus",
  "Paksi FC", "Puskás Akadémia", "Újpest FC", "Zalaegerszegi TE FC"
];

const TEAM_ALIASES = {
  "debrecen":"Debreceni VSC", "debreceni vsc":"Debreceni VSC",
  "budapest honved":"Kispest-Honvéd FC", "budapest honved fc":"Kispest-Honvéd FC",
  "honved":"Kispest-Honvéd FC", "kispest honved":"Kispest-Honvéd FC", "kispest honved fc":"Kispest-Honvéd FC",
  "ferencvaros":"Ferencváros", "ferencvarosi tc":"Ferencváros", "ferencvaros tc":"Ferencváros",
  "gyori eto":"ETO FC Győr", "gyori eto fc":"ETO FC Győr", "eto fc gyor":"ETO FC Győr",
  "vasas":"Vasas FC", "vasas fc":"Vasas FC",
  "kisvarda":"Kisvárda FC", "kisvarda fc":"Kisvárda FC",
  "mtk":"MTK Budapest", "mtk budapest":"MTK Budapest",
  "nyiregyhaza":"Nyíregyháza Spartacus", "nyiregyhaza spartacus":"Nyíregyháza Spartacus",
  "paks":"Paksi FC", "paksi fc":"Paksi FC",
  "puskas akademia":"Puskás Akadémia", "puskas akademia fc":"Puskás Akadémia",
  "ujpest":"Újpest FC", "ujpest fc":"Újpest FC",
  "zalaegerszeg":"Zalaegerszegi TE FC", "zalaegerszegi te":"Zalaegerszegi TE FC", "zalaegerszegi te fc":"Zalaegerszegi TE FC"
};

const ROUND_RELEASE_STATUSES = new Set(["FT","AET","PEN","PST","CANC","ABD","AWD"]);
const RESULT_STATUSES = new Set(["FT","AET","PEN","FINISHED","MATCH FINISHED"]);

function normalizeText(v){
  return String(v ?? "").trim().toLocaleLowerCase("hu").normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function mapTeam(name){
  return TEAM_ALIASES[normalizeText(name)] || null;
}

function normalizedStatus(e){
  return String(e?.strStatus || "").trim().toUpperCase();
}

function eventRound(e){
  const n=Number.parseInt(e?.intRound,10);
  return Number.isFinite(n)?n:null;
}

function matchRound(m){
  const n=Number.parseInt(m?.roundId ?? m?.round ?? "",10);
  return Number.isFinite(n)?n:null;
}

function apiPostponed(e){
  return normalizedStatus(e)==="PST" ||
    String(e?.strPostponed || "").trim().toLowerCase()==="yes";
}

function eventStartDate(e){
  if(e?.strTimestamp){
    const d=new Date(e.strTimestamp);
    if(!Number.isNaN(d.getTime())) return d;
  }

  const date=e?.dateEventLocal || e?.dateEvent;
  const time=e?.strTimeLocal || e?.strTime || "00:00:00";

  if(!date) return null;

  const d=new Date(`${date}T${time}+02:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function hasFinalResult(e){
  const hs=e?.intHomeScore;
  const as=e?.intAwayScore;

  const scores=
    hs!==null &&
    hs!==undefined &&
    as!==null &&
    as!==undefined &&
    Number.isFinite(Number(hs)) &&
    Number.isFinite(Number(as));

  return scores && RESULT_STATUSES.has(normalizedStatus(e));
}

function resultFromEvent(e){
  if(!hasFinalResult(e)) return null;

  const h=Number(e.intHomeScore);
  const a=Number(e.intAwayScore);

  return {
    result:`${h}-${a}`,
    outcome:h>a?"1":h<a?"2":"X"
  };
}

function formatLocalDate(date){
  if(!date) return "-";

  return new Intl.DateTimeFormat("hu-HU",{
    timeZone:"Europe/Budapest",
    year:"numeric",
    month:"2-digit",
    day:"2-digit",
    hour:"2-digit",
    minute:"2-digit"
  }).format(date);
}

function timestampMillis(v){
  if(!v) return null;

  if(typeof v.toMillis==="function") return v.toMillis();
  if(typeof v.toDate==="function") return v.toDate().getTime();
  if(v instanceof Date) return v.getTime();

  const d=new Date(v);
  return Number.isNaN(d.getTime())?null:d.getTime();
}

function valuesEqual(a,b){
  if(a && typeof a.toMillis==="function"){
    return a.toMillis()===timestampMillis(b);
  }

  if(b instanceof Date){
    return timestampMillis(a)===b.getTime();
  }

  return String(a ?? "")===String(b ?? "");
}

function parseServiceAccount(){
  const raw=process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if(!raw){
    throw new Error("Hiányzik a FIREBASE_SERVICE_ACCOUNT_JSON környezeti változó.");
  }

  let sa;

  try{
    sa=JSON.parse(raw);
  }catch{
    throw new Error("A FIREBASE_SERVICE_ACCOUNT_JSON nem érvényes JSON.");
  }

  if(sa.private_key){
    sa.private_key=sa.private_key.replace(/\\n/g,"\n");
  }

  return sa;
}

function validateSettings(){
  if(
    !Number.isFinite(RELEASE_DELAY_HOURS) ||
    RELEASE_DELAY_HOURS<0 ||
    RELEASE_DELAY_HOURS>72
  ){
    throw new Error(
      "A RELEASE_DELAY_HOURS értéke 0 és 72 közötti egész szám legyen."
    );
  }
}

async function apiJson(url,label){
  const response=await fetch(url,{
    headers:{
      "User-Agent":"NB1-TippLiga-Sync/3.1"
    }
  });

  if(!response.ok){
    throw new Error(`${label}: HTTP ${response.status}`);
  }

  return response.json();
}

async function fetchEventsForRound(round){
  const url=new URL(
    `https://www.thesportsdb.com/api/v1/json/${API_KEY}/eventsround.php`
  );

  url.searchParams.set("id",LEAGUE_ID);
  url.searchParams.set("r",String(round));
  url.searchParams.set("s",SEASON);

  const data=await apiJson(
    url,
    `${round}. forduló lekérése`
  );

  return Array.isArray(data.events)
    ? data.events
    : [];
}

async function fetchEventById(id){
  const url=new URL(
    `https://www.thesportsdb.com/api/v1/json/${API_KEY}/lookupevent.php`
  );

  url.searchParams.set("id",String(id));

  const data=await apiJson(
    url,
    `Event ID ${id} lekérése`
  );

  return Array.isArray(data.events) && data.events.length
    ? data.events[0]
    : null;
}

function validApiEvent(e){
  if(!e?.idEvent) return false;

  if(
    e.idLeague &&
    String(e.idLeague)!==LEAGUE_ID
  ){
    return false;
  }

  if(
    e.strSeason &&
    String(e.strSeason)!==SEASON
  ){
    return false;
  }

  return true;
}

function putEvent(map,e){
  if(validApiEvent(e)){
    map.set(
      String(e.idEvent),
      e
    );
  }
}

async function loadExistingMatches(db){
  const snap=await db
    .collection("matches")
    .get();

  return snap.docs.map(
    d=>({
      id:d.id,
      ...d.data()
    })
  );
}

function getHighestExistingRound(matches){
  const rounds=matches
    .map(matchRound)
    .filter(Number.isFinite);

  return rounds.length
    ? Math.max(...rounds)
    : null;
}

function lookupCandidateIds(
  existingMatches,
  roundEvents,
  highestRound
){
  const ids=[];
  const seen=new Set();

  const add=id=>{
    const s=String(id||"").trim();

    if(
      s &&
      !seen.has(s)
    ){
      seen.add(s);
      ids.push(s);
    }
  };

  for(const e of roundEvents){
    if(
      eventRound(e)===highestRound
    ){
      add(e.idEvent);
    }
  }

  for(const m of existingMatches){
    if(!m.externalEventId){
      continue;
    }

    const hasResult=
      !!String(m.result||"").trim() &&
      !!String(m.outcome||"").trim();

    if(
      !hasResult ||
      matchRound(m)>=((highestRound??0)-1)
    ){
      add(m.externalEventId);
    }
  }

  return ids.slice(
    0,
    MAX_DIRECT_LOOKUPS
  );
}

async function fetchApiEvents(existingMatches){
  const byId=new Map();

  const highest=
    getHighestExistingRound(
      existingMatches
    );

  const rounds=
    highest===null
      ? [1,2]
      : [
          highest,
          highest+1
        ];

  const roundEvents=[];

  for(const round of rounds){
    try{
      const events=
        await fetchEventsForRound(
          round
        );

      roundEvents.push(
        ...events
      );

      events.forEach(
        e=>putEvent(byId,e)
      );

      console.log(
        `TheSportsDB körlekérés: ${round}. forduló | ${events.length} esemény.`
      );
    }catch(err){
      console.warn(
        `Figyelmeztetés: ${round}. forduló:`,
        err?.message||err
      );
    }
  }

  const ids=
    lookupCandidateIds(
      existingMatches,
      roundEvents,
      highest
    );

  console.log(
    `Közvetlen Event ID ellenőrzés: ${ids.length} meccs.`
  );

  for(const id of ids){
    try{
      const e=
        await fetchEventById(
          id
        );

      if(!e){
        console.warn(
          `Event ID ${id}: nincs esemény.`
        );
        continue;
      }

      if(!validApiEvent(e)){
        console.warn(
          `Event ID ${id}: nem ehhez az NB I szezonhoz tartozik.`
        );
        continue;
      }

      putEvent(
        byId,
        e
      );

      const score=
        e.intHomeScore!=null &&
        e.intAwayScore!=null
          ? `${e.intHomeScore}-${e.intAwayScore}`
          : "-";

      console.log(
        `Event ID ${id}: ` +
        `${e.strHomeTeam||"?"} – ${e.strAwayTeam||"?"} | ` +
        `státusz: ${normalizedStatus(e)||"-"} | eredmény: ${score}`
      );
    }catch(err){
      console.warn(
        `Figyelmeztetés: Event ID ${id}:`,
        err?.message||err
      );
    }
  }

  return [
    ...byId.values()
  ];
}

function buildMappedEvent(e){
  return {
    externalEventId:
      String(e.idEvent),

    externalSource:
      "thesportsdb",

    externalHomeTeam:
      e.strHomeTeam||"",

    externalAwayTeam:
      e.strAwayTeam||"",

    homeTeam:
      mapTeam(
        e.strHomeTeam
      ),

    awayTeam:
      mapTeam(
        e.strAwayTeam
      ),

    homeTeamExternalId:
      e.idHomeTeam
        ? String(e.idHomeTeam)
        : "",

    awayTeamExternalId:
      e.idAwayTeam
        ? String(e.idAwayTeam)
        : "",

    startDate:
      eventStartDate(e),

    round:
      eventRound(e),

    apiStatus:
      normalizedStatus(e),

    apiPostponed:
      apiPostponed(e),

    finalResult:
      resultFromEvent(e)
  };
}

function sameInternalMatch(
  existing,
  event
){
  return (
    normalizeText(
      existing.homeTeam
    )===
    normalizeText(
      event.homeTeam
    ) &&

    normalizeText(
      existing.awayTeam
    )===
    normalizeText(
      event.awayTeam
    ) &&

    matchRound(
      existing
    )===
    event.round
  );
}

function indexExistingMatches(matches){
  const map=new Map();

  for(const m of matches){
    if(m.externalEventId){
      map.set(
        String(
          m.externalEventId
        ),
        m
      );
    }
  }

  return map;
}

function findExistingMatch(
  event,
  matches,
  byId
){
  return (
    byId.get(
      event.externalEventId
    ) ||

    matches.find(
      m=>
        sameInternalMatch(
          m,
          event
        )
    ) ||

    null
  );
}

function groupEventsByRound(events){
  const grouped=
    new Map();

  for(const e of events){
    if(
      !Number.isFinite(e.round) ||
      !e.startDate ||
      !e.homeTeam ||
      !e.awayTeam
    ){
      continue;
    }

    if(
      !grouped.has(
        e.round
      )
    ){
      grouped.set(
        e.round,
        []
      );
    }

    grouped
      .get(e.round)
      .push(e);
  }

  for(
    const arr of
      grouped.values()
  ){
    arr.sort(
      (a,b)=>
        a.startDate-
        b.startDate
    );
  }

  return grouped;
}

function existingForEvent(
  event,
  existingMatches
){
  return (
    existingMatches.find(
      m=>
        String(
          m.externalEventId||
          ""
        )===
        event.externalEventId ||

        sameInternalMatch(
          m,
          event
        )
    ) ||

    null
  );
}

function eventCountsAsClosed(
  event,
  existingMatches
){
  if(
    ROUND_RELEASE_STATUSES.has(
      event.apiStatus
    )
  ){
    return true;
  }

  const existing=
    existingForEvent(
      event,
      existingMatches
    );

  return !!existing
    ?.postponedWithoutDate;
}

function isRoundComplete(
  roundEvents,
  existingMatches
){
  return (
    roundEvents.length===
      MATCHES_PER_ROUND &&

    roundEvents.every(
      e=>
        eventCountsAsClosed(
          e,
          existingMatches
        )
    )
  );
}

function roundReleaseTime(
  roundEvents
){
  return new Date(
    Math.max(
      ...roundEvents.map(
        e=>
          e.startDate
            .getTime()
      )
    ) +
    RELEASE_DELAY_HOURS*
      3600000
  );
}

function selectRoundForCreation(
  grouped,
  existingMatches
){
  const now=
    Date.now();

  const highest=
    getHighestExistingRound(
      existingMatches
    );

  if(highest===null){
    const first=
      [...grouped.entries()]
        .filter(
          ([,ev])=>
            ev.length===
              MATCHES_PER_ROUND &&

            ev.some(
              e=>
                e.startDate
                  .getTime()>=now
            )
        )
        .map(
          ([r])=>r
        )
        .sort(
          (a,b)=>a-b
        )[0] ??
      null;

    return {
      targetRound:first,

      reason:
        first===null
          ? "Nincs teljes, közelgő forduló."
          : "Még nincs meccs a Firestore-ban."
    };
  }

  const current=
    grouped.get(
      highest
    )||[];

  const existingCount=
    existingMatches.filter(
      m=>
        matchRound(m)===
        highest
    ).length;

  if(
    existingCount<
      MATCHES_PER_ROUND &&
    current.length===
      MATCHES_PER_ROUND
  ){
    return {
      targetRound:
        highest,

      reason:
        "A jelenlegi fordulóból hiányzik meccs a Firestore-ban."
    };
  }

  if(
    !isRoundComplete(
      current,
      existingMatches
    )
  ){
    return {
      targetRound:null,

      reason:
        "A jelenlegi forduló még nem zárult le."
    };
  }

  const releaseAt=
    roundReleaseTime(
      current
    );

  if(
    now<
    releaseAt.getTime()
  ){
    return {
      targetRound:null,

      reason:
        `A következő forduló csak ${formatLocalDate(releaseAt)} után jelenhet meg.`
    };
  }

  const next=
    highest+1;

  const nextEvents=
    grouped.get(
      next
    )||[];

  if(
    nextEvents.length!==
      MATCHES_PER_ROUND
  ){
    return {
      targetRound:null,

      reason:
        `A ${next}. fordulóból még nem érhető el mind a ${MATCHES_PER_ROUND} meccs.`
    };
  }

  return {
    targetRound:
      next,

    reason:
      "Az előző forduló lezárult, és letelt a megjelenési várakozás."
  };
}

function buildDesiredData(
  event,
  existing
){
  const locks=
    existing?.manualLocks||
    {};

  const desired={
    externalSource:
      "thesportsdb",

    externalEventId:
      event.externalEventId,

    homeTeamExternalId:
      event.homeTeamExternalId,

    awayTeamExternalId:
      event.awayTeamExternalId,

    apiStatus:
      event.apiStatus,

    apiManaged:
      true,

    published:
      true,

    roundId:
      String(
        event.round
      )
  };

  if(!locks.teams){
    desired.homeTeam=
      event.homeTeam;

    desired.awayTeam=
      event.awayTeam;
  }

  if(
    !locks.startTime &&
    event.startDate
  ){
    desired.startTime=
      event.startDate;
  }

  if(
    event.finalResult &&
    !locks.result
  ){
    desired.result=
      event.finalResult.result;

    desired.outcome=
      event.finalResult.outcome;

    desired.resultSource=
      "api";
  }

  if(
    !locks.postponed
  ){
    if(
      event.apiPostponed
    ){
      desired.postponed=
        true;

      desired.postponedWithoutDate=
        true;

      desired.postponementSource=
        "api";

      if(
        existing &&
        !existing.originalStartTime &&
        existing.startTime
      ){
        desired.originalStartTime=
          existing.startTime;
      }
    }else{
      desired.postponed=
        false;

      desired.postponedWithoutDate=
        false;

      desired.postponementSource=
        "";
    }
  }

  return desired;
}

function buildChangedFields(
  existing,
  desired
){
  const changes={};
  const changedKeys=[];

  for(
    const [key,next]
    of Object.entries(desired)
  ){
    const cur=
      existing?.[key];

    if(
      !valuesEqual(
        cur,
        next
      )
    ){
      changes[key]=
        next instanceof Date
          ? Timestamp.fromDate(
              next
            )
          : next;

      changedKeys.push(
        key
      );
    }
  }

  if(
    changedKeys.length
  ){
    changes.apiUpdatedAt=
      Timestamp.fromDate(
        new Date()
      );
  }

  return {
    changes,
    changedKeys
  };
}

function buildExistingPlans(
  mapped,
  existingMatches
){
  const byId=
    indexExistingMatches(
      existingMatches
    );

  const plans=[];

  for(
    const event of mapped
  ){
    if(
      !event.startDate ||
      !Number.isFinite(
        event.round
      )
    ){
      continue;
    }

    const existing=
      findExistingMatch(
        event,
        existingMatches,
        byId
      );

    if(!existing){
      continue;
    }

    const {
      changes,
      changedKeys
    }=
      buildChangedFields(
        existing,
        buildDesiredData(
          event,
          existing
        )
      );

    plans.push({
      event,
      existing,
      changes,
      changedKeys
    });
  }

  return plans;
}

function buildNewMatches(
  targetRound,
  grouped,
  existingMatches
){
  if(
    !Number.isFinite(
      targetRound
    )
  ){
    return [];
  }

  const byId=
    indexExistingMatches(
      existingMatches
    );

  return (
    grouped.get(
      targetRound
    )||[]
  ).filter(
    e=>
      !findExistingMatch(
        e,
        existingMatches,
        byId
      )
  );
}

function resultWasChanged(keys){
  return (
    keys.includes(
      "result"
    ) ||
    keys.includes(
      "outcome"
    )
  );
}

function applyChangesToLocalMatch(
  existing,
  changes
){
  for(
    const [k,v]
    of Object.entries(
      changes
    )
  ){
    existing[k]=v;
  }
}

async function executeExistingPlans(
  db,
  plans
){
  let changedCount=0;
  let resultChanged=false;

  for(const p of plans){
    if(
      !p.changedKeys.length
    ){
      continue;
    }

    await db
      .collection("matches")
      .doc(
        p.existing.id
      )
      .set(
        p.changes,
        {
          merge:true
        }
      );

    applyChangesToLocalMatch(
      p.existing,
      p.changes
    );

    changedCount++;

    if(
      resultWasChanged(
        p.changedKeys
      )
    ){
      resultChanged=true;
    }
  }

  return {
    changedCount,
    resultChanged
  };
}

function buildNewMatchDocument(
  event
){
  return {
    ...buildDesiredData(
      event,
      null
    ),

    startTime:
      Timestamp.fromDate(
        event.startDate
      ),

    createdAutomatically:
      true,

    odds:{},

    manualLocks:{
      teams:false,
      startTime:false,
      result:false,
      postponed:false
    },

    apiUpdatedAt:
      Timestamp.fromDate(
        new Date()
      )
  };
}

async function createNewMatches(
  db,
  newMatches,
  existingMatches
){
  let createdCount=0;
  let resultChanged=false;

  for(
    const event of
      newMatches
  ){
    if(
      !event.homeTeam ||
      !event.awayTeam
    ){
      throw new Error(
        `Ismeretlen csapat miatt nem hozható létre: ${event.externalEventId}`
      );
    }

    const id=
      `tsdb_${event.externalEventId}`;

    const data=
      buildNewMatchDocument(
        event
      );

    await db
      .collection("matches")
      .doc(id)
      .set(
        data,
        {
          merge:true
        }
      );

    existingMatches.push({
      id,
      ...data
    });

    createdCount++;

    if(
      event.finalResult
    ){
      resultChanged=true;
    }
  }

  return {
    createdCount,
    resultChanged
  };
}

function parseResult(v){
  const m=
    String(v||"")
      .match(
        /^\s*(\d+)\s*-\s*(\d+)\s*$/
      );

  return m
    ? [
        Number(m[1]),
        Number(m[2])
      ]
    : null;
}

function computeStandingsFromMatches(matches){
  const st={};

  for(
    const team of TEAMS
  ){
    st[team]={
      team,
      MP:0,
      W:0,
      D:0,
      L:0,
      GF:0,
      GA:0,
      GD:0,
      Pts:0
    };
  }

  for(
    const m of matches
  ){
    const h=
      m.homeTeam||
      m.home||
      "";

    const a=
      m.awayTeam||
      m.away||
      "";

    const r=
      parseResult(
        m.result
      );

    const H=st[h];
    const A=st[a];

    if(
      !H ||
      !A ||
      !r
    ){
      continue;
    }

    const [hg,ag]=r;

    H.MP++;
    A.MP++;

    H.GF+=hg;
    H.GA+=ag;

    A.GF+=ag;
    A.GA+=hg;

    H.GD=
      H.GF-
      H.GA;

    A.GD=
      A.GF-
      A.GA;

    if(hg>ag){
      H.W++;
      A.L++;
      H.Pts+=3;
    }else if(hg<ag){
      A.W++;
      H.L++;
      A.Pts+=3;
    }else{
      H.D++;
      A.D++;
      H.Pts++;
      A.Pts++;
    }
  }

  return Object
    .values(st)
    .sort(
      (a,b)=>
        b.Pts-a.Pts ||
        b.W-a.W ||
        b.GD-a.GD ||
        b.GF-a.GF ||
        a.team.localeCompare(
          b.team,
          "hu"
        )
    );
}

async function publishTable(
  db,
  matches
){
  await db
    .collection("computed")
    .doc("nb1_table")
    .set(
      {
        rows:
          computeStandingsFromMatches(
            matches
          ),

        updatedAt:
          Timestamp.fromDate(
            new Date()
          )
      },
      {
        merge:true
      }
    );
}

function printPreview({
  mappedEvents,
  existingPlans,
  newMatches,
  targetRound,
  targetReason
}){
  const changed=
    existingPlans.filter(
      p=>
        p.changedKeys.length
    );

  const unchanged=
    existingPlans.filter(
      p=>
        !p.changedKeys.length
    );

  console.log(
    "\nNB I szinkron – előnézet\n======================="
  );

  console.log(
    `Üzemmód: ${
      DRY_RUN
        ? "ELŐNÉZET, nincs Firestore-írás"
        : "ÉLES ÍRÁS"
    }`
  );

  console.log(
    `Újonnan publikálható forduló: ${
      targetRound ??
      "nincs"
    }`
  );

  console.log(
    `Döntés oka: ${targetReason}`
  );

  console.log(
    "\nTénylegesen módosítandó meglévő meccsek:"
  );

  if(
    !changed.length
  ){
    console.log(
      "- Nincs módosítandó meglévő meccs."
    );
  }

  for(
    const p of changed
  ){
    const e=
      p.event;

    const res=
      e.finalResult
        ? ` | eredmény: ${e.finalResult.result}`
        : "";

    console.log(
      `[MÓDOSÍTÁS] ${e.round}. forduló | ` +
      `${e.homeTeam||e.externalHomeTeam} – ` +
      `${e.awayTeam||e.externalAwayTeam} | ` +
      `mezők: ${p.changedKeys.join(", ")} | ` +
      `Event ID: ${e.externalEventId} | ` +
      `státusz: ${e.apiStatus||"-"}${res}`
    );
  }

  console.log(
    "\nÚjonnan létrehozandó meccsek:"
  );

  if(
    !newMatches.length
  ){
    console.log(
      "- Nincs új meccs."
    );
  }

  for(
    const e of newMatches
  ){
    console.log(
      `[ÚJ] ${e.round}. forduló | ` +
      `${e.homeTeam} – ${e.awayTeam} | ` +
      `${formatLocalDate(e.startDate)} | ` +
      `Event ID: ${e.externalEventId}`
    );
  }

  const unknown=
    mappedEvents.filter(
      e=>
        !e.homeTeam ||
        !e.awayTeam
    );

  if(
    unknown.length
  ){
    console.log(
      "\nIsmeretlen csapatnevek:"
    );

    unknown.forEach(
      e=>
        console.log(
          `- ${e.externalHomeTeam||"?"} – ` +
          `${e.externalAwayTeam||"?"} ` +
          `(${e.externalEventId})`
        )
    );
  }

  console.log(
    `\nMódosítandó meglévő meccs: ${changed.length}`
  );

  console.log(
    `Változatlan meglévő meccs: ${unchanged.length}`
  );

  console.log(
    `Új meccs: ${newMatches.length}`
  );

  console.log(
    `Ismeretlen csapat: ${unknown.length}`
  );
}

async function main(){
  validateSettings();

  initializeApp({
    credential:
      cert(
        parseServiceAccount()
      ),

    projectId:
      PROJECT_ID
  });

  const db=
    getFirestore();

  const existingMatches=
    await loadExistingMatches(
      db
    );

  const apiEvents=
    await fetchApiEvents(
      existingMatches
    );

  const mappedEvents=
    apiEvents.map(
      buildMappedEvent
    );

  const groupedEvents=
    groupEventsByRound(
      mappedEvents
    );

  const existingPlans=
    buildExistingPlans(
      mappedEvents,
      existingMatches
    );

  const {
    targetRound,
    reason:targetReason
  }=
    selectRoundForCreation(
      groupedEvents,
      existingMatches
    );

  const newMatches=
    buildNewMatches(
      targetRound,
      groupedEvents,
      existingMatches
    );

  printPreview({
    mappedEvents,
    existingPlans,
    newMatches,
    targetRound,
    targetReason
  });

  if(DRY_RUN){
    console.log(
      "\nNem történt Firestore-módosítás."
    );
    return;
  }

  const existingResult=
    await executeExistingPlans(
      db,
      existingPlans
    );

  const newResult=
    await createNewMatches(
      db,
      newMatches,
      existingMatches
    );

  const recompute=
    existingResult.resultChanged ||
    newResult.resultChanged;

  if(recompute){
    await publishTable(
      db,
      existingMatches
    );
  }

  console.log(
    `\n${existingResult.changedCount} meglévő meccs ténylegesen módosítva.`
  );

  console.log(
    `${newResult.createdCount} új meccs létrehozva.`
  );

  console.log(
    recompute
      ? "Az NB I tabella újraszámítása megtörtént."
      : "Nem változott eredmény, ezért a tabellát nem kellett újraírni."
  );
}

main().catch(
  error=>{
    console.error(
      "\nSZINKRON HIBA:"
    );

    console.error(
      error?.stack ||
      error?.message ||
      String(error)
    );

    process.exitCode=1;
  }
);
