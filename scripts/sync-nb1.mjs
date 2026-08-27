import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const PROJECT_ID = "tippliga-4b3af";
const LEAGUE_ID = "4690";
const SEASON = "2026-2027";
const API_KEY = process.env.THESPORTSDB_API_KEY || "123";

const RELEASE_DELAY_HOURS = Number.parseInt(
  process.env.RELEASE_DELAY_HOURS || "26",
  10
);

const DRY_RUN =
  process.env.DRY_RUN !== "false";

const MATCHES_PER_ROUND = 6;
const MAX_DIRECT_LOOKUPS = 24;

const TEAMS = [
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

const ROUND_RELEASE_STATUSES = new Set([
  "FT",
  "AET",
  "PEN",
  "PST",
  "CANC",
  "ABD",
  "AWD"
]);

const RESULT_STATUSES = new Set([
  "FT",
  "AET",
  "PEN",
  "FINISHED",
  "MATCH FINISHED"
]);

function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("hu")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function mapTeam(name) {
  return TEAM_ALIASES[
    normalizeText(name)
  ] || null;
}

function normalizedStatus(event) {
  return String(
    event?.strStatus || ""
  )
    .trim()
    .toUpperCase();
}

function eventRound(event) {
  const n = Number.parseInt(
    event?.intRound,
    10
  );

  return Number.isFinite(n)
    ? n
    : null;
}

function matchRound(match) {
  const n = Number.parseInt(
    match?.roundId ??
      match?.round ??
      "",
    10
  );

  return Number.isFinite(n)
    ? n
    : null;
}

function apiPostponed(event) {
  return (
    normalizedStatus(event) === "PST" ||
    String(
      event?.strPostponed || ""
    )
      .trim()
      .toLowerCase() === "yes"
  );
}

function eventStartDate(event) {
  if (event?.strTimestamp) {
    const d =
      new Date(
        event.strTimestamp
      );

    if (
      !Number.isNaN(
        d.getTime()
      )
    ) {
      return d;
    }
  }

  const date =
    event?.dateEventLocal ||
    event?.dateEvent;

  const time =
    event?.strTimeLocal ||
    event?.strTime ||
    "00:00:00";

  if (!date) {
    return null;
  }

  const d =
    new Date(
      `${date}T${time}+02:00`
    );

  return Number.isNaN(
    d.getTime()
  )
    ? null
    : d;
}

function hasFinalResult(event) {
  const homeScore =
    event?.intHomeScore;

  const awayScore =
    event?.intAwayScore;

  const scoresAvailable =
    homeScore !== null &&
    homeScore !== undefined &&
    awayScore !== null &&
    awayScore !== undefined &&
    Number.isFinite(
      Number(homeScore)
    ) &&
    Number.isFinite(
      Number(awayScore)
    );

  return (
    scoresAvailable &&
    RESULT_STATUSES.has(
      normalizedStatus(event)
    )
  );
}

function resultFromEvent(event) {
  if (
    !hasFinalResult(event)
  ) {
    return null;
  }

  const home =
    Number(
      event.intHomeScore
    );

  const away =
    Number(
      event.intAwayScore
    );

  return {
    result:
      `${home}-${away}`,

    outcome:
      home > away
        ? "1"
        : home < away
          ? "2"
          : "X"
  };
}

function formatLocalDate(date) {
  if (!date) {
    return "-";
  }

  return new Intl.DateTimeFormat(
    "hu-HU",
    {
      timeZone:
        "Europe/Budapest",

      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }
  ).format(date);
}

function timestampMillis(value) {
  if (!value) {
    return null;
  }

  if (
    typeof value.toMillis ===
    "function"
  ) {
    return value.toMillis();
  }

  if (
    typeof value.toDate ===
    "function"
  ) {
    return value
      .toDate()
      .getTime();
  }

  if (
    value instanceof Date
  ) {
    return value.getTime();
  }

  const d =
    new Date(value);

  return Number.isNaN(
    d.getTime()
  )
    ? null
    : d.getTime();
}

function valuesEqual(
  currentValue,
  nextValue
) {
  if (
    currentValue &&
    typeof currentValue.toMillis ===
      "function"
  ) {
    return (
      currentValue.toMillis() ===
      timestampMillis(nextValue)
    );
  }

  if (
    nextValue instanceof Date
  ) {
    return (
      timestampMillis(
        currentValue
      ) ===
      nextValue.getTime()
    );
  }

  return (
    String(
      currentValue ?? ""
    ) ===
    String(
      nextValue ?? ""
    )
  );
}

function parseServiceAccount() {
  const raw =
    process.env
      .FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!raw) {
    throw new Error(
      "Hiányzik a FIREBASE_SERVICE_ACCOUNT_JSON környezeti változó."
    );
  }

  let serviceAccount;

  try {
    serviceAccount =
      JSON.parse(raw);
  } catch {
    throw new Error(
      "A FIREBASE_SERVICE_ACCOUNT_JSON nem érvényes JSON."
    );
  }

  if (
    serviceAccount.private_key
  ) {
    serviceAccount.private_key =
      serviceAccount.private_key.replace(
        /\\n/g,
        "\n"
      );
  }

  return serviceAccount;
}

function validateSettings() {
  if (
    !Number.isFinite(
      RELEASE_DELAY_HOURS
    ) ||
    RELEASE_DELAY_HOURS < 0 ||
    RELEASE_DELAY_HOURS > 72
  ) {
    throw new Error(
      "A RELEASE_DELAY_HOURS értéke 0 és 72 közötti egész szám legyen."
    );
  }
}

async function apiJson(
  url,
  label
) {
  const response =
    await fetch(
      url,
      {
        headers: {
          "User-Agent":
            "NB1-TippLiga-Sync/3.2"
        }
      }
    );

  if (!response.ok) {
    throw new Error(
      `${label}: HTTP ${response.status}`
    );
  }

  return response.json();
}

async function fetchEventsForRound(
  round
) {
  const url =
    new URL(
      `https://www.thesportsdb.com/api/v1/json/${API_KEY}/eventsround.php`
    );

  url.searchParams.set(
    "id",
    LEAGUE_ID
  );

  url.searchParams.set(
    "r",
    String(round)
  );

  url.searchParams.set(
    "s",
    SEASON
  );

  const data =
    await apiJson(
      url,
      `${round}. forduló lekérése`
    );

  return Array.isArray(
    data.events
  )
    ? data.events
    : [];
}

async function fetchEventById(
  id
) {
  const url =
    new URL(
      `https://www.thesportsdb.com/api/v1/json/${API_KEY}/lookupevent.php`
    );

  url.searchParams.set(
    "id",
    String(id)
  );

  const data =
    await apiJson(
      url,
      `Event ID ${id} lekérése`
    );

  return (
    Array.isArray(
      data.events
    ) &&
    data.events.length
  )
    ? data.events[0]
    : null;
}

function validApiEvent(
  event
) {
  if (
    !event?.idEvent
  ) {
    return false;
  }

  if (
    event.idLeague &&
    String(
      event.idLeague
    ) !== LEAGUE_ID
  ) {
    return false;
  }

  if (
    event.strSeason &&
    String(
      event.strSeason
    ) !== SEASON
  ) {
    return false;
  }

  return true;
}

function putEvent(
  map,
  event
) {
  if (
    validApiEvent(event)
  ) {
    map.set(
      String(
        event.idEvent
      ),
      event
    );
  }
}

async function loadExistingMatches(
  db
) {
  const snapshot =
    await db
      .collection("matches")
      .get();

  return snapshot.docs.map(
    doc => ({
      id: doc.id,
      ...doc.data()
    })
  );
}

function getHighestExistingRound(
  matches
) {
  const rounds =
    matches
      .map(matchRound)
      .filter(
        Number.isFinite
      );

  return rounds.length
    ? Math.max(
        ...rounds
      )
    : null;
}

function lookupCandidateIds(
  existingMatches,
  roundEvents,
  highestRound
) {
  const ids = [];
  const seen =
    new Set();

  const add = id => {
    const value =
      String(
        id || ""
      ).trim();

    if (
      value &&
      !seen.has(value)
    ) {
      seen.add(value);
      ids.push(value);
    }
  };

  for (
    const event of
      roundEvents
  ) {
    if (
      eventRound(event) ===
      highestRound
    ) {
      add(
        event.idEvent
      );
    }
  }

  for (
    const match of
      existingMatches
  ) {
    if (
      !match.externalEventId
    ) {
      continue;
    }

    const hasResult =
      !!String(
        match.result || ""
      ).trim() &&
      !!String(
        match.outcome || ""
      ).trim();

    if (
      !hasResult ||
      matchRound(match) >=
        (
          (highestRound ?? 0) -
          1
        )
    ) {
      add(
        match.externalEventId
      );
    }
  }

  return ids.slice(
    0,
    MAX_DIRECT_LOOKUPS
  );
}

async function fetchApiEvents(
  existingMatches
) {
  const byId =
    new Map();

  const highest =
    getHighestExistingRound(
      existingMatches
    );

  const rounds =
    highest === null
      ? [1, 2]
      : [
          highest,
          highest + 1
        ];

  const roundEvents = [];

  for (
    const round of rounds
  ) {
    try {
      const events =
        await fetchEventsForRound(
          round
        );

      roundEvents.push(
        ...events
      );

      events.forEach(
        event =>
          putEvent(
            byId,
            event
          )
      );

      console.log(
        `TheSportsDB körlekérés: ${round}. forduló | ${events.length} esemény.`
      );
    } catch (error) {
      console.warn(
        `Figyelmeztetés: ${round}. forduló:`,
        error?.message ||
          error
      );
    }
  }

  const ids =
    lookupCandidateIds(
      existingMatches,
      roundEvents,
      highest
    );

  console.log(
    `Közvetlen Event ID ellenőrzés: ${ids.length} meccs.`
  );

  for (
    const id of ids
  ) {
    try {
      const event =
        await fetchEventById(
          id
        );

      if (!event) {
        console.warn(
          `Event ID ${id}: nincs esemény.`
        );

        continue;
      }

      if (
        !validApiEvent(
          event
        )
      ) {
        console.warn(
          `Event ID ${id}: nem ehhez az NB I szezonhoz tartozik.`
        );

        continue;
      }

      putEvent(
        byId,
        event
      );

      const score =
        event.intHomeScore !==
          null &&
        event.intHomeScore !==
          undefined &&
        event.intAwayScore !==
          null &&
        event.intAwayScore !==
          undefined
          ? `${event.intHomeScore}-${event.intAwayScore}`
          : "-";

      console.log(
        `Event ID ${id}: ` +
        `${event.strHomeTeam || "?"} – ` +
        `${event.strAwayTeam || "?"} | ` +
        `státusz: ${normalizedStatus(event) || "-"} | ` +
        `eredmény: ${score}`
      );
    } catch (error) {
      console.warn(
        `Figyelmeztetés: Event ID ${id}:`,
        error?.message ||
          error
      );
    }
  }

  return [
    ...byId.values()
  ];
}

function buildMappedEvent(
  event
) {
  return {
    externalEventId:
      String(
        event.idEvent
      ),

    externalSource:
      "thesportsdb",

    externalHomeTeam:
      event.strHomeTeam ||
      "",

    externalAwayTeam:
      event.strAwayTeam ||
      "",

    homeTeam:
      mapTeam(
        event.strHomeTeam
      ),

    awayTeam:
      mapTeam(
        event.strAwayTeam
      ),

    homeTeamExternalId:
      event.idHomeTeam
        ? String(
            event.idHomeTeam
          )
        : "",

    awayTeamExternalId:
      event.idAwayTeam
        ? String(
            event.idAwayTeam
          )
        : "",

    startDate:
      eventStartDate(
        event
      ),

    round:
      eventRound(
        event
      ),

    apiStatus:
      normalizedStatus(
        event
      ),

    apiPostponed:
      apiPostponed(
        event
      ),

    finalResult:
      resultFromEvent(
        event
      )
  };
}

function sameInternalMatch(
  existing,
  event
) {
  return (
    normalizeText(
      existing.homeTeam
    ) ===
      normalizeText(
        event.homeTeam
      ) &&

    normalizeText(
      existing.awayTeam
    ) ===
      normalizeText(
        event.awayTeam
      ) &&

    matchRound(
      existing
    ) ===
      event.round
  );
}

function indexExistingMatches(
  matches
) {
  const map =
    new Map();

  for (
    const match of
      matches
  ) {
    if (
      match.externalEventId
    ) {
      map.set(
        String(
          match.externalEventId
        ),
        match
      );
    }
  }

  return map;
}

function findExistingMatch(
  event,
  matches,
  byId
) {
  return (
    byId.get(
      event.externalEventId
    ) ||

    matches.find(
      match =>
        sameInternalMatch(
          match,
          event
        )
    ) ||

    null
  );
}

function groupEventsByRound(
  events
) {
  const grouped =
    new Map();

  for (
    const event of events
  ) {
    if (
      !Number.isFinite(
        event.round
      ) ||
      !event.startDate ||
      !event.homeTeam ||
      !event.awayTeam
    ) {
      continue;
    }

    if (
      !grouped.has(
        event.round
      )
    ) {
      grouped.set(
        event.round,
        []
      );
    }

    grouped
      .get(
        event.round
      )
      .push(
        event
      );
  }

  for (
    const matches of
      grouped.values()
  ) {
    matches.sort(
      (a, b) =>
        a.startDate -
        b.startDate
    );
  }

  return grouped;
}

function existingForEvent(
  event,
  existingMatches
) {
  return (
    existingMatches.find(
      match =>
        String(
          match.externalEventId ||
          ""
        ) ===
          event.externalEventId ||

        sameInternalMatch(
          match,
          event
        )
    ) ||

    null
  );
}

/*
 * Egy meccs korábban halasztott volt,
 * ha ezt a Firestore bármelyik
 * történeti mezője jelzi.
 *
 * Fontos: akkor is igaz marad,
 * ha az API időközben már új
 * időpontot adott neki.
 */
function wasPostponedMatch(
  event,
  existingMatches
) {
  const existing =
    existingForEvent(
      event,
      existingMatches
    );

  if (!existing) {
    return false;
  }

  return !!(
    existing.wasPostponed ||
    existing.postponedWithoutDate ||
    existing.postponed ||
    existing.originalStartTime ||
    existing.postponementSource ===
      "api" ||
    existing.postponementSource ===
      "manual"
  );
}

/*
 * Forduló-feloldás szempontjából
 * egy korábban halasztott meccs
 * NEM blokkolja a következő fordulót.
 *
 * Ez akkor is így marad, ha már
 * megkapta az új időpontját.
 */
function eventCountsAsClosed(
  event,
  existingMatches
) {
  if (
    ROUND_RELEASE_STATUSES.has(
      event.apiStatus
    )
  ) {
    return true;
  }

  return wasPostponedMatch(
    event,
    existingMatches
  );
}

function isRoundComplete(
  roundEvents,
  existingMatches
) {
  return (
    roundEvents.length ===
      MATCHES_PER_ROUND &&

    roundEvents.every(
      event =>
        eventCountsAsClosed(
          event,
          existingMatches
        )
    )
  );
}

/*
 * A 26 órás várakozás alapja csak
 * a NEM halasztott meccsek közül
 * az utolsó mérkőzés.
 *
 * A későbbre átrakott meccs új
 * időpontját szándékosan kihagyjuk.
 */
function roundReleaseTime(
  roundEvents,
  existingMatches
) {
  const normalEvents =
    roundEvents.filter(
      event =>
        !wasPostponedMatch(
          event,
          existingMatches
        )
    );

  const eventsForRelease =
    normalEvents.length
      ? normalEvents
      : roundEvents;

  const latestStart =
    Math.max(
      ...eventsForRelease.map(
        event =>
          event.startDate.getTime()
      )
    );

  return new Date(
    latestStart +
      RELEASE_DELAY_HOURS *
        60 *
        60 *
        1000
  );
}

function selectRoundForCreation(
  grouped,
  existingMatches
) {
  const now =
    Date.now();

  const highest =
    getHighestExistingRound(
      existingMatches
    );

  if (
    highest === null
  ) {
    const first =
      [...grouped.entries()]
        .filter(
          ([, events]) =>
            events.length ===
              MATCHES_PER_ROUND &&

            events.some(
              event =>
                event.startDate
                  .getTime() >=
                now
            )
        )
        .map(
          ([round]) =>
            round
        )
        .sort(
          (a, b) =>
            a - b
        )[0] ??
      null;

    return {
      targetRound:
        first,

      reason:
        first === null
          ? "Nincs teljes, közelgő forduló."
          : "Még nincs meccs a Firestore-ban."
    };
  }

  const current =
    grouped.get(
      highest
    ) || [];

  const existingCount =
    existingMatches.filter(
      match =>
        matchRound(
          match
        ) ===
        highest
    ).length;

  if (
    existingCount <
      MATCHES_PER_ROUND &&
    current.length ===
      MATCHES_PER_ROUND
  ) {
    return {
      targetRound:
        highest,

      reason:
        "A jelenlegi fordulóból hiányzik meccs a Firestore-ban."
    };
  }

  if (
    !isRoundComplete(
      current,
      existingMatches
    )
  ) {
    return {
      targetRound:
        null,

      reason:
        "A jelenlegi forduló még nem zárult le."
    };
  }

  const releaseAt =
    roundReleaseTime(
      current,
      existingMatches
    );

  if (
    now <
    releaseAt.getTime()
  ) {
    return {
      targetRound:
        null,

      reason:
        `A következő forduló csak ${formatLocalDate(
          releaseAt
        )} után jelenhet meg.`
    };
  }

  const next =
    highest + 1;

  const nextEvents =
    grouped.get(
      next
    ) || [];

  if (
    nextEvents.length !==
      MATCHES_PER_ROUND
  ) {
    return {
      targetRound:
        null,

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
) {
  const locks =
    existing?.manualLocks ||
    {};

  const desired = {
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

  if (
    !locks.teams
  ) {
    desired.homeTeam =
      event.homeTeam;

    desired.awayTeam =
      event.awayTeam;
  }

  if (
    !locks.startTime &&
    event.startDate
  ) {
    desired.startTime =
      event.startDate;
  }

  if (
    event.finalResult &&
    !locks.result
  ) {
    desired.result =
      event.finalResult.result;

    desired.outcome =
      event.finalResult.outcome;

    desired.resultSource =
      "api";
  }

  /*
   * A wasPostponed mezőt történeti
   * jelzőként megtartjuk.
   */
  if (
    event.apiPostponed ||
    existing?.wasPostponed ||
    existing?.postponed ||
    existing?.postponedWithoutDate ||
    existing?.originalStartTime
  ) {
    desired.wasPostponed =
      true;
  }

  if (
    !locks.postponed
  ) {
    if (
      event.apiPostponed
    ) {
      desired.postponed =
        true;

      desired.postponedWithoutDate =
        true;

      desired.postponementSource =
        "api";

      desired.wasPostponed =
        true;

      if (
        existing &&
        !existing.originalStartTime &&
        existing.startTime
      ) {
        desired.originalStartTime =
          existing.startTime;
      }
    } else {
      /*
       * Van már új időpont:
       * maga a meccs többé nem
       * "időpont nélküli halasztott",
       * de a wasPostponed megmarad.
       */
      desired.postponed =
        false;

      desired.postponedWithoutDate =
        false;

      desired.postponementSource =
        "";
    }
  }

  return desired;
}

function buildChangedFields(
  existing,
  desired
) {
  const changes = {};
  const changedKeys = [];

  for (
    const [
      key,
      nextValue
    ] of Object.entries(
      desired
    )
  ) {
    const currentValue =
      existing?.[key];

    if (
      !valuesEqual(
        currentValue,
        nextValue
      )
    ) {
      changes[key] =
        nextValue instanceof Date
          ? Timestamp.fromDate(
              nextValue
            )
          : nextValue;

      changedKeys.push(
        key
      );
    }
  }

  if (
    changedKeys.length
  ) {
    changes.apiUpdatedAt =
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
) {
  const byId =
    indexExistingMatches(
      existingMatches
    );

  const plans = [];

  for (
    const event of
      mapped
  ) {
    if (
      !event.startDate ||
      !Number.isFinite(
        event.round
      )
    ) {
      continue;
    }

    const existing =
      findExistingMatch(
        event,
        existingMatches,
        byId
      );

    if (!existing) {
      continue;
    }

    const {
      changes,
      changedKeys
    } =
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
) {
  if (
    !Number.isFinite(
      targetRound
    )
  ) {
    return [];
  }

  const byId =
    indexExistingMatches(
      existingMatches
    );

  return (
    grouped.get(
      targetRound
    ) || []
  ).filter(
    event =>
      !findExistingMatch(
        event,
        existingMatches,
        byId
      )
  );
}

function resultWasChanged(
  keys
) {
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
) {
  for (
    const [key, value]
    of Object.entries(
      changes
    )
  ) {
    existing[key] =
      value;
  }
}

async function executeExistingPlans(
  db,
  plans
) {
  let changedCount = 0;
  let resultChanged = false;

  for (
    const plan of plans
  ) {
    if (
      !plan.changedKeys.length
    ) {
      continue;
    }

    await db
      .collection("matches")
      .doc(
        plan.existing.id
      )
      .set(
        plan.changes,
        {
          merge: true
        }
      );

    applyChangesToLocalMatch(
      plan.existing,
      plan.changes
    );

    changedCount += 1;

    if (
      resultWasChanged(
        plan.changedKeys
      )
    ) {
      resultChanged =
        true;
    }
  }

  return {
    changedCount,
    resultChanged
  };
}

function buildNewMatchDocument(
  event
) {
  const data = {
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

    odds: {},

    manualLocks: {
      teams: false,
      startTime: false,
      result: false,
      postponed: false
    },

    apiUpdatedAt:
      Timestamp.fromDate(
        new Date()
      )
  };

  if (
    event.apiPostponed
  ) {
    data.wasPostponed =
      true;

    data.originalStartTime =
      Timestamp.fromDate(
        event.startDate
      );
  }

  return data;
}

async function createNewMatches(
  db,
  newMatches,
  existingMatches
) {
  let createdCount = 0;
  let resultChanged = false;

  for (
    const event of
      newMatches
  ) {
    if (
      !event.homeTeam ||
      !event.awayTeam
    ) {
      throw new Error(
        `Ismeretlen csapat miatt nem hozható létre: ${event.externalEventId}`
      );
    }

    const id =
      `tsdb_${event.externalEventId}`;

    const data =
      buildNewMatchDocument(
        event
      );

    await db
      .collection("matches")
      .doc(id)
      .set(
        data,
        {
          merge: true
        }
      );

    existingMatches.push({
      id,
      ...data
    });

    createdCount += 1;

    if (
      event.finalResult
    ) {
      resultChanged =
        true;
    }
  }

  return {
    createdCount,
    resultChanged
  };
}

function parseResult(
  value
) {
  const match =
    String(value || "")
      .match(
        /^\s*(\d+)\s*-\s*(\d+)\s*$/
      );

  return match
    ? [
        Number(
          match[1]
        ),
        Number(
          match[2]
        )
      ]
    : null;
}

function computeStandingsFromMatches(
  matches
) {
  const standings = {};

  for (
    const team of TEAMS
  ) {
    standings[team] = {
      team,
      MP: 0,
      W: 0,
      D: 0,
      L: 0,
      GF: 0,
      GA: 0,
      GD: 0,
      Pts: 0
    };
  }

  for (
    const match of
      matches
  ) {
    const home =
      match.homeTeam ||
      match.home ||
      "";

    const away =
      match.awayTeam ||
      match.away ||
      "";

    const result =
      parseResult(
        match.result
      );

    const homeRow =
      standings[home];

    const awayRow =
      standings[away];

    if (
      !homeRow ||
      !awayRow ||
      !result
    ) {
      continue;
    }

    const [
      homeGoals,
      awayGoals
    ] = result;

    homeRow.MP += 1;
    awayRow.MP += 1;

    homeRow.GF +=
      homeGoals;

    homeRow.GA +=
      awayGoals;

    awayRow.GF +=
      awayGoals;

    awayRow.GA +=
      homeGoals;

    homeRow.GD =
      homeRow.GF -
      homeRow.GA;

    awayRow.GD =
      awayRow.GF -
      awayRow.GA;

    if (
      homeGoals >
      awayGoals
    ) {
      homeRow.W += 1;
      awayRow.L += 1;
      homeRow.Pts += 3;
    } else if (
      homeGoals <
      awayGoals
    ) {
      awayRow.W += 1;
      homeRow.L += 1;
      awayRow.Pts += 3;
    } else {
      homeRow.D += 1;
      awayRow.D += 1;
      homeRow.Pts += 1;
      awayRow.Pts += 1;
    }
  }

  return Object
    .values(
      standings
    )
    .sort(
      (a, b) =>
        b.Pts - a.Pts ||
        b.W - a.W ||
        b.GD - a.GD ||
        b.GF - a.GF ||
        a.team.localeCompare(
          b.team,
          "hu"
        )
    );
}

async function publishTable(
  db,
  matches
) {
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
        merge: true
      }
    );
}

function printPreview({
  mappedEvents,
  existingPlans,
  newMatches,
  targetRound,
  targetReason
}) {
  const changed =
    existingPlans.filter(
      plan =>
        plan.changedKeys.length
    );

  const unchanged =
    existingPlans.filter(
      plan =>
        !plan.changedKeys.length
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

  if (
    !changed.length
  ) {
    console.log(
      "- Nincs módosítandó meglévő meccs."
    );
  }

  for (
    const plan of
      changed
  ) {
    const event =
      plan.event;

    const result =
      event.finalResult
        ? ` | eredmény: ${event.finalResult.result}`
        : "";

    console.log(
      `[MÓDOSÍTÁS] ${event.round}. forduló | ` +
      `${event.homeTeam || event.externalHomeTeam} – ` +
      `${event.awayTeam || event.externalAwayTeam} | ` +
      `mezők: ${plan.changedKeys.join(", ")} | ` +
      `Event ID: ${event.externalEventId} | ` +
      `státusz: ${event.apiStatus || "-"}${result}`
    );
  }

  console.log(
    "\nÚjonnan létrehozandó meccsek:"
  );

  if (
    !newMatches.length
  ) {
    console.log(
      "- Nincs új meccs."
    );
  }

  for (
    const event of
      newMatches
  ) {
    console.log(
      `[ÚJ] ${event.round}. forduló | ` +
      `${event.homeTeam} – ${event.awayTeam} | ` +
      `${formatLocalDate(event.startDate)} | ` +
      `Event ID: ${event.externalEventId}`
    );
  }

  const unknown =
    mappedEvents.filter(
      event =>
        !event.homeTeam ||
        !event.awayTeam
    );

  if (
    unknown.length
  ) {
    console.log(
      "\nIsmeretlen csapatnevek:"
    );

    unknown.forEach(
      event =>
        console.log(
          `- ${event.externalHomeTeam || "?"} – ` +
          `${event.externalAwayTeam || "?"} ` +
          `(${event.externalEventId})`
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

async function main() {
  validateSettings();

  initializeApp({
    credential:
      cert(
        parseServiceAccount()
      ),

    projectId:
      PROJECT_ID
  });

  const db =
    getFirestore();

  const existingMatches =
    await loadExistingMatches(
      db
    );

  const apiEvents =
    await fetchApiEvents(
      existingMatches
    );

  const mappedEvents =
    apiEvents.map(
      buildMappedEvent
    );

  const groupedEvents =
    groupEventsByRound(
      mappedEvents
    );

  const existingPlans =
    buildExistingPlans(
      mappedEvents,
      existingMatches
    );

  const {
    targetRound,
    reason:
      targetReason
  } =
    selectRoundForCreation(
      groupedEvents,
      existingMatches
    );

  const newMatches =
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

  if (DRY_RUN) {
    console.log(
      "\nNem történt Firestore-módosítás."
    );

    return;
  }

  const existingResult =
    await executeExistingPlans(
      db,
      existingPlans
    );

  const newResult =
    await createNewMatches(
      db,
      newMatches,
      existingMatches
    );

  const recompute =
    existingResult.resultChanged ||
    newResult.resultChanged;

  if (
    recompute
  ) {
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
  error => {
    console.error(
      "\nSZINKRON HIBA:"
    );

    console.error(
      error?.stack ||
      error?.message ||
      String(error)
    );

    process.exitCode = 1;
  }
);
