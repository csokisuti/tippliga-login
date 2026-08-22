import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const PROJECT_ID = "tippliga-4b3af";
const LEAGUE_ID = "4690";
const SEASON = "2026-2027";
const API_KEY = process.env.THESPORTSDB_API_KEY || "123";

const LOOKBACK_DAYS = Number.parseInt(
  process.env.LOOKBACK_DAYS || "7",
  10
);

const LOOKAHEAD_DAYS = Number.parseInt(
  process.env.LOOKAHEAD_DAYS || "14",
  10
);

const RELEASE_DELAY_HOURS = Number.parseInt(
  process.env.RELEASE_DELAY_HOURS || "26",
  10
);

const DRY_RUN =
  process.env.DRY_RUN !== "false";

const MATCHES_PER_ROUND = 6;

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
  "PEN"
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

function mapTeam(externalName) {
  return (
    TEAM_ALIASES[
      normalizeText(externalName)
    ] || null
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
      LOOKBACK_DAYS
    ) ||
    LOOKBACK_DAYS < 0 ||
    LOOKBACK_DAYS > 14
  ) {
    throw new Error(
      "A LOOKBACK_DAYS értéke 0 és 14 közötti egész szám legyen."
    );
  }

  if (
    !Number.isFinite(
      LOOKAHEAD_DAYS
    ) ||
    LOOKAHEAD_DAYS < 1 ||
    LOOKAHEAD_DAYS > 28
  ) {
    throw new Error(
      "A LOOKAHEAD_DAYS értéke 1 és 28 közötti egész szám legyen."
    );
  }

  if (
    LOOKBACK_DAYS +
      LOOKAHEAD_DAYS +
      1 >
    30
  ) {
    throw new Error(
      "A vizsgált napok száma meghaladná a 30 lekéréses percenkénti keretet."
    );
  }

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

function budapestDateString(
  date
) {
  const parts =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone:
          "Europe/Budapest",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }
    ).formatToParts(date);

  const values =
    Object.fromEntries(
      parts
        .filter(
          part =>
            part.type !==
            "literal"
        )
        .map(
          part => [
            part.type,
            part.value
          ]
        )
    );

  return (
    `${values.year}-` +
    `${values.month}-` +
    `${values.day}`
  );
}

function addUtcDays(
  date,
  days
) {
  const next =
    new Date(date);

  next.setUTCDate(
    next.getUTCDate() +
      days
  );

  return next;
}

function eventStartDate(
  event
) {
  if (
    event.strTimestamp
  ) {
    const parsed =
      new Date(
        event.strTimestamp
      );

    if (
      !Number.isNaN(
        parsed.getTime()
      )
    ) {
      return parsed;
    }
  }

  const localDate =
    event.dateEventLocal ||
    event.dateEvent;

  const localTime =
    event.strTimeLocal ||
    event.strTime ||
    "00:00:00";

  if (!localDate) {
    return null;
  }

  const parsed =
    new Date(
      `${localDate}T${localTime}+02:00`
    );

  return Number.isNaN(
    parsed.getTime()
  )
    ? null
    : parsed;
}

function eventRound(
  event
) {
  const value =
    Number.parseInt(
      event.intRound,
      10
    );

  return Number.isFinite(
    value
  )
    ? value
    : null;
}

function normalizedStatus(
  event
) {
  return String(
    event.strStatus || ""
  )
    .trim()
    .toUpperCase();
}

function hasFinalResult(
  event
) {
  const status =
    normalizedStatus(event);

  return (
    RESULT_STATUSES.has(
      status
    ) &&
    event.intHomeScore !==
      null &&
    event.intAwayScore !==
      null &&
    Number.isFinite(
      Number(
        event.intHomeScore
      )
    ) &&
    Number.isFinite(
      Number(
        event.intAwayScore
      )
    )
  );
}

function resultFromEvent(
  event
) {
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

async function fetchEventsForDate(
  dateString
) {
  const url =
    new URL(
      `https://www.thesportsdb.com/api/v1/json/${API_KEY}/eventsday.php`
    );

  url.searchParams.set(
    "d",
    dateString
  );

  url.searchParams.set(
    "l",
    LEAGUE_ID
  );

  const response =
    await fetch(
      url,
      {
        headers: {
          "User-Agent":
            "NB1-TippLiga-Sync/2.2"
        }
      }
    );

  if (!response.ok) {
    throw new Error(
      `TheSportsDB hiba ${response.status} a következő napnál: ${dateString}`
    );
  }

  const data =
    await response.json();

  return Array.isArray(
    data.events
  )
    ? data.events
    : [];
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

  const response =
    await fetch(
      url,
      {
        headers: {
          "User-Agent":
            "NB1-TippLiga-Sync/2.2"
        }
      }
    );

  if (!response.ok) {
    throw new Error(
      `TheSportsDB körlekérés hiba ${response.status} a ${round}. fordulónál.`
    );
  }

  const data =
    await response.json();

  return Array.isArray(
    data.events
  )
    ? data.events
    : [];
}

function isValidApiEvent(
  event
) {
  return (
    String(
      event.idLeague || ""
    ) === LEAGUE_ID &&
    String(
      event.strSeason || ""
    ) === SEASON &&
    !!event.idEvent
  );
}

/*
 * FONTOS:
 *
 * A napi API az elsődleges.
 *
 * Ha overwrite = true:
 *   a kapott esemény frissítheti
 *   a már eltárolt API-adatot.
 *
 * Ha overwrite = false:
 *   csak olyan eseményt ad hozzá,
 *   amely még nincs benne.
 *
 * Így az eventsround fallback
 * nem tudja felülírni az
 * eventsday frissebb eredményét.
 */
function addValidEventsToMap(
  byEventId,
  events,
  {
    overwrite = true
  } = {}
) {
  let added = 0;
  let replaced = 0;
  let skipped = 0;

  for (
    const event of events
  ) {
    if (
      !isValidApiEvent(
        event
      )
    ) {
      continue;
    }

    const key =
      String(
        event.idEvent
      );

    const alreadyExists =
      byEventId.has(key);

    if (
      alreadyExists &&
      !overwrite
    ) {
      skipped += 1;
      continue;
    }

    if (
      alreadyExists
    ) {
      replaced += 1;
    } else {
      added += 1;
    }

    byEventId.set(
      key,
      event
    );
  }

  return {
    added,
    replaced,
    skipped
  };
}

async function fetchEventsWindow(
  existingMatches = []
) {
  const today =
    new Date();

  const byEventId =
    new Map();

  /*
   * 1. ELSŐDLEGES FORRÁS
   *
   * Napokra bontott lekérés.
   * Ez szolgál eredmények és
   * státuszok frissítésére is.
   */
  for (
    let offset =
      -LOOKBACK_DAYS;
    offset <=
      LOOKAHEAD_DAYS;
    offset += 1
  ) {
    const dateString =
      budapestDateString(
        addUtcDays(
          today,
          offset
        )
      );

    const events =
      await fetchEventsForDate(
        dateString
      );

    addValidEventsToMap(
      byEventId,
      events,
      {
        overwrite: true
      }
    );
  }

  const highestExistingRound =
    getHighestExistingRound(
      existingMatches
    );

  const roundsToCheck =
    highestExistingRound ===
    null
      ? [1, 2]
      : [
          highestExistingRound,
          highestExistingRound +
            1
        ];

  /*
   * 2. BIZTONSÁGI FORRÁS
   *
   * A forduló API csak azt
   * pótolja, ami a napi
   * lekérésből hiányzott.
   *
   * Meglévő Event ID-t SOHA
   * nem ír felül.
   */
  for (
    const round of
      roundsToCheck
  ) {
    try {
      const roundEvents =
        await fetchEventsForRound(
          round
        );

      const result =
        addValidEventsToMap(
          byEventId,
          roundEvents,
          {
            overwrite: false
          }
        );

      console.log(
        `TheSportsDB biztonsági körlekérés: ` +
        `${round}. forduló | ` +
        `${roundEvents.length} esemény | ` +
        `${result.added} hiányzó esemény hozzáadva | ` +
        `${result.skipped} már meglévő esemény érintetlenül hagyva.`
      );
    } catch (error) {
      console.warn(
        `Figyelmeztetés: a ${round}. forduló biztonsági lekérése nem sikerült:`,
        error?.message ||
          error
      );
    }
  }

  return Array.from(
    byEventId.values()
  );
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
      eventStartDate(event),

    round:
      eventRound(event),

    apiStatus:
      normalizedStatus(
        event
      ),

    finalResult:
      resultFromEvent(
        event
      )
  };
}

function matchRound(
  match
) {
  const value =
    Number.parseInt(
      match.roundId ??
        match.round ??
        "",
      10
    );

  return Number.isFinite(
    value
  )
    ? value
    : null;
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
    ) === event.round
  );
}

async function loadExistingMatches(
  db
) {
  const snapshot =
    await db
      .collection(
        "matches"
      )
      .get();

  return snapshot.docs.map(
    doc => ({
      id: doc.id,
      ...doc.data()
    })
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

function indexExistingMatches(
  existingMatches
) {
  const byExternalId =
    new Map();

  for (
    const match of
      existingMatches
  ) {
    if (
      match.externalEventId
    ) {
      byExternalId.set(
        String(
          match.externalEventId
        ),
        match
      );
    }
  }

  return byExternalId;
}

function findExistingMatch(
  event,
  existingMatches,
  byExternalId
) {
  return (
    byExternalId.get(
      event.externalEventId
    ) ||
    existingMatches.find(
      match =>
        sameInternalMatch(
          match,
          event
        )
    ) ||
    null
  );
}

function getHighestExistingRound(
  existingMatches
) {
  const rounds =
    existingMatches
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

function isRoundComplete(
  roundEvents
) {
  return (
    roundEvents.length ===
      MATCHES_PER_ROUND &&
    roundEvents.every(
      event =>
        ROUND_RELEASE_STATUSES.has(
          event.apiStatus
        )
    )
  );
}

function roundReleaseTime(
  roundEvents
) {
  const latestStart =
    Math.max(
      ...roundEvents.map(
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
  groupedEvents,
  existingMatches
) {
  const now =
    Date.now();

  const highestExistingRound =
    getHighestExistingRound(
      existingMatches
    );

  if (
    highestExistingRound ===
    null
  ) {
    const firstAvailableRound =
      Array.from(
        groupedEvents.entries()
      )
        .filter(
          ([, events]) =>
            events.length ===
              MATCHES_PER_ROUND &&
            events.some(
              event =>
                event.startDate.getTime() >=
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
        firstAvailableRound,

      reason:
        firstAvailableRound ===
        null
          ? "Nincs teljes, közelgő forduló."
          : "Még nincs meccs a Firestore-ban."
    };
  }

  const currentRoundEvents =
    groupedEvents.get(
      highestExistingRound
    ) || [];

  const existingCurrentRoundCount =
    existingMatches.filter(
      match =>
        matchRound(
          match
        ) ===
        highestExistingRound
    ).length;

  if (
    existingCurrentRoundCount <
      MATCHES_PER_ROUND &&
    currentRoundEvents.length ===
      MATCHES_PER_ROUND
  ) {
    return {
      targetRound:
        highestExistingRound,

      reason:
        "A jelenlegi fordulóból hiányzik meccs a Firestore-ban."
    };
  }

  if (
    !isRoundComplete(
      currentRoundEvents
    )
  ) {
    return {
      targetRound: null,

      reason:
        "A jelenlegi forduló még nem zárult le."
    };
  }

  const releaseAt =
    roundReleaseTime(
      currentRoundEvents
    );

  if (
    now <
    releaseAt.getTime()
  ) {
    return {
      targetRound: null,

      reason:
        `A következő forduló csak ${formatLocalDate(
          releaseAt
        )} után jelenhet meg.`
    };
  }

  const nextRound =
    highestExistingRound +
    1;

  const nextEvents =
    groupedEvents.get(
      nextRound
    ) || [];

  if (
    nextEvents.length !==
    MATCHES_PER_ROUND
  ) {
    return {
      targetRound: null,

      reason:
        `A ${nextRound}. fordulóból még nem érhető el mind a ${MATCHES_PER_ROUND} meccs.`
    };
  }

  return {
    targetRound:
      nextRound,

    reason:
      "Az előző forduló lezárult, és letelt a megjelenési várakozás."
  };
}

function formatLocalDate(
  date
) {
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

function timestampMillis(
  value
) {
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

  const parsed =
    new Date(value);

  return Number.isNaN(
    parsed.getTime()
  )
    ? null
    : parsed.getTime();
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
      timestampMillis(
        nextValue
      )
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

    apiManaged: true,

    published: true,

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
    !locks.startTime
  ) {
    desired.startTime =
      event.startDate;
  }

  /*
   * Az eredmény frissítése
   * független attól, hogy
   * van-e publikálható új
   * forduló.
   *
   * Ha a napi API kész
   * eredményt ad, bekerül.
   */
  if (
    event.finalResult &&
    !locks.result
  ) {
    desired.result =
      event.finalResult.result;

    desired.outcome =
      event.finalResult.outcome;
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
        nextValue instanceof
        Date
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
    changedKeys.length >
    0
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

function resultWasChanged(
  changedKeys
) {
  return (
    changedKeys.includes(
      "result"
    ) ||
    changedKeys.includes(
      "outcome"
    )
  );
}

function buildExistingPlans(
  mappedEvents,
  existingMatches
) {
  const byExternalId =
    indexExistingMatches(
      existingMatches
    );

  const plans = [];

  for (
    const event of
      mappedEvents
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
        byExternalId
      );

    if (!existing) {
      continue;
    }

    const desired =
      buildDesiredData(
        event,
        existing
      );

    const {
      changes,
      changedKeys
    } =
      buildChangedFields(
        existing,
        desired
      );

    plans.push({
      event,
      existing,
      changes,
      changedKeys,

      linkedBy:
        String(
          existing.externalEventId ||
            ""
        ) ===
        event.externalEventId
          ? "event-id"
          : "teams"
    });
  }

  return plans;
}

function buildNewMatches(
  targetRound,
  groupedEvents,
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
    indexExistingMatches(
      existingMatches
    );

  return (
    groupedEvents.get(
      targetRound
    ) || []
  ).filter(
    event =>
      !findExistingMatch(
        event,
        existingMatches,
        byExternalId
      )
  );
}

function printPreview({
  mappedEvents,
  existingPlans,
  newMatches,
  targetRound,
  targetReason
}) {
  const unknownTeams =
    mappedEvents.filter(
      event =>
        !event.homeTeam ||
        !event.awayTeam
    );

  const changedPlans =
    existingPlans.filter(
      plan =>
        plan.changedKeys
          .length > 0
    );

  const unchangedPlans =
    existingPlans.filter(
      plan =>
        plan.changedKeys
          .length === 0
    );

  console.log("");

  console.log(
    "NB I szinkron – előnézet"
  );

  console.log(
    "======================="
  );

  console.log(
    `Üzemmód: ${
      DRY_RUN
        ? "ELŐNÉZET, nincs Firestore-írás"
        : "ÉLES ÍRÁS"
    }`
  );

  console.log(
    `Vizsgált időszak: ma - ${LOOKBACK_DAYS} nap / ma + ${LOOKAHEAD_DAYS} nap`
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

  if (
    targetRound ===
      null &&
    /fordulóból még nem érhető el mind/i.test(
      targetReason
    )
  ) {
    const match =
      targetReason.match(
        /A (\d+)\. fordulóból/
      );

    const missingRound =
      match
        ? Number.parseInt(
            match[1],
            10
          )
        : null;

    if (
      Number.isFinite(
        missingRound
      )
    ) {
      const seen =
        mappedEvents.filter(
          event =>
            event.round ===
            missingRound
        );

      console.log("");

      console.log(
        `${missingRound}. forduló API-ból látott meccsei (${seen.length}/${MATCHES_PER_ROUND}):`
      );

      if (
        !seen.length
      ) {
        console.log(
          "- Egyetlen meccs sem érkezett."
        );
      }

      for (
        const event of
          seen
      ) {
        console.log(
          `- ${event.externalHomeTeam || "?"} – ` +
          `${event.externalAwayTeam || "?"} | ` +
          `${formatLocalDate(event.startDate)} | ` +
          `Event ID: ${event.externalEventId}`
        );
      }
    }
  }

  console.log("");

  console.log(
    "Ténylegesen módosítandó meglévő meccsek:"
  );

  if (
    changedPlans.length ===
    0
  ) {
    console.log(
      "- Nincs módosítandó meglévő meccs."
    );
  }

  for (
    const plan of
      changedPlans
  ) {
    const event =
      plan.event;

    const resultText =
      event.finalResult
        ? ` | eredmény: ${event.finalResult.result}`
        : "";

    console.log(
      `[MÓDOSÍTÁS] ${event.round}. forduló | ` +
      `${event.homeTeam || event.externalHomeTeam} – ` +
      `${event.awayTeam || event.externalAwayTeam} | ` +
      `mezők: ${plan.changedKeys.join(", ")} | ` +
      `Event ID: ${event.externalEventId} | ` +
      `státusz: ${event.apiStatus || "-"}${resultText}`
    );
  }

  console.log("");

  console.log(
    "Újonnan létrehozandó meccsek:"
  );

  if (
    newMatches.length ===
    0
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
      `Event ID: ${event.externalEventId} | ` +
      `státusz: ${event.apiStatus || "-"}`
    );
  }

  if (
    unknownTeams.length >
    0
  ) {
    console.log("");

    console.log(
      "Ismeretlen csapatnevek:"
    );

    for (
      const event of
        unknownTeams
    ) {
      console.log(
        `- ${event.externalHomeTeam || "?"} – ` +
        `${event.externalAwayTeam || "?"} ` +
        `(Event ID: ${event.externalEventId})`
      );
    }
  }

  console.log("");

  console.log(
    `Módosítandó meglévő meccs: ${changedPlans.length}`
  );

  console.log(
    `Változatlan meglévő meccs: ${unchangedPlans.length}`
  );

  console.log(
    `Új meccs: ${newMatches.length}`
  );

  console.log(
    `Ismeretlen csapat: ${unknownTeams.length}`
  );
}

function applyChangesToLocalMatch(
  existing,
  changes
) {
  for (
    const [
      key,
      value
    ] of Object.entries(
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
  let resultChanged =
    false;

  for (
    const plan of plans
  ) {
    if (
      plan.changedKeys
        .length === 0
    ) {
      continue;
    }

    await db
      .collection(
        "matches"
      )
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

    odds: {},

    manualLocks: {
      teams: false,
      startTime: false,
      result: false
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
) {
  let createdCount = 0;
  let resultChanged =
    false;

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

    const documentId =
      `tsdb_${event.externalEventId}`;

    const data =
      buildNewMatchDocument(
        event
      );

    await db
      .collection(
        "matches"
      )
      .doc(
        documentId
      )
      .set(
        data,
        {
          merge: true
        }
      );

    existingMatches.push({
      id: documentId,
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
        Number.parseInt(
          match[1],
          10
        ),
        Number.parseInt(
          match[2],
          10
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

  const headToHead = {};

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

    homeRow.GD =
      homeRow.GF -
      homeRow.GA;

    awayRow.GF +=
      awayGoals;

    awayRow.GA +=
      homeGoals;

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

    const key =
      [home, away]
        .slice()
        .sort(
          (a, b) =>
            a.localeCompare(
              b,
              "hu"
            )
        )
        .join("|");

    headToHead[key] ||= {
      [home]: {
        Pts: 0,
        GF: 0,
        GA: 0
      },

      [away]: {
        Pts: 0,
        GF: 0,
        GA: 0
      }
    };

    if (
      homeGoals >
      awayGoals
    ) {
      headToHead[key][
        home
      ].Pts += 3;
    } else if (
      homeGoals <
      awayGoals
    ) {
      headToHead[key][
        away
      ].Pts += 3;
    } else {
      headToHead[key][
        home
      ].Pts += 1;

      headToHead[key][
        away
      ].Pts += 1;
    }

    headToHead[key][
      home
    ].GF += homeGoals;

    headToHead[key][
      home
    ].GA += awayGoals;

    headToHead[key][
      away
    ].GF += awayGoals;

    headToHead[key][
      away
    ].GA += homeGoals;
  }

  function compare(
    a,
    b
  ) {
    if (
      b.Pts !== a.Pts
    ) {
      return (
        b.Pts -
        a.Pts
      );
    }

    if (
      b.W !== a.W
    ) {
      return (
        b.W -
        a.W
      );
    }

    if (
      b.GD !== a.GD
    ) {
      return (
        b.GD -
        a.GD
      );
    }

    if (
      b.GF !== a.GF
    ) {
      return (
        b.GF -
        a.GF
      );
    }

    const key =
      [a.team, b.team]
        .slice()
        .sort(
          (x, y) =>
            x.localeCompare(
              y,
              "hu"
            )
        )
        .join("|");

    const row =
      headToHead[key];

    if (row) {
      const aPoints =
        row[a.team]?.Pts ??
        0;

      const bPoints =
        row[b.team]?.Pts ??
        0;

      if (
        bPoints !==
        aPoints
      ) {
        return (
          bPoints -
          aPoints
        );
      }

      const aDiff =
        (row[a.team]?.GF ??
          0) -
        (row[a.team]?.GA ??
          0);

      const bDiff =
        (row[b.team]?.GF ??
          0) -
        (row[b.team]?.GA ??
          0);

      if (
        bDiff !==
        aDiff
      ) {
        return (
          bDiff -
          aDiff
        );
      }
    }

    return a.team.localeCompare(
      b.team,
      "hu"
    );
  }

  return Object.values(
    standings
  ).sort(compare);
}

async function publishTable(
  db,
  matches
) {
  const rows =
    computeStandingsFromMatches(
      matches
    );

  await db
    .collection(
      "computed"
    )
    .doc(
      "nb1_table"
    )
    .set(
      {
        rows,

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

async function main() {
  validateSettings();

  const serviceAccount =
    parseServiceAccount();

  initializeApp({
    credential:
      cert(
        serviceAccount
      ),

    projectId:
      PROJECT_ID
  });

  const db =
    getFirestore();

  /*
   * Firestore először,
   * mert ebből tudjuk,
   * melyik a jelenlegi és
   * következő forduló.
   */
  const existingMatches =
    await loadExistingMatches(
      db
    );

  /*
   * API:
   *
   * eventsday = elsődleges,
   * eventsround = csak fallback.
   */
  const apiEvents =
    await fetchEventsWindow(
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

  /*
   * EZ MINDEN API-BÓL
   * ELÉRHETŐ, MÁR MEGLÉVŐ
   * MECCSET FRISSÍT.
   *
   * Az eredményfrissítés
   * nincs összekötve az új
   * forduló publikálásával.
   */
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
    console.log("");

    console.log(
      "Nem történt Firestore-módosítás."
    );

    return;
  }

  /*
   * Először mindig a
   * meglévő meccsek
   * frissítése történik.
   *
   * Így az eredmények akkor
   * is bekerülnek, ha új
   * forduló még nem
   * publikálható.
   */
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

  const shouldRecomputeTable =
    existingResult
      .resultChanged ||
    newResult
      .resultChanged;

  if (
    shouldRecomputeTable
  ) {
    await publishTable(
      db,
      existingMatches
    );
  }

  console.log("");

  console.log(
    `${existingResult.changedCount} meglévő meccs ténylegesen módosítva.`
  );

  console.log(
    `${newResult.createdCount} új meccs létrehozva.`
  );

  console.log(
    shouldRecomputeTable
      ? "Az NB I tabella újraszámítása megtörtént."
      : "Nem változott eredmény, ezért a tabellát nem kellett újraírni."
  );
}

main().catch(
  error => {
    console.error("");

    console.error(
      "SZINKRON HIBA:"
    );

    console.error(
      error?.stack ||
      error?.message ||
      String(error)
    );

    process.exitCode = 1;
  }
);
