// scoring.js — közös pontszámítási szabályok (TippLiga)
//
// Ide kerül minden olyan számítás, aminek minden oldalon ugyanazt kell adnia
// (ranglista, eredmények, statisztika, admin). Ha változik egy szabály,
// csak itt kell módosítani.
//
// Csak tiszta függvények: nem olvasnak Firestore-t és nem nyúlnak a DOM-hoz.

/* ---------------- általános ---------------- */

// "1,85" -> 1.85; üres / hibás -> null
export function toNum(v){
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string") v = v.replace(",", ".");
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ---------------- tippek és oddsok ---------------- */

// A meccs adott kimenetelére ("1" | "X" | "2") vonatkozó odds, ahogy a dokumentumban van
// (szám vagy szöveg). Új formátum: m.odds["1"], régi: m.odds1 / m.oddsX / m.odds2.
export function getOdds(m, key){
  if (m?.odds && (key in m.odds)) return m.odds[key];
  if (key === "1") return m?.odds1;
  if (key === "X") return m?.oddsX;
  if (key === "2") return m?.odds2;
  return undefined;
}

// A tipp kimenetele: "1" | "X" | "2" | ""
export const tipChoice = t => t?.choice ?? t?.tip ?? "";

// Duplázott-e a tipp
export const tipDouble = t => !!(t?.double ?? t?.isDouble);

// Egy tipp pontja: talált tipp esetén odds × szorzó, különben 0.
// A szorzó a duplázót (2 vagy 1) és BL-nél a forduló-szorzót tartalmazza.
export function tipPoints(correct, odds, multiplier = 1){
  return (correct && odds) ? Number(odds) * multiplier : 0;
}

// Forduló-szorzó (BL) a beállított szorzókból; hiányzó vagy hibás érték -> 1
export function stakeFromMap(roundStakes, roundId){
  const key = (roundId == null ? "" : String(roundId)).trim();
  const raw = (roundStakes && Object.prototype.hasOwnProperty.call(roundStakes, key)) ? roundStakes[key] : null;
  const n = toNum(raw);
  return (n !== null && n > 0) ? n : 1;
}

/* ---------------- NB1: végső tabella tipp ---------------- */

// Helyezés-eltérés -> pont
export function positionPointsByDifference(diff){
  if (diff === 0) return 10;
  if (diff === 1) return 6;
  if (diff === 2) return 3;
  if (diff === 3) return 1;
  return 0;
}

// A tippelt 12-es sorrend pontozása a hivatalos tabellához képest.
// eqTeam(a, b): az oldal csapatnév-összevető függvénye (névváltozatok kezelése).
export function calcPositionBonus(order, official, eqTeam){
  let score = 0;
  const maxScore = 120;
  const details = [];

  for (let predictedIndex = 0; predictedIndex < 12; predictedIndex++){
    const team = order?.[predictedIndex];
    if (!team){
      details.push({ predictedIndex, team:"", officialIndex:-1, difference:null, points:0 });
      continue;
    }
    const officialIndex = (official || []).findIndex(officialTeam => eqTeam(officialTeam, team));
    if (officialIndex < 0){
      details.push({ predictedIndex, team, officialIndex:-1, difference:null, points:0 });
      continue;
    }
    const difference = Math.abs(predictedIndex - officialIndex);
    const points = positionPointsByDifference(difference);
    score += points;
    details.push({ predictedIndex, team, officialIndex, difference, points });
  }

  const pct = Number((score / 10).toFixed(1));
  return { score, maxScore, pct, total:12, details };
}

/* ---------------- BL: továbbjutó tippek (párharcok) ---------------- */

// Párharc-azonosító egységesítése, hogy a bracket és a tippek ugyanarra a kulcsra mutassanak
// (pl. "F", "FINAL" -> "F1"; "SF01" -> "SF1").
export function canonicalSlotId(id){
  const raw = String(id ?? "").trim().toUpperCase();
  if (!raw) return "";
  if (raw === "F" || raw === "FINAL") return "F1";
  if (/^SF0?1$/.test(raw)) return "SF1";
  if (/^SF0?2$/.test(raw)) return "SF2";
  return raw;
}

// E-mail-cím összevetéshez: kis- és nagybetű, szóköz nem számít
export const emailKeyOf = v => String(v ?? "").trim().toLowerCase();

// Továbbjutó tipp játékosa (összevetéshez egységesítve)
export const advanceTipUser = t => emailKeyOf(t?.user || t?.userEmail || t?.email);

// Ki jutott tovább a párharcból: "home" | "away" | ""
// Elsődleges a kézzel megadott továbbjutó, utána a tizenegyespárbaj győztese.
export function resolveAdvanceWinner(slot){
  const aw = String(slot?.advanceWinner ?? "").trim();
  if (aw === "home" || aw === "away") return aw;
  const pw = String(slot?.penaltyWinner ?? "").trim();
  if (pw === "home" || pw === "away") return pw;
  return "";
}

// Továbbjutó tipp pontja: talált tipp esetén a párharc VÉGSŐ (adminban beállított) oddsa,
// nem a tippeléskor elmentett érték. A forduló-szorzót a hívó alkalmazza.
export function advancePoints(pick, winnerSide, oddsHome, oddsAway){
  const p = String(pick ?? "").trim().toLowerCase();
  const w = String(winnerSide ?? "").trim().toLowerCase();
  if ((p !== "home" && p !== "away") || p !== w) return 0;
  const o = p === "home" ? (Number(oddsHome) || 0) : (Number(oddsAway) || 0);
  return o > 0 ? o : 0;
}

/* ---------------- BL: bónuszpiacok (győztes, gólkirály) ---------------- */

// Jelölt oddsa: közvetlen odds, tizedes odds vagy százalék alapján
export const fromCandidateOdds = c => {
  const direct = toNum(c?.odds);
  if (direct != null) return direct;
  const dec = toNum(c?.oddsDecimal);
  if (dec != null) return dec;
  const pct = toNum(c?.oddsPercent);
  if (pct != null && pct > 0) return 100 / pct;
  return null;
};

// Az admin által elmentett, megjelenített pont
export const fromDisplayedPoints = c => toNum(c?.displayPoints);

// Bónuszpont az oddsból (tompított skála). Érvénytelen odds -> null.
export function computePoints(odds, BASE = 10, O0 = 65, A = 0.33, LO = 0.5, HI = 2.5){
  const o = toNum(odds);
  if (!o || o <= 0) return null;
  const ratio   = Math.pow(o / Math.max(O0, 1e-9), A);
  const clamped = Math.min(Math.max(ratio, LO), HI);
  return BASE * clamped;
}

// Egy jelölt pontja: ha van elmentett pont, az számít, különben az oddsból számolt
export function candidatePoints(c, scope){
  const dp = fromDisplayedPoints(c);
  if (dp != null) return dp;
  const odds = fromCandidateOdds(c);
  const cfg  = (c._calc && c._calc.scope === scope) ? c._calc : {};
  return computePoints(
    odds,
    cfg.BASE ?? 10,
    cfg.O0   ?? 65,
    cfg.A    ?? 0.33,
    cfg.LO   ?? 0.5,
    cfg.HI   ?? 2.5
  );
}
