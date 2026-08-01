import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const PROJECT_ID = "tippliga-4b3af";
const LEAGUE_ID = "4690";
const SEASON = "2026-2027";
const API_KEY = process.env.THESPORTSDB_API_KEY || "123";
const LOOKAHEAD_DAYS = Number.parseInt(process.env.LOOKAHEAD_DAYS || "14", 10);
const DRY_RUN = process.env.DRY_RUN !== "false";

const TEAM_ALIASES = {
  "debrecen": "Debreceni VSC",
  "debreceni vsc": "Debreceni VSC",

  "budapest honved": "Kispest-Honvéd FC",
  "budapest honved fc": "Kispest-Honvéd FC",
  "honved": "Kispest-Honvéd FC",
  "kispest honved": "Kispest-Honvéd FC",
  "kispest honved fc": "Kispest-Honvéd FC",

  "ferencvaros": "Ferencváros",
  "ferencvarosi tc": "Ferencváros",
  "ferencvaros tc": "Ferencváros",

  "gyori eto": "ETO FC Győr",
  "gyori eto fc": "ETO FC Győr",
  "eto fc gyor": "ETO FC Győr",

  "vasas": "Vasas FC",
  "vasas fc": "Vasas FC",

  "kisvarda": "Kisvárda FC",
  "kisvarda fc": "Kisvárda FC",

  "mtk": "MTK Budapest",
  "mtk budapest": "MTK Budapest",

  "nyiregyhaza": "Nyíregyháza Spartacus",
  "nyiregyhaza spartacus": "Nyíregyháza Spartacus",

  "paks": "Paksi FC",
  "paksi fc": "Paksi FC",

  "puskas akademia": "Puskás Akadémia",
  "puskas akademia fc": "Puskás Akadémia",

  "ujpest": "Újpest FC",
  "ujpest fc": "Újpest FC",

  "zalaegerszeg": "Zalaegerszegi TE FC",
  "zalaegerszegi te": "Zalaegerszegi TE FC",
  "zalaegerszegi te fc": "Zalaegerszegi TE FC"
};

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
  return TEAM_ALIASES[normalizeText(externalName)] || null;
}

function parseServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!raw) {
    throw new Error(
      "Hiányzik a FIREBASE_SERVICE_ACCOUNT_JSON környezeti változó."
    );
  }

  let serviceAccount;

  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    throw new Error(
      "A FIREBASE_SERVICE_ACCOUNT_JSON nem érvényes JSON."
    );
  }

  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }

  return serviceAccount;
}

function budapestDateString(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Budapest",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts
      .filter(part => part.type !== "literal")
      .map(part => [part.type, part.value])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function addUtcDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function eventStartDate(event) {
  if (event.strTimestamp) {
    const parsed = new Date(event.strTimestamp);

    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  const localDate = event.dateEventLocal || event.dateEvent;
  const localTime = event.strTimeLocal || event.strTime || "00:00:00";

  if (!localDate) {
    return null;
  }

  const parsed = new Date(`${localDate}T${localTime}+02:00`);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function eventRound(event) {
  const value = Number.parseInt(event.intRound, 10);
  return Number.isFinite(value) ? value : null;
}

function hasFinalResult(event) {
  return (
    event.strStatus === "FT" &&
    event.intHomeScore !== null &&
    event.intAwayScore !== null &&
    Number.isFinite(Number(event.intHomeScore)) &&
    Number.isFinite(Number(event.intAwayScore))
  );
}

function resultFromEvent(event) {
  if (!hasFinalResult(event)) {
    return null;
  }

  const home = Number(event.intHomeScore);
  const away = Number(event.intAwayScore);

  return {
    result: `${home}-${away}`,
    outcome: home > away ? "1" : home < away ? "2" : "X"
  };
}

async function fetchEventsForDate(dateString) {
  const url = new URL(
    `https://www.thesportsdb.com/api/v1/json/${API_KEY}/eventsday.php`
  );

  url.searchParams.set("d", dateString);
  url.searchParams.set("l", LEAGUE_ID);

  const response = await fetch(url, {
    headers: {
      "User-Agent": "NB1-TippLiga-Sync/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(
      `TheSportsDB hiba ${response.status} a következő napnál: ${dateString}`
    );
  }

  const data = await response.json();

  return Array.isArray(data.events) ? data.events : [];
}

async function fetchUpcomingEvents() {
  const today = new Date();
  const byEventId = new Map();

  for (let offset = 0; offset <= LOOKAHEAD_DAYS; offset += 1) {
    const dateString = budapestDateString(addUtcDays(today, offset));
    const events = await fetchEventsForDate(dateString);

    for (const event of events) {
      if (
        String(event.idLeague || "") !== LEAGUE_ID ||
        String(event.strSeason || "") !== SEASON ||
        !event.idEvent
      ) {
        continue;
      }

      byEventId.set(String(event.idEvent), event);
    }
  }

  return Array.from(byEventId.values());
}

function buildMappedEvent(event) {
  const homeTeam = mapTeam(event.strHomeTeam);
  const awayTeam = mapTeam(event.strAwayTeam);
  const startDate = eventStartDate(event);
  const round = eventRound(event);

  return {
    externalEventId: String(event.idEvent),
    externalSource: "thesportsdb",
    externalHomeTeam: event.strHomeTeam || "",
    externalAwayTeam: event.strAwayTeam || "",
    homeTeam,
    awayTeam,
    homeTeamExternalId: event.idHomeTeam ? String(event.idHomeTeam) : "",
    awayTeamExternalId: event.idAwayTeam ? String(event.idAwayTeam) : "",
    startDate,
    round,
    apiStatus: event.strStatus || "",
    finalResult: resultFromEvent(event)
  };
}

function sameInternalMatch(existing, event) {
  return (
    normalizeText(existing.homeTeam) === normalizeText(event.homeTeam) &&
    normalizeText(existing.awayTeam) === normalizeText(event.awayTeam) &&
    String(existing.roundId ?? existing.round ?? "") === String(event.round)
  );
}

async function loadExistingMatches(db) {
  const snapshot = await db.collection("matches").get();

  return snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));
}

function classifyEvents(mappedEvents, existingMatches) {
  const byExternalId = new Map();

  for (const match of existingMatches) {
    if (match.externalEventId) {
      byExternalId.set(String(match.externalEventId), match);
    }
  }

  const unknownTeams = [];
  const candidates = [];

  for (const event of mappedEvents) {
    if (!event.homeTeam || !event.awayTeam) {
      unknownTeams.push(event);
      continue;
    }

    if (!event.startDate || !event.round) {
      continue;
    }

    const exact = byExternalId.get(event.externalEventId);
    const fallback = existingMatches.find(match =>
      sameInternalMatch(match, event)
    );

    candidates.push({
      ...event,
      existingMatch: exact || fallback || null,
      matchType: exact
        ? "existing-by-event-id"
        : fallback
          ? "existing-by-teams"
          : "new"
    });
  }

  return {
    candidates,
    unknownTeams
  };
}

function selectNextRound(candidates) {
  const rounds = candidates
    .map(item => item.round)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (rounds.length === 0) {
    return {
      targetRound: null,
      matches: []
    };
  }

  const targetRound = rounds[0];

  return {
    targetRound,
    matches: candidates.filter(item => item.round === targetRound)
  };
}

function formatLocalDate(date) {
  return new Intl.DateTimeFormat("hu-HU", {
    timeZone: "Europe/Budapest",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function printPreview(targetRound, matches, unknownTeams) {
  console.log("");
  console.log("NB I szinkron – előnézet");
  console.log("=======================");
  console.log(`Üzemmód: ${DRY_RUN ? "ELŐNÉZET, nincs Firestore-írás" : "ÉLES ÍRÁS"}`);
  console.log(`Vizsgált időszak: ma + ${LOOKAHEAD_DAYS} nap`);
  console.log(`Kiválasztott forduló: ${targetRound ?? "nincs"}`);
  console.log("");

  if (matches.length === 0) {
    console.log("Nem található importálható mérkőzés.");
  }

  for (const match of matches) {
    const marker =
      match.matchType === "new"
        ? "ÚJ"
        : match.matchType === "existing-by-event-id"
          ? "FRISSÍTÉS"
          : "ÖSSZEKAPCSOLÁS";

    console.log(
      `[${marker}] ${match.round}. forduló | ` +
      `${match.homeTeam} – ${match.awayTeam} | ` +
      `${formatLocalDate(match.startDate)} | ` +
      `Event ID: ${match.externalEventId} | ` +
      `státusz: ${match.apiStatus || "-"}`
    );
  }

  if (unknownTeams.length > 0) {
    console.log("");
    console.log("Ismeretlen csapatnevek:");

    for (const event of unknownTeams) {
      console.log(
        `- ${event.externalHomeTeam || "?"} – ${event.externalAwayTeam || "?"} ` +
        `(Event ID: ${event.externalEventId})`
      );
    }
  }

  const newCount = matches.filter(match => match.matchType === "new").length;
  const linkCount = matches.filter(
    match => match.matchType === "existing-by-teams"
  ).length;
  const updateCount = matches.filter(
    match => match.matchType === "existing-by-event-id"
  ).length;

  console.log("");
  console.log(`Új meccs: ${newCount}`);
  console.log(`Meglévő meccs összekapcsolása: ${linkCount}`);
  console.log(`Meglévő API-meccs frissítése: ${updateCount}`);
  console.log(`Ismeretlen csapat: ${unknownTeams.length}`);
}

function buildWriteData(match) {
  const data = {
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    startTime: Timestamp.fromDate(match.startDate),
    roundId: String(match.round),

    externalSource: "thesportsdb",
    externalEventId: match.externalEventId,
    homeTeamExternalId: match.homeTeamExternalId,
    awayTeamExternalId: match.awayTeamExternalId,

    apiStatus: match.apiStatus,
    apiUpdatedAt: Timestamp.fromDate(new Date()),
    createdAutomatically: true,
    published: true
  };

  if (match.finalResult) {
    data.result = match.finalResult.result;
    data.outcome = match.finalResult.outcome;
  }

  return data;
}

async function writeMatches(db, matches) {
  for (const match of matches) {
    const existing = match.existingMatch;
    const data = buildWriteData(match);

    if (existing) {
      const locks = existing.manualLocks || {};

      if (locks.teams) {
        delete data.homeTeam;
        delete data.awayTeam;
      }

      if (locks.startTime) {
        delete data.startTime;
      }

      if (locks.result) {
        delete data.result;
        delete data.outcome;
      }

      await db.collection("matches").doc(existing.id).set(data, {
        merge: true
      });

      continue;
    }

    await db
      .collection("matches")
      .doc(`tsdb_${match.externalEventId}`)
      .set(
        {
          ...data,
          odds: {},
          manualLocks: {
            teams: false,
            startTime: false,
            result: false
          }
        },
        {
          merge: true
        }
      );
  }
}

async function main() {
  if (!Number.isFinite(LOOKAHEAD_DAYS) || LOOKAHEAD_DAYS < 1 || LOOKAHEAD_DAYS > 28) {
    throw new Error("A LOOKAHEAD_DAYS értéke 1 és 28 közötti egész szám legyen.");
  }

  const serviceAccount = parseServiceAccount();

  initializeApp({
    credential: cert(serviceAccount),
    projectId: PROJECT_ID
  });

  const db = getFirestore();
  const [apiEvents, existingMatches] = await Promise.all([
    fetchUpcomingEvents(),
    loadExistingMatches(db)
  ]);

  const mappedEvents = apiEvents.map(buildMappedEvent);
  const { candidates, unknownTeams } = classifyEvents(
    mappedEvents,
    existingMatches
  );
  const { targetRound, matches } = selectNextRound(candidates);

  printPreview(targetRound, matches, unknownTeams);

  if (DRY_RUN) {
    console.log("");
    console.log("Nem történt Firestore-módosítás.");
    return;
  }

  if (!targetRound || matches.length === 0) {
    console.log("");
    console.log("Nincs menthető mérkőzés.");
    return;
  }

  if (unknownTeams.length > 0) {
    throw new Error(
      "Ismeretlen csapatnév miatt az éles mentés leállt."
    );
  }

  await writeMatches(db, matches);

  console.log("");
  console.log(`${matches.length} mérkőzés feldolgozva a Firestore-ban.`);
}

main().catch(error => {
  console.error("");
  console.error("SZINKRON HIBA:");
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
