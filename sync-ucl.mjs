import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const PROJECT_ID = "tippliga-4b3af";
const COMPETITION_CODE = "CL";
const SEASON = "2026";

const API_TOKEN = process.env.FOOTBALL_DATA_TOKEN || "";
const DRY_RUN = process.env.DRY_RUN !== "false";

const MATCHES_PER_LEAGUE_ROUND = 18;


/* =========================================================
   CSAPATNEVEK
========================================================= */

const TEAM_MAP = {
  "AS Roma": "Roma",
  "Arsenal FC": "Arsenal",
  "Aston Villa FC": "Aston Villa",
  "Borussia Dortmund": "Borussia Dortmund",
  "Club Atlético de Madrid": "Atlético Madrid",
  "Club Brugge KV": "Club Bruges",
  "Como 1907": "Como",
  "FC Barcelona": "Barcelona",
  "FC Bayern München": "Bayern München",
  "FC Internazionale Milano": "Internazionale",
  "FC Porto": "Porto",
  "FK Bodø/Glimt": "Bodø/Glimt",
  "FK Shakhtar Donetsk": "Shakhtar Donetsk",
  "Fenerbahçe SK": "Fenerbahçe",
  "Feyenoord Rotterdam": "Feyenoord",
  "Galatasaray SK": "Galatasaray",
  "LASK Linz": "LASK",
  "Lille OSC": "Lille",
  "Liverpool FC": "Liverpool",
  "Manchester City FC": "Manchester City",
  "Manchester United FC": "Manchester United",
  "PAE AEK": "AEK Athens",
  "PSV": "PSV",
  "Paris Saint-Germain FC": "Paris Saint-Germain",
  "RB Leipzig": "Leipzig",
  "Racing Club de Lens": "Lens",
  "Real Betis Balompié": "Real Betis",
  "Real Madrid CF": "Real Madrid",
  "SK Slavia Praha": "Slavia Praha",
  "SSC Napoli": "Napoli",
  "Sabah FK": "Sabah",
  "Sporting Clube de Portugal": "Sporting CP",
  "VfB Stuttgart": "Stuttgart",
  "Viking FK": "Viking",
  "Villarreal CF": "Villarreal",
  "ŠK Slovan Bratislava": "Slovan Bratislava"
};


/* =========================================================
   KIESÉSES KÖRÖK
========================================================= */

const KNOCKOUT_STAGE_MAP = new Map([
  ["PLAYOFF_ROUND", {
    roundId: 9,
    label: "Kieséses rájátszás",
    expected: 16
  }],

  ["PLAYOFFS", {
    roundId: 9,
    label: "Kieséses rájátszás",
    expected: 16
  }],

  ["KNOCKOUT_ROUND_PLAY_OFF", {
    roundId: 9,
    label: "Kieséses rájátszás",
    expected: 16
  }],

  ["KNOCKOUT_ROUND_PLAY_OFFS", {
    roundId: 9,
    label: "Kieséses rájátszás",
    expected: 16
  }],

  ["LAST_16", {
    roundId: 10,
    label: "Nyolcaddöntő",
    expected: 16
  }],

  ["ROUND_OF_16", {
    roundId: 10,
    label: "Nyolcaddöntő",
    expected: 16
  }],

  ["QUARTER_FINALS", {
    roundId: 11,
    label: "Negyeddöntő",
    expected: 8
  }],

  ["SEMI_FINALS", {
    roundId: 12,
    label: "Elődöntő",
    expected: 4
  }],

  ["FINAL", {
    roundId: 13,
    label: "Döntő",
    expected: 1
  }]
]);


/* =========================================================
   FIREBASE
========================================================= */

function parseServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!raw) {
    throw new Error(
      "Hiányzik a FIREBASE_SERVICE_ACCOUNT_JSON."
    );
  }

  let account;

  try {
    account = JSON.parse(raw);
  } catch {
    throw new Error(
      "A FIREBASE_SERVICE_ACCOUNT_JSON nem érvényes JSON."
    );
  }

  if (account.private_key) {
    account.private_key =
      account.private_key.replace(/\\n/g, "\n");
  }

  return account;
}


function validateSettings() {
  if (!API_TOKEN) {
    throw new Error(
      "Hiányzik a FOOTBALL_DATA_TOKEN."
    );
  }
}


/* =========================================================
   SEGÉDFÜGGVÉNYEK
========================================================= */

function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("hu")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}


function mapTeam(externalName) {
  return (
    TEAM_MAP[
      String(externalName || "").trim()
    ] || null
  );
}


function formatLocalDate(date) {
  return new Intl.DateTimeFormat(
    "hu-HU",
    {
      timeZone: "Europe/Budapest",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }
  ).format(date);
}


/* =========================================================
   FORDULÓ / STAGE
========================================================= */

function stageInfo(match) {
  const stage =
    String(match.stage || "")
      .trim()
      .toUpperCase();

  if (stage === "LEAGUE_STAGE") {
    const matchday =
      Number.parseInt(
        match.matchday,
        10
      );

    if (
      Number.isFinite(matchday) &&
      matchday >= 1 &&
      matchday <= 8
    ) {
      return {
        roundId: matchday,
        label: `${matchday}. forduló`,
        expected: MATCHES_PER_LEAGUE_ROUND,
        stage
      };
    }

    return null;
  }

  const knockout =
    KNOCKOUT_STAGE_MAP.get(stage);

  if (!knockout) {
    return null;
  }

  return {
    ...knockout,
    stage
  };
}


/* =========================================================
   EREDMÉNY
========================================================= */

function isFinishedStatus(status) {
  return (
    String(status || "").toUpperCase() ===
    "FINISHED"
  );
}


function scorePair(obj) {
  if (!obj) {
    return null;
  }

  const home = Number(obj.home);
  const away = Number(obj.away);

  if (
    !Number.isFinite(home) ||
    !Number.isFinite(away)
  ) {
    return null;
  }

  return {
    home,
    away
  };
}


/*
  A TippLiga "result" mezője a rendes játékidős
  eredmény.

  Kieséses meccsnél hosszabbítás esetén
  először regularTime értéket keresünk.
*/

function resultFromApi(match) {
  if (!isFinishedStatus(match.status)) {
    return null;
  }

  const duration =
    String(
      match.score?.duration || ""
    ).toUpperCase();

  const regular =
    scorePair(
      match.score?.regularTime
    );

  if (regular) {
    return {
      result:
        `${regular.home}-${regular.away}`,

      outcome:
        regular.home > regular.away
          ? "1"
          : regular.home < regular.away
            ? "2"
            : "X"
    };
  }

  if (
    match.stage === "LEAGUE_STAGE" ||
    duration === "" ||
    duration === "REGULAR"
  ) {
    const fullTime =
      scorePair(
        match.score?.fullTime
      );

    if (!fullTime) {
      return null;
    }

    return {
      result:
        `${fullTime.home}-${fullTime.away}`,

      outcome:
        fullTime.home > fullTime.away
          ? "1"
          : fullTime.home < fullTime.away
            ? "2"
            : "X"
    };
  }

  return null;
}


/*
  Kieséses szakasz teljes végeredménye.
*/

function finalResultFromApi(match) {
  if (!isFinishedStatus(match.status)) {
    return null;
  }

  const fullTime =
    scorePair(
      match.score?.fullTime
    );

  if (!fullTime) {
    return null;
  }

  const penalties =
    scorePair(
      match.score?.penalties
    );

  const duration =
    String(
      match.score?.duration || ""
    ).toUpperCase();

  return {
    finalResult:
      `${fullTime.home}-${fullTime.away}`,

    decidedBy:
      penalties
        ? "pens"
        : duration === "EXTRA_TIME"
          ? "aet"
          : "regular",

    pensScore:
      penalties
        ? `${penalties.home}-${penalties.away}`
        : ""
  };
}


/* =========================================================
   FOOTBALL-DATA API
========================================================= */

async function fetchSeasonMatches() {
  const url =
    new URL(
      `https://api.football-data.org/v4/competitions/${COMPETITION_CODE}/matches`
    );

  url.searchParams.set(
    "season",
    SEASON
  );

  const response =
    await fetch(
      url,
      {
        headers: {
          "X-Auth-Token":
            API_TOKEN,

          "User-Agent":
            "Tippliga-UCL-Sync/2.0"
        }
      }
    );

  if (!response.ok) {
    const text =
      await response.text();

    throw new Error(
      `football-data.org hiba ${response.status}: ${text.slice(0, 500)}`
    );
  }

  const data =
    await response.json();

  return Array.isArray(data.matches)
    ? data.matches
    : [];
}


/* =========================================================
   API → BELSŐ ADAT
========================================================= */

function buildMappedEvent(match) {
  const info =
    stageInfo(match);

  if (!info) {
    return null;
  }

  const startDate =
    new Date(
      match.utcDate
    );

  return {
    externalEventId:
      String(match.id),

    externalSource:
      "football-data.org",

    externalHomeTeam:
      match.homeTeam?.name || "",

    externalAwayTeam:
      match.awayTeam?.name || "",

    homeTeam:
      mapTeam(
        match.homeTeam?.name
      ),

    awayTeam:
      mapTeam(
        match.awayTeam?.name
      ),

    homeTeamExternalId:
      match.homeTeam?.id
        ? String(match.homeTeam.id)
        : "",

    awayTeamExternalId:
      match.awayTeam?.id
        ? String(match.awayTeam.id)
        : "",

    startDate:
      Number.isNaN(
        startDate.getTime()
      )
        ? null
        : startDate,

    round:
      info.roundId,

    stage:
      info.stage,

    stageLabel:
      info.label,

    expectedInStage:
      info.expected,

    apiStatus:
      String(
        match.status || ""
      ).toUpperCase(),

    apiLastUpdated:
      match.lastUpdated || "",

    final90:
      resultFromApi(match),

    finalOverall:
      finalResultFromApi(match)
  };
}


/* =========================================================
   FIRESTORE BEOLVASÁS
========================================================= */

async function loadExistingMatches(db) {
  const snapshot =
    await db
      .collection("ucl_matches")
      .get();

  return snapshot.docs.map(
    document => ({
      id: document.id,
      ...document.data()
    })
  );
}


function matchRound(match) {
  const round =
    Number.parseInt(
      match.roundId ??
      match.round ??
      "",
      10
    );

  return Number.isFinite(round)
    ? round
    : null;
}


/* =========================================================
   DUPLIKÁCIÓVÉDELEM
========================================================= */

function indexExisting(existingMatches) {
  const map =
    new Map();

  for (const match of existingMatches) {
    const externalId =
      match.externalEventId ??
      match.apiMatchId ??
      "";

    if (externalId !== "") {
      map.set(
        String(externalId),
        match
      );
    }
  }

  return map;
}


function sameInternalMatch(
  existing,
  event
) {
  return (
    normalizeText(existing.homeTeam) ===
      normalizeText(event.homeTeam)
    &&
    normalizeText(existing.awayTeam) ===
      normalizeText(event.awayTeam)
    &&
    matchRound(existing) ===
      event.round
  );
}


function findExistingMatch(
  event,
  existingMatches,
  byExternalId
) {
  return (
    byExternalId.get(
      event.externalEventId
    )
    ||
    existingMatches.find(
      match =>
        sameInternalMatch(
          match,
          event
        )
    )
    ||
    null
  );
}


/* =========================================================
   FORDULÓK CSOPORTOSÍTÁSA
========================================================= */

function groupEvents(events) {
  const grouped =
    new Map();

  for (const event of events) {
    if (
      !event ||
      !Number.isFinite(event.round) ||
      !event.startDate ||
      !event.homeTeam ||
      !event.awayTeam
    ) {
      continue;
    }

    if (!grouped.has(event.round)) {
      grouped.set(
        event.round,
        []
      );
    }

    grouped
      .get(event.round)
      .push(event);
  }

  for (
    const matches
    of grouped.values()
  ) {
    matches.sort(
      (a, b) =>
        a.startDate -
        b.startDate
    );
  }

  return grouped;
}


/* =========================================================
   AKTUÁLIS KÖR
========================================================= */

function getHighestExistingRound(
  existingMatches
) {
  const rounds =
    existingMatches
      .map(matchRound)
      .filter(Number.isFinite);

  return rounds.length
    ? Math.max(...rounds)
    : null;
}


function existingRoundMatches(
  existingMatches,
  round
) {
  return existingMatches.filter(
    match =>
      matchRound(match) === round
  );
}


/* =========================================================
   KÉSZ-E A FORDULÓ?
========================================================= */

function eventHasUsableResult(event) {
  return !!event?.final90?.result;
}


function firestoreMatchHasResult(match) {
  return (
    /^\s*\d+\s*-\s*\d+\s*$/
      .test(
        String(
          match?.result || ""
        )
      )
  );
}


function currentRoundComplete(
  round,
  grouped,
  existingMatches
) {
  const apiEvents =
    grouped.get(round) || [];

  const stored =
    existingRoundMatches(
      existingMatches,
      round
    );

  const expected =
    apiEvents[0]?.expectedInStage
    ??
    (
      round <= 8
        ? MATCHES_PER_LEAGUE_ROUND
        : null
    );

  if (!Number.isFinite(expected)) {
    return false;
  }

  if (stored.length < expected) {
    return false;
  }

  if (apiEvents.length !== expected) {
    return false;
  }

  const byExternalId =
    indexExisting(
      existingMatches
    );

  for (const event of apiEvents) {
    const storedMatch =
      findExistingMatch(
        event,
        existingMatches,
        byExternalId
      );

    if (
      !firestoreMatchHasResult(storedMatch) &&
      !eventHasUsableResult(event)
    ) {
      return false;
    }
  }

  return true;
}


/* =========================================================
   MELYIK KÖR KERÜLHET FEL?
========================================================= */

function selectRoundForCreation(
  grouped,
  existingMatches
) {
  const highest =
    getHighestExistingRound(
      existingMatches
    );

  /*
    Ha teljesen üres a BL,
    kizárólag az 1. forduló kerülhet fel.
  */

  if (highest === null) {
    const first =
      grouped.get(1) || [];

    if (
      first.length !==
      MATCHES_PER_LEAGUE_ROUND
    ) {
      return {
        targetRound: null,

        reason:
          `Az 1. fordulóból nem érhető el mind a ${MATCHES_PER_LEAGUE_ROUND} meccs.`
      };
    }

    return {
      targetRound: 1,

      reason:
        "Még nincs BL-meccs a Firestore-ban, ezért az 1. forduló jöhet."
    };
  }

  const currentApi =
    grouped.get(highest) || [];

  const expected =
    currentApi[0]?.expectedInStage
    ??
    (
      highest <= 8
        ? MATCHES_PER_LEAGUE_ROUND
        : null
    );

  const storedCurrent =
    existingRoundMatches(
      existingMatches,
      highest
    );

  /*
    Ha ugyanabból a körből hiányzik meccs,
    csak azt pótoljuk.
  */

  if (
    Number.isFinite(expected) &&
    currentApi.length === expected &&
    storedCurrent.length < expected
  ) {
    return {
      targetRound: highest,

      reason:
        "A jelenlegi BL-körből hiányzik meccs a Firestore-ban."
    };
  }

  /*
    A következő kör addig nem jöhet,
    amíg nincs meg minden eredmény.
  */

  if (
    !currentRoundComplete(
      highest,
      grouped,
      existingMatches
    )
  ) {
    return {
      targetRound: null,

      reason:
        "A jelenlegi BL-kör összes eredménye még nincs meg."
    };
  }

  const nextRound =
    highest + 1;

  const nextApi =
    grouped.get(nextRound) || [];

  if (nextApi.length === 0) {
    return {
      targetRound: null,

      reason:
        "A következő BL-kör párosításai még nem érhetők el az API-ban."
    };
  }

  const nextExpected =
    nextApi[0]?.expectedInStage;

  if (
    Number.isFinite(nextExpected) &&
    nextApi.length !== nextExpected
  ) {
    return {
      targetRound: null,

      reason:
        `A következő BL-kör még nem teljes az API-ban (${nextApi.length}/${nextExpected} meccs).`
    };
  }

  return {
    targetRound: nextRound,

    reason:
      "Az előző BL-kör minden eredménye megvan, és a következő kör teljesen elérhető."
  };
}


/* =========================================================
   MEGLÉVŐ MECCSEK KERESÉSE
========================================================= */

function buildExistingUpdates(
  mappedEvents,
  existingMatches
) {
  const byExternalId =
    indexExisting(
      existingMatches
    );

  const updates = [];

  for (const event of mappedEvents) {
    if (
      !event ||
      !event.startDate
    ) {
      continue;
    }

    const existing =
      findExistingMatch(
        event,
        existingMatches,
        byExternalId
      );

    if (!existing) {
      continue;
    }

    updates.push({
      event,
      existing,

      linkedBy:
        String(
          existing.externalEventId ??
          existing.apiMatchId ??
          ""
        ) ===
        event.externalEventId
          ? "event-id"
          : "teams"
    });
  }

  return updates;
}


/* =========================================================
   ÚJ MECCSEK
========================================================= */

function buildNewMatches(
  targetRound,
  grouped,
  existingMatches
) {
  if (
    !Number.isFinite(
      targetRound
    )
  ) {
    return [];
  }

  const byExternalId =
    indexExisting(
      existingMatches
    );

  return (
    grouped.get(targetRound) || []
  ).filter(
    event =>
      !findExistingMatch(
        event,
        existingMatches,
        byExternalId
      )
  );
}


/* =========================================================
   ÚJ MECCS ADATAI

   Itt kerül be:
   - roundId
   - odds {}
   - published
   stb.

   Ezeket a későbbi API-frissítés már NEM módosítja.
========================================================= */

function buildNewMatchData(event) {
  const data = {
    homeTeam:
      event.homeTeam,

    awayTeam:
      event.awayTeam,

    startTime:
      Timestamp.fromDate(
        event.startDate
      ),

    roundId:
      String(event.round),

    odds: {},

    published:
      true,

    externalSource:
      "football-data.org",

    externalEventId:
      event.externalEventId,

    apiMatchId:
      Number(
        event.externalEventId
      ),

    homeTeamExternalId:
      event.homeTeamExternalId,

    awayTeamExternalId:
      event.awayTeamExternalId,

    apiStatus:
      event.apiStatus,

    apiStage:
      event.stage,

    apiStageLabel:
      event.stageLabel,

    apiLastUpdated:
      event.apiLastUpdated,

    apiUpdatedAt:
      Timestamp.fromDate(
        new Date()
      ),

    apiManaged:
      true,

    createdAutomatically:
      true,

    manualLocks: {
      teams: false,
      startTime: false,
      result: false
    }
  };

  if (event.final90) {
    data.result =
      event.final90.result;

    data.outcome =
      event.final90.outcome;
  }

  if (
    event.finalOverall &&
    event.round >= 9
  ) {
    data.finalResult =
      event.finalOverall.finalResult;

    data.decidedBy =
      event.finalOverall.decidedBy;

    data.pensScore =
      event.finalOverall.pensScore;
  }

  return data;
}


/* =========================================================
   BIZTONSÁGOS MEGLÉVŐ-MECCS FRISSÍTÉS

   SZÁNDÉKOSAN NINCS BENNE:

   - odds
   - published
   - roundId
   - tippek
   - stake
   - bármely más saját mező
========================================================= */

function buildExistingUpdateData(
  event,
  existing
) {
  const locks =
    existing.manualLocks || {};

  /*
    Ezek az API technikai mezők
    biztonságosan frissíthetők.
  */

  const data = {
    externalSource:
      "football-data.org",

    externalEventId:
      event.externalEventId,

    apiMatchId:
      Number(
        event.externalEventId
      ),

    homeTeamExternalId:
      event.homeTeamExternalId,

    awayTeamExternalId:
      event.awayTeamExternalId,

    apiStatus:
      event.apiStatus,

    apiStage:
      event.stage,

    apiStageLabel:
      event.stageLabel,

    apiLastUpdated:
      event.apiLastUpdated,

    apiUpdatedAt:
      Timestamp.fromDate(
        new Date()
      ),

    apiManaged:
      true
  };


  /*
    CSAPATOK

    Csak akkor frissülnek,
    ha nincs kézzel lezárva.
  */

  if (
    !locks.teams &&
    event.homeTeam &&
    event.awayTeam
  ) {
    data.homeTeam =
      event.homeTeam;

    data.awayTeam =
      event.awayTeam;
  }


  /*
    KEZDÉSI IDŐ

    Csak akkor frissül,
    ha nincs kézzel lezárva.
  */

  if (
    !locks.startTime &&
    event.startDate
  ) {
    data.startTime =
      Timestamp.fromDate(
        event.startDate
      );
  }


  /*
    EREDMÉNY

    Csak akkor frissül,
    ha nincs kézzel lezárva.
  */

  if (
    !locks.result &&
    event.final90
  ) {
    data.result =
      event.final90.result;

    data.outcome =
      event.final90.outcome;
  }


  /*
    Kieséses teljes végeredmény.
  */

  if (
    !locks.result &&
    event.finalOverall &&
    event.round >= 9
  ) {
    data.finalResult =
      event.finalOverall.finalResult;

    data.decidedBy =
      event.finalOverall.decidedBy;

    data.pensScore =
      event.finalOverall.pensScore;
  }

  return data;
}


/* =========================================================
   MEGLÉVŐ MECCSEK FRISSÍTÉSE
========================================================= */

async function updateExistingMatches(
  db,
  updates
) {
  for (const item of updates) {
    const data =
      buildExistingUpdateData(
        item.event,
        item.existing
      );

    await db
      .collection(
        "ucl_matches"
      )
      .doc(
        item.existing.id
      )
      .set(
        data,
        {
          merge: true
        }
      );
  }
}


/* =========================================================
   ÚJ MECCSEK LÉTREHOZÁSA
========================================================= */

async function createNewMatches(
  db,
  newMatches
) {
  for (const event of newMatches) {
    if (
      !event.homeTeam ||
      !event.awayTeam
    ) {
      throw new Error(
        `Ismeretlen csapat miatt nem hozható létre: ${event.externalEventId}`
      );
    }

    await db
      .collection(
        "ucl_matches"
      )
      .doc(
        `fd_${event.externalEventId}`
      )
      .set(
        buildNewMatchData(event),
        {
          merge: true
        }
      );
  }
}


/* =========================================================
   ELŐNÉZET
========================================================= */

function printPreview({
  rawCount,
  mappedEvents,
  existingUpdates,
  newMatches,
  targetRound,
  targetReason
}) {
  const validEvents =
    mappedEvents.filter(Boolean);

  const unknownTeams =
    validEvents.filter(
      event =>
        !event.homeTeam ||
        !event.awayTeam
    );

  console.log("");
  console.log(
    "BL szinkron – football-data.org"
  );
  console.log(
    "=============================="
  );

  console.log(
    `Üzemmód: ${
      DRY_RUN
        ? "ELŐNÉZET, nincs Firestore-írás"
        : "ÉLES ÍRÁS"
    }`
  );

  console.log(
    `API-meccsek összesen: ${rawCount}`
  );

  console.log(
    `Kezelt BL-meccsek: ${validEvents.length}`
  );

  console.log(
    `Újonnan létrehozható kör: ${
      targetRound ?? "nincs"
    }`
  );

  console.log(
    `Döntés oka: ${targetReason}`
  );

  console.log("");

  console.log(
    "Meglévő meccsek API-frissítése:"
  );

  if (
    existingUpdates.length === 0
  ) {
    console.log(
      "- Nincs frissíthető meglévő meccs."
    );
  }

  for (const item of existingUpdates) {
    const event =
      item.event;

    const resultText =
      event.final90
        ? ` | eredmény: ${event.final90.result}`
        : "";

    console.log(
      `[${item.linkedBy === "event-id"
        ? "FRISSÍTÉS"
        : "ÖSSZEKAPCSOLÁS"}] ` +
      `${event.stageLabel} | ` +
      `${event.homeTeam || event.externalHomeTeam} – ` +
      `${event.awayTeam || event.externalAwayTeam} | ` +
      `${formatLocalDate(event.startDate)} | ` +
      `API ID: ${event.externalEventId} | ` +
      `${event.apiStatus || "-"}${resultText}`
    );
  }

  console.log("");

  console.log(
    "Újonnan létrehozandó meccsek:"
  );

  if (
    newMatches.length === 0
  ) {
    console.log(
      "- Nincs új meccs."
    );
  }

  for (const event of newMatches) {
    console.log(
      `[ÚJ] ${event.stageLabel} | ` +
      `${event.homeTeam} – ` +
      `${event.awayTeam} | ` +
      `${formatLocalDate(event.startDate)} | ` +
      `API ID: ${event.externalEventId}`
    );
  }

  if (
    unknownTeams.length > 0
  ) {
    console.log("");
    console.log(
      "ISMERETLEN CSAPATNEVEK:"
    );

    for (const event of unknownTeams) {
      console.log(
        `- ${event.externalHomeTeam || "?"} – ` +
        `${event.externalAwayTeam || "?"} ` +
        `(API ID: ${event.externalEventId})`
      );
    }
  }

  console.log("");

  console.log(
    `Meglévő meccs frissítése/összekapcsolása: ${existingUpdates.length}`
  );

  console.log(
    `Új meccs létrehozása: ${newMatches.length}`
  );

  console.log(
    `Ismeretlen csapat: ${unknownTeams.length}`
  );
}


/* =========================================================
   MAIN
========================================================= */

async function main() {
  validateSettings();

  const serviceAccount =
    parseServiceAccount();

  initializeApp({
    credential:
      cert(serviceAccount),

    projectId:
      PROJECT_ID
  });

  const db =
    getFirestore();

  const [
    apiMatches,
    existingMatches
  ] =
    await Promise.all([
      fetchSeasonMatches(),
      loadExistingMatches(db)
    ]);

  const mappedEvents =
    apiMatches.map(
      buildMappedEvent
    );

  const validEvents =
    mappedEvents.filter(Boolean);

  const grouped =
    groupEvents(
      validEvents
    );

  const existingUpdates =
    buildExistingUpdates(
      validEvents,
      existingMatches
    );

  const {
    targetRound,
    reason: targetReason
  } =
    selectRoundForCreation(
      grouped,
      existingMatches
    );

  const newMatches =
    buildNewMatches(
      targetRound,
      grouped,
      existingMatches
    );

  printPreview({
    rawCount:
      apiMatches.length,

    mappedEvents,
    existingUpdates,
    newMatches,
    targetRound,
    targetReason
  });


  if (DRY_RUN) {
    console.log("");
    console.log(
      "Nem történt Firestore-módosítás."
    );
    return;
  }


  await updateExistingMatches(
    db,
    existingUpdates
  );


  await createNewMatches(
    db,
    newMatches
  );


  console.log("");

  console.log(
    `${existingUpdates.length} meglévő BL-meccs biztonságosan frissítve.`
  );

  console.log(
    `${newMatches.length} új BL-meccs létrehozva.`
  );
}


/* =========================================================
   INDÍTÁS
========================================================= */

main().catch(error => {
  console.error("");
  console.error(
    "BL SZINKRON HIBA:"
  );

  console.error(
    error?.stack ||
    error?.message ||
    String(error)
  );

  process.exitCode = 1;
});
