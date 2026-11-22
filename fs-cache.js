// fs-cache.js — Firestore-olvasás csökkentő segédmodul (TippLiga)
//
// Cél: ugyanaz a működés, kevesebb Firestore read.
//  - cachedGetDocs:      rövid életű (TTL) böngésző-gyorsítótár gyűjtemény-olvasásokhoz
//  - incrementalGetDocs: első alkalommal teljes olvasás, utána csak a megváltozott
//                        dokumentumokat kéri le (updatedAt / ts mező alapján)
//  - attachChatLazy:     a chat teljes előzményét csak akkor tölti le, ha megnyitják a panelt
//
// Hibatűrő: ha a localStorage nem elérhető / tele van, a lekérdezések simán a
// szerverről mennek, pont úgy, mint a modul nélkül.
//
// Kényszerített frissítés: bármelyik oldal URL-jéhez fűzd hozzá a ?nocache=1 paramétert.

import {
  collection,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const PREFIX = "fsc1:";
const DEFAULT_TTL_MS = 120 * 1000;          // meccsek, userek, stb.
const FULL_REFRESH_MS = 12 * 60 * 60 * 1000; // inkrementális cache teljes újratöltése (törlések miatt)

/* ---------------- localStorage segédek ---------------- */

function lsGet(key){
  try{
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  }catch(_){ return null; }
}

const MAX_ENTRY_CHARS = 2000000; // ennél nagyobb bejegyzést nem tárolunk (a localStorage ~5 MB-os)

function lsSet(key, value){
  try{
    const str = JSON.stringify(value);
    if(str.length > MAX_ENTRY_CHARS){
      localStorage.removeItem(PREFIX + key);
      return false;
    }
    localStorage.setItem(PREFIX + key, str);
    return true;
  }catch(_){
    try{ localStorage.removeItem(PREFIX + key); }catch(__){}
    return false;
  }
}

function lsKeys(){
  const out = [];
  try{
    for(let i = 0; i < localStorage.length; i++){
      const k = localStorage.key(i);
      if(k && k.startsWith(PREFIX)) out.push(k.slice(PREFIX.length));
    }
  }catch(_){}
  return out;
}

try{
  if(new URLSearchParams(location.search).has("nocache")){
    for(const k of lsKeys()){ try{ localStorage.removeItem(PREFIX + k); }catch(_){} }
  }
}catch(_){}

/* ---------------- (de)szerializálás ---------------- */

function enc(v){
  if(v === null || v === undefined) return v === undefined ? null : v;
  const t = typeof v;
  if(t === "number"){
    if(!Number.isFinite(v)) throw new Error("unsupported number");
    return v;
  }
  if(t !== "object") return v;
  if(v instanceof Timestamp) return { __ts: [v.seconds, v.nanoseconds] };
  if(Array.isArray(v)) return v.map(enc);
  const proto = Object.getPrototypeOf(v);
  if(proto !== Object.prototype && proto !== null) throw new Error("unsupported type");
  const o = {};
  for(const k in v) o[k] = enc(v[k]);
  return o;
}

function dec(v){
  if(v === null || typeof v !== "object") return v;
  if(Array.isArray(v)) return v.map(dec);
  if(Array.isArray(v.__ts) && Object.keys(v).length === 1){
    return new Timestamp(v.__ts[0], v.__ts[1]);
  }
  const o = {};
  for(const k in v) o[k] = dec(v[k]);
  return o;
}

function clone(v){
  if(v === null || typeof v !== "object") return v;
  if(v instanceof Timestamp) return v;
  if(Array.isArray(v)) return v.map(clone);
  const o = {};
  for(const k in v) o[k] = clone(v[k]);
  return o;
}

function encodeItems(items){
  return items.map(it => ({ i: it.id, d: enc(it.data) }));
}

function decodeItems(list){
  return (list || []).map(x => ({ id: x.i, data: dec(x.d) }));
}

/* ---------------- QuerySnapshot-szerű objektum ---------------- */

function wrapDocs(docs){
  return {
    docs,
    size: docs.length,
    empty: docs.length === 0,
    forEach: (cb, thisArg) => docs.forEach(cb, thisArg),
    fromCache: true
  };
}

function makeDoc(item){
  return {
    id: item.id,
    exists: () => true,
    data: () => clone(item.data),
    get: (field) => clone(item.data?.[field])
  };
}

function makeSnapFromItems(items){
  const sorted = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return wrapDocs(sorted.map(makeDoc));
}

const inflight = new Map();

function shared(key, factory){
  if(inflight.has(key)) return inflight.get(key);
  const p = Promise.resolve().then(factory).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/* ---------------- TTL cache ---------------- */

export function cachedGetDocs(key, q, ttlMs = DEFAULT_TTL_MS){
  return shared("ttl:" + key, async () => {
    const rec = lsGet("ttl:" + key);
    if(rec){
      const age = Date.now() - rec.t;
      if(age >= 0 && age < ttlMs){
        try{ return makeSnapFromItems(decodeItems(rec.items)); }catch(_){}
      }
    }
    const snap = await getDocs(q);
    try{
      lsSet("ttl:" + key, {
        t: Date.now(),
        items: encodeItems(snap.docs.map(d => ({ id: d.id, data: d.data() })))
      });
    }catch(_){ /* nem támogatott adattípus – nem cache-eljük */ }
    return snap;
  });
}

/* ---------------- inkrementális cache ---------------- */

function cmpTs(a, b){ // [sec, nanos]
  return a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1];
}

export function incrementalGetDocs(db, collName, opts = {}){
  const field = opts.field || "updatedAt";
  const key = "inc:" + collName + ":" + field;

  return shared(key, async () => {
    const now = Date.now();
    const rec = lsGet(key);
    let items = null;
    let cursor = null;
    let fullAt = 0;

    if(rec && rec.items){
      const age = now - rec.fullAt;
      if(age >= 0 && age < FULL_REFRESH_MS){
        try{
          items = new Map(decodeItems(rec.items).map(it => [it.id, it]));
          cursor = rec.cursor || null;
          fullAt = rec.fullAt;
        }catch(_){ items = null; }
      }
    }

    if(items && !cursor){
      // nincs használható időbélyeg-mező: egyszerű TTL-mód
      const age = now - rec.t;
      if(age >= 0 && age < DEFAULT_TTL_MS) return makeSnapFromItems([...items.values()]);
      items = null;
    }

    if(items && cursor){
      let snap = null;
      try{
        snap = await getDocs(query(
          collection(db, collName),
          where(field, ">=", new Timestamp(cursor[0], cursor[1]))
        ));
      }catch(_){ snap = null; }

      if(snap){
        for(const d of snap.docs){
          const data = d.data();
          items.set(d.id, { id: d.id, data });
          const ts = data[field];
          if(ts instanceof Timestamp){
            const cand = [ts.seconds, ts.nanoseconds];
            if(cmpTs(cand, cursor) > 0) cursor = cand;
          }
        }
        try{
          lsSet(key, { t: now, fullAt, cursor, items: encodeItems([...items.values()]) });
        }catch(_){}
        return makeSnapFromItems([...items.values()]);
      }
      items = null;
    }

    // teljes olvasás
    const snap = await getDocs(collection(db, collName));
    const all = new Map();
    let cur = null;
    for(const d of snap.docs){
      const data = d.data();
      all.set(d.id, { id: d.id, data });
      const ts = data[field];
      if(ts instanceof Timestamp){
        const cand = [ts.seconds, ts.nanoseconds];
        if(!cur || cmpTs(cand, cur) > 0) cur = cand;
      }
    }
    try{
      lsSet(key, { t: now, fullAt: now, cursor: cur, items: encodeItems([...all.values()]) });
    }catch(_){}
    return makeSnapFromItems([...all.values()]);
  });
}

/* ---------------- kész segédek az oldalakhoz ---------------- */

export function getMatchesAll(db, coll = "matches"){
  return cachedGetDocs(coll + ":all", collection(db, coll));
}

export function getUsersAll(db){
  return cachedGetDocs("users:all", collection(db, "users"));
}

export function getStandingsTipsAll(db){
  return cachedGetDocs("standingsTips:all", collection(db, "standingsTips"));
}

function startMs(doc){
  const st = doc.data().startTime;
  return st instanceof Timestamp ? st.toMillis() : null;
}

// orderBy("startTime","asc") megfelelője: a startTime nélküli dokumentumok kimaradnak
export async function getMatchesByStart(db, coll = "matches"){
  const snap = await getMatchesAll(db, coll);
  const rows = snap.docs
    .map(d => ({ d, ms: startMs(d) }))
    .filter(x => x.ms !== null)
    .sort((a, b) => a.ms - b.ms || (a.d.id < b.d.id ? -1 : a.d.id > b.d.id ? 1 : 0));
  return wrapDocs(rows.map(x => x.d));
}

// where("startTime", ">=", new Date()) megfelelője
export async function getUpcomingMatches(db, coll = "matches"){
  const snap = await getMatchesByStart(db, coll);
  const now = Date.now();
  return wrapDocs(snap.docs.filter(d => startMs(d) >= now));
}

// where("user","==",email) megfelelője a tippek gyűjteményből
export async function getOwnTips(db, email, coll = "tips"){
  const snap = await incrementalGetDocs(db, coll);
  return wrapDocs(snap.docs.filter(d => d.data().user === email));
}

// Az onSnapshot egyszeri (nem élő) megfelelője: ugyanúgy hívja a kezelőt, de csak egyszer, a betöltéskor.
// Frissítésnél (F5) az új adat jön. A nagy gyűjtemények gyorsítótárból / inkrementálisan töltődnek.
export function snapshotOnce(ref, handler, onError){
  (async () => {
    let snap;
    try{
      if(ref.type === "document"){
        snap = await getDoc(ref);
      }else if(ref.type === "collection"){
        const p = ref.path;
        if(p === "tips" || p === "ucl_tips") snap = await incrementalGetDocs(ref.firestore, p);
        else if(p === "matches" || p === "ucl_matches" || p === "users") snap = await cachedGetDocs(p + ":all", ref);
        else snap = await getDocs(ref);
      }else{
        snap = await getDocs(ref);
      }
    }catch(e){
      if(onError) onError(e); else console.warn("snapshotOnce:", e);
      return;
    }
    handler(snap);
  })();
  return () => {};
}

// Admin oldalakhoz: a TTL-es cache-t lejáratja, így a játékos oldalak friss adatot kapnak
export function expireAll(){
  for(const k of lsKeys()){
    if(!k.startsWith("ttl:")) continue;
    const rec = lsGet(k);
    if(rec){ rec.t = 0; lsSet(k, rec); }
  }
}

/* ---------------- chat: lusta előzmény-betöltés ---------------- */

// Amíg a chat panel zárva van, csak az olvasatlan üzeneteket figyeli (jelvényhez).
// A teljes előzményt (az eredeti listenert) a panel első megnyitásakor indítja el.
export function attachChatLazy(o){
  const { onSnapshotFn, db, collName, qFull, handler, onError, fab, fabBadge, panel, getLastSeenMs } = o;
  let fullStarted = false;
  let unreadUnsub = null;

  function startFull(){
    if(fullStarted) return;
    fullStarted = true;
    if(unreadUnsub){ try{ unreadUnsub(); }catch(_){} unreadUnsub = null; }
    onSnapshotFn(qFull, handler, onError);
  }

  if(panel.classList.contains("open")){ startFull(); return; }

  const last = Math.max(0, Number(getLastSeenMs && getLastSeenMs()) || 0);
  const qUnread = query(
    collection(db, collName),
    where("ts", ">", Timestamp.fromMillis(last)),
    orderBy("ts", "asc")
  );

  unreadUnsub = onSnapshotFn(qUnread, snap => {
    const n = snap.size;
    if(!panel.classList.contains("open") && n > 0){
      fab.classList.add("has-unread");
      if(fabBadge) fabBadge.textContent = n > 99 ? "99+" : String(n);
    }else{
      fab.classList.remove("has-unread");
      if(fabBadge) fabBadge.textContent = "";
    }
  }, onError);

  new MutationObserver(() => {
    if(panel.classList.contains("open")) startFull();
  }).observe(panel, { attributes: true, attributeFilter: ["class"] });
}
