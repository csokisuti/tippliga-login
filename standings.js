// standings.js

// "2-1" -> [2,1]
export function parseRes(str){
  const m = String(str||"").match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  return m ? [parseInt(m[1]), parseInt(m[2])] : null;
}

// A 'matches' tömbből kiszámolja az élő tabella sorrendjét (top 12 csapatnév)
export function computeLiveOrderFromMatches(matches, teamList){
  const S = {};
  teamList.forEach(t=> S[t] = { team:t, MP:0, W:0, D:0, L:0, GF:0, GA:0, GD:0, Pts:0 });

  const H2H = {}; // "A|B" -> { A:{Pts,GF,GA}, B:{Pts,GF,GA} }

  for (const m of matches){
    const A = m.homeTeam, B = m.awayTeam;
    const r = parseRes(m.result);
    if (!A || !B || !r || !S[A] || !S[B]) continue;

    const [hg, ag] = r;
    const a = S[A], b = S[B];

    a.MP++; b.MP++;
    a.GF += hg; a.GA += ag; a.GD = a.GF - a.GA;
    b.GF += ag; b.GA += hg; b.GD = b.GF - b.GA;

    if (hg > ag){ a.W++; b.L++; a.Pts += 3; }
    else if (hg < ag){ b.W++; a.L++; b.Pts += 3; }
    else { a.D++; b.D++; a.Pts++; b.Pts++; }

    const k = [A,B].slice().sort((x,y)=>x.localeCompare(y,'hu')).join('|');
    H2H[k] ||= { [A]:{Pts:0,GF:0,GA:0}, [B]:{Pts:0,GF:0,GA:0} };
    if (hg > ag){ H2H[k][A].Pts += 3; }
    else if (hg < ag){ H2H[k][B].Pts += 3; }
    else { H2H[k][A].Pts++; H2H[k][B].Pts++; }
    H2H[k][A].GF += hg; H2H[k][A].GA += ag;
    H2H[k][B].GF += ag; H2H[k][B].GA += hg;
  }

  function cmp(a,b){
    if (b.Pts !== a.Pts) return b.Pts - a.Pts;
    if (b.W   !== a.W  ) return b.W   - a.W;
    if (b.GD  !== a.GD ) return b.GD  - a.GD;
    if (b.GF  !== a.GF ) return b.GF  - a.GF;

    const k = [a.team,b.team].slice().sort((x,y)=>x.localeCompare(y,'hu')).join('|');
    const row = H2H[k];
    if (row){
      const pa = row[a.team]?.Pts ?? 0, pb = row[b.team]?.Pts ?? 0;
      if (pb !== pa) return pb - pa;
      const gda = (row[a.team]?.GF ?? 0) - (row[a.team]?.GA ?? 0);
      const gdb = (row[b.team]?.GF ?? 0) - (row[b.team]?.GA ?? 0);
      if (gdb !== gda) return gdb - gda;
    }
    return a.team.localeCompare(b.team,'hu');
  }

  return Object.values(S).sort(cmp).map(r=>r.team).slice(0,12);
}
