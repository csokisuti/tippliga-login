// ==UserScript==
// @name         TippLiga – TippmixPro NB1 + BL oddsimport
// @namespace    https://csokisuti.github.io/tippliga-login/
// @version      1.4.0
// @description  TippmixPro 1X2 oddsok ellenőrzött átvitele NB1 és BL adminoldalakra, kézi mentéssel.
// @match        https://sports2.tippmixpro.hu/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
(function () {
  'use strict';
  // Az oddsok a sports2.tippmixpro.hu iframe dokumentumában vannak.
  // A userscript ebben a keretben fut, nem a szülőoldalon.
  if (location.hostname !== "sports2.tippmixpro.hu") return;
  const ADMIN = {
    NB1: 'https://csokisuti.github.io/tippliga-login/admin.html',
    BL: 'https://csokisuti.github.io/tippliga-login/admin_ucl.html'
  };
  const MAPS = { NB1: {"debrecen":"Debreceni VSC","debreceni vsc":"Debreceni VSC","dvsc":"Debreceni VSC","kispest honved":"Kispest-Honvéd FC","kispest honved fc":"Kispest-Honvéd FC","honved":"Kispest-Honvéd FC","budapest honved":"Kispest-Honvéd FC","ferencvaros":"Ferencváros","ferencvarosi tc":"Ferencváros","ftc":"Ferencváros","fradi":"Ferencváros","gyor":"ETO FC Győr","gyori eto":"ETO FC Győr","eto":"ETO FC Győr","eto fc gyor":"ETO FC Győr","vasas":"Vasas FC","vasas fc":"Vasas FC","kisvarda":"Kisvárda FC","kisvarda fc":"Kisvárda FC","mtk":"MTK Budapest","mtk budapest":"MTK Budapest","nyiregyhaza":"Nyíregyháza Spartacus","nyiregyhaza spartacus":"Nyíregyháza Spartacus","paks":"Paksi FC","paksi fc":"Paksi FC","puskas akademia":"Puskás Akadémia","puskas akademia fc":"Puskás Akadémia","ujpest":"Újpest FC","ujpest fc":"Újpest FC","zte":"Zalaegerszegi TE FC","zalaegerszeg":"Zalaegerszegi TE FC","zalaegerszegi te":"Zalaegerszegi TE FC","zalaegerszegi te fc":"Zalaegerszegi TE FC"}, BL: {"aek":"AEK Athens","aek athens":"AEK Athens","aek athen":"AEK Athens","arsenal":"Arsenal","arsenal fc":"Arsenal","aston villa":"Aston Villa","aston villa fc":"Aston Villa","atletico madrid":"Atlético Madrid","atletico":"Atlético Madrid","barcelona":"Barcelona","fc barcelona":"Barcelona","barca":"Barcelona","bayern munchen":"Bayern München","bayern":"Bayern München","bodo glimt":"Bodø/Glimt","bodø glimt":"Bodø/Glimt","borussia dortmund":"Borussia Dortmund","dortmund":"Borussia Dortmund","club brugge":"Club Bruges","club bruges":"Club Bruges","brugge":"Club Bruges","como":"Como","como 1907":"Como","fenerbahce":"Fenerbahçe","fener":"Fenerbahçe","feyenoord":"Feyenoord","feyenoord rotterdam":"Feyenoord","galatasaray":"Galatasaray","galatasaray sk":"Galatasaray","inter":"Internazionale","internazionale":"Internazionale","inter milan":"Internazionale","internazionale milano":"Internazionale","lask":"LASK","lask linz":"LASK","leipzig":"Leipzig","rb leipzig":"Leipzig","lens":"Lens","rc lens":"Lens","racing club de lens":"Lens","lille":"Lille","lille osc":"Lille","liverpool":"Liverpool","liverpool fc":"Liverpool","manchester city":"Manchester City","man city":"Manchester City","mancity":"Manchester City","manchester united":"Manchester United","man united":"Manchester United","man utd":"Manchester United","manchester utd":"Manchester United","manu":"Manchester United","napoli":"Napoli","ssc napoli":"Napoli","paris saint germain":"Paris Saint-Germain","psg":"Paris Saint-Germain","paris sg":"Paris Saint-Germain","porto":"Porto","fc porto":"Porto","psv":"PSV","psv eindhoven":"PSV","real betis":"Real Betis","betis":"Real Betis","real betis balompie":"Real Betis","real madrid":"Real Madrid","real madrid cf":"Real Madrid","roma":"Roma","as roma":"Roma","sabah":"Sabah","sabah fk":"Sabah","sabah masazir":"Sabah","shakhtar donetsk":"Shakhtar Donetsk","shakhtar":"Shakhtar Donetsk","sahtar donyeck":"Shakhtar Donetsk","sahtar doneck":"Shakhtar Donetsk","slavia praha":"Slavia Praha","slavia prague":"Slavia Praha","slavia":"Slavia Praha","slovan bratislava":"Slovan Bratislava","slovan":"Slovan Bratislava","sporting cp":"Sporting CP","sporting":"Sporting CP","sporting lisboa":"Sporting CP","sporting lisbon":"Sporting CP","stuttgart":"Stuttgart","vfb stuttgart":"Stuttgart","viking":"Viking","viking fk":"Viking","villarreal":"Villarreal","villarreal cf":"Villarreal"} };
  // TippmixPro BL-csapatnevek további változatai.
  Object.assign(MAPS.BL, {
    'atl madrid': 'Atlético Madrid',
    'viking stavanger': 'Viking',
    'fc bruges': 'Club Bruges'
  });
  const normalize = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[.\-_\/]+/g, ' ').replace(/\s+/g, ' ').trim();
  const oddsNumber = s => {
    const v = String(s || '').match(/\d+[,.]\d{1,3}/);
    return v ? Number(v[0].replace(',', '.')) : NaN;
  };
  const cls = (el, name) => !!el && [...(el.classList || [])].some(c => c === name || c.startsWith(name + '--'));
  function eventContainer(el) {
    let node = el;
    while (node && node !== document.body) {
      if (cls(node, 'EventItem') || [...(node.classList || [])].some(c => /^EventItem(?:__|$)/.test(c) && !c.startsWith('EventItem__Odds') && !c.startsWith('EventItem__Buttons'))) {
        // EventItem__... descendants are not the whole row; only a root EventItem class is acceptable.
        if ([...(node.classList || [])].some(c => c === 'EventItem' || c.startsWith('EventItem--'))) return node;
      }
      node = node.parentElement;
    }
    return null;
  }
  function getButtonOdd(button) {
    const el = button.querySelector('[class*="OddsButton__Odds"]');
    return oddsNumber(el?.textContent || '');
  }
  function extract(mode) {
    const map = MAPS[mode];
    const results = [], seen = new Set(), unknown = new Set();
    const groups = [...document.querySelectorAll('[class*="EventItem__ButtonsGroup"]')]
      .filter(g => g.querySelectorAll('button[class*="OddsButton"]').length >= 3);
    for (const group of groups) {
      const buttons = [...group.querySelectorAll('button[class*="OddsButton"]')];
      const draw = buttons.find(b => normalize(b.getAttribute('title')) === 'dontetlen');
      if (!draw) continue;
      const idx = buttons.indexOf(draw);
      if (idx < 1 || idx + 1 >= buttons.length) continue;
      const homeBtn = buttons[idx - 1], awayBtn = buttons[idx + 1];
      const homeRaw = homeBtn.getAttribute('title') || '';
      const awayRaw = awayBtn.getAttribute('title') || '';
      if (!homeRaw || !awayRaw || normalize(homeRaw) === 'dontetlen' || normalize(awayRaw) === 'dontetlen') continue;
      const home = map[normalize(homeRaw)], away = map[normalize(awayRaw)];
      if (!home || !away) {
        if (!home) unknown.add(homeRaw);
        if (!away) unknown.add(awayRaw);
        continue;
      }
      if (home === away) continue;
      const one = getButtonOdd(homeBtn), x = getButtonOdd(draw), two = getButtonOdd(awayBtn);
      if (![one, x, two].every(v => Number.isFinite(v) && v >= 1.01 && v <= 1000)) continue;
      const key = home + '|' + away;
      if (seen.has(key)) continue;
      seen.add(key);
      // Keep the admin's existing payload shape; no direct database writes.
      results.push({home, away, when: '', odds: {'1': one, 'X': x, '2': two}});
    }
    return {results, unknown: [...unknown]};
  }
  function importOdds(mode) {
    const {results, unknown} = extract(mode);
    const missingInfo = unknown.length ? '\n\nNem ismert csapatnevek (ellenőrizd):\n' + unknown.join(', ') : '';
    if (!results.length) {
      alert('Nem találtam felismerhető ' + mode + ' 1X2 oddsokat. Ellenőrizd, hogy a megfelelő bajnokság oldalán vagy, és a Hazai / Döntetlen / Vendég oddsok láthatók-e.' + missingInfo);
      return;
    }
    const preview = results.map(m => `${m.home} – ${m.away}: ${m.odds['1'].toFixed(2)} / ${m.odds.X.toFixed(2)} / ${m.odds['2'].toFixed(2)}`).join('\n');
    if (!confirm(`${mode}: ${results.length} mérkőzés felismerve.\n\n${preview}${missingInfo}\n\nMegnyissam az adminoldalt a kitöltéshez? (A mentés kézi.)`)) return;
    const payload = {type: mode === 'NB1' ? 'nb1-odds-bulk' : 'ucl-odds-bulk', source: 'Tippmixpro', matches: results};
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
    const url = ADMIN[mode] + '#oddsbulk=' + encoded;
    const tab = window.open(url, '_blank');
    if (!tab) location.href = url;
  }
  function mount() {
    if (document.getElementById('tippliga-odds-import')) return;
    const bar = document.createElement('div');
    bar.id = 'tippliga-odds-import';
    Object.assign(bar.style, {position:'fixed',bottom:'18px',left:'50%',transform:'translateX(-50%)',zIndex:'2147483647',display:'flex',gap:'8px',padding:'10px',background:'#152238',borderRadius:'12px',boxShadow:'0 5px 24px #0007'});
    const title = document.createElement('span');
    title.textContent = 'TippLiga oddsimport';
    Object.assign(title.style, {color:'white',alignSelf:'center',font:'bold 13px Arial',marginRight:'5px'});
    bar.append(title);
    for (const mode of ['NB1','BL']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = mode + ' oddsok';
      Object.assign(button.style, {padding:'10px 15px',background:mode==='NB1'?'#2563eb':'#0d9488',border:0,borderRadius:'8px',color:'white',font:'bold 13px Arial',cursor:'pointer'});
      button.addEventListener('click', () => { try { importOdds(mode); } catch (err) {console.error(err); alert('Oddsimport hiba: ' + err.message);} });
      bar.append(button);
    }
    document.body.append(bar);
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, {once:true});
})();
