// league-switcher.js  —  egyszerű NB1 ⇄ BL váltó mindegyik oldalra
// Használat:
//   import { initLeagueSwitcher, setLeagueBadge, redirectToLastLeague } from './league-switcher.js';
//   initLeagueSwitcher();  // minden NB1/BL oldalon
//   // (opcionális) badge frissítés: setLeagueBadge('ucl', 3); setLeagueBadge('nb1', 0);
//   // (opcionális) indexen: redirectToLastLeague('dashboard.html','dashboard_ucl.html');

const LS_KEY = 'lastLeague'; // 'nb1' | 'ucl'

function ensureStyles() {
  if (document.getElementById('league-switcher-styles')) return;
  const css = `
  .league-switch{
    display:inline-flex; gap:0; margin-right:10px;
    background:#fff; border:1px solid var(--line,#e6eaf1); border-radius:12px;
    box-shadow:0 4px 14px rgba(0,0,0,.06); overflow:hidden; vertical-align:middle;
  }
  .league-switch a{
    padding:8px 12px; text-decoration:none; color:#0f172a; font-weight:700;
    line-height:1; display:inline-flex; align-items:center; justify-content:center; gap:6px;
  }
  .league-switch a:hover{ background:#f7f9fd }
  .league-switch a[aria-current="true"]{
    background:var(--accent,#3b82f6); color:#fff;
  }
  .league-switch .pill-badge{
    display:inline-flex; align-items:center; justify-content:center;
    min-width:18px; height:18px; padding:0 6px; border-radius:999px;
    background:#ef4444; color:#fff; font-size:12px; font-weight:800; line-height:18px;
  }
  .league-switch .pill-badge[hidden]{ display:none !important; }
  `;
  const style = document.createElement('style');
  style.id = 'league-switcher-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

function computeHref(forUcl) {
  // Az aktuális fájlnév párját képezzük: X.html  ⇄  X_ucl.html
  const url = new URL(location.href);
  const parts = url.pathname.split('/');
  const file = parts.pop() || '';
  const m = file.match(/^(.*?)(_ucl)?\.html$/i);
  // Ha nincs .html (pl. route-os környezet), fallback: csak visszaadjuk self-et
  if (!m) return url.pathname + url.search + url.hash;
  const base = m[1];
  const nextFile = forUcl ? `${base}_ucl.html` : `${base.replace(/_ucl$/i,'')}.html`;
  const nextPath = [...parts, nextFile].join('/') || `/${nextFile}`;
  return nextPath + url.search + url.hash;
}

function isUclPage() {
  return /(^|\/)[^\/]*_ucl\.html(?:$|\?|\#)/i.test(location.pathname);
}

function setLastLeague(val){ try{ localStorage.setItem(LS_KEY, val); }catch{} }
function getLastLeague(){ try{ return localStorage.getItem(LS_KEY)||''; }catch{ return ''; } }

function buildSwitcherDOM(curIsUcl){
  const wrap = document.createElement('div');
  wrap.className = 'league-switch';
  wrap.setAttribute('role','tablist');
  wrap.setAttribute('aria-label','Tippjáték váltó');

  const aNb1 = document.createElement('a');
  aNb1.id = 'ls-nb1';
  aNb1.href = computeHref(false);
  aNb1.textContent = 'NB1';
  aNb1.setAttribute('role','tab');
  if (!curIsUcl) aNb1.setAttribute('aria-current','true');

  const badgeNb1 = document.createElement('span');
  badgeNb1.id = 'ls-badge-nb1';
  badgeNb1.className = 'pill-badge';
  badgeNb1.hidden = true;
  aNb1.appendChild(badgeNb1);

  const aUcl = document.createElement('a');
  aUcl.id = 'ls-ucl';
  aUcl.href = computeHref(true);
  aUcl.textContent = 'BL';
  aUcl.setAttribute('role','tab');
  if (curIsUcl) aUcl.setAttribute('aria-current','true');

  const badgeUcl = document.createElement('span');
  badgeUcl.id = 'ls-badge-ucl';
  badgeUcl.className = 'pill-badge';
  badgeUcl.hidden = true;
  aUcl.appendChild(badgeUcl);

  // Kattintáskor elmentjük, mit választott a user
  aNb1.addEventListener('click', ()=> setLastLeague('nb1'));
  aUcl.addEventListener('click', ()=> setLastLeague('ucl'));

  // Szimpla bal/jobb nyilas fókusz (két tab közt)
  wrap.addEventListener('keydown', (e)=>{
    if (!['ArrowLeft','ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const items = [aNb1, aUcl];
    const curIdx = curIsUcl ? 1 : 0;
    const nextIdx = (curIdx + 1) % 2;
    items[nextIdx].focus();
  });

  wrap.appendChild(aNb1);
  wrap.appendChild(aUcl);
  return wrap;
}

function findDefaultMountPoint(){
  // A te layoutodban a jobb oldali header-div jó hely:
  // <div class="header"><div class="header-left">...</div><div> [IDE] Kilépés + Szabályzat </div></div>
  // Ezt célozzuk meg, és a Switcher-t a "Kilépés" elé szúrjuk.
  const right = document.querySelector('.header > div:last-child');
  return right || document.querySelector('.header');
}

/** Publikus: hívjad minden NB1/BL oldalon */
export function initLeagueSwitcher({ mountTarget } = {}){
  ensureStyles();
  const mount = mountTarget || findDefaultMountPoint();
  if (!mount) return;
  const curIsUcl = isUclPage();
  const node = buildSwitcherDOM(curIsUcl);
  // a jobb oldal elejére tesszük (Kilépés gomb előttre)
  mount.insertBefore(node, mount.firstChild || null);
  // frissítjük a lastLeague-et, hogy a belépés után is ez maradjon
  setLastLeague(curIsUcl ? 'ucl' : 'nb1');
}

/** Opció: állíts badge-et. league: 'nb1' | 'ucl' */
export function setLeagueBadge(league, count){
  const id = league === 'ucl' ? 'ls-badge-ucl' : 'ls-badge-nb1';
  const el = document.getElementById(id);
  if (!el) return;
  const n = Number(count)||0;
  if (n > 0){
    el.textContent = n > 99 ? '99+' : String(n);
    el.hidden = false;
  } else {
    el.hidden = true;
    el.textContent = '';
  }
}

/** Opcionális: root/landing oldalon átirányítás a legutóbb választott ligára */
export function redirectToLastLeague(nb1Href, uclHref){
  const last = getLastLeague();
  if (last === 'ucl' && uclHref) location.replace(uclHref);
  else if (last === 'nb1' && nb1Href) location.replace(nb1Href);
}

// Opcionális helper, ha valaha szükséges lenne más modulból:
export function getLastLeagueChoice(){ return getLastLeague(); }
