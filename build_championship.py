#!/usr/bin/env python3
"""
Lit l'export JSON d'un championnat (Assetto Server Manager) et produit
data/championship.json : résumés de course, classement et profils pilote.

Usage :
    python3 build_championship.py --input championnat.json --out data/championship.json

Les points sont recalculés à partir du barème du championnat (Classes[].Points.Places).
Ils peuvent différer légèrement de l'affichage du Server Manager (voir "notes" dans le résultat).
"""
import argparse
import json
import re
import statistics
from collections import defaultdict
from pathlib import Path

MIN_IMPACT = 5.0        # km/h : en dessous, simple frottement, ignoré
MIN_RACES_PROFILE = 2   # courses minimum pour établir un profil
MIN_CLEAN_LAPS = 5      # tours propres minimum pour juger le rythme
OUTLIER = 1.03          # tours > 103 % du tour médian du pilote : exclus du rythme


# ------------------------------------------------------------------ utilitaires
def fr(x, nd=1):
    return f"{x:.{nd}f}".replace(".", ",")


def ordinal(n):
    return "1er" if n == 1 else f"{n}e"


def lap_str(ms):
    m, rest = divmod(int(ms), 60000)
    return f"{m}:{rest / 1000:06.3f}"


def pretty_track(raw):
    s = re.sub(r"_\d+$", "", raw or "")
    return " ".join(w[:1].upper() + w[1:] for w in re.split(r"[-_\s]+", s) if w)


def plural(n, one, many):
    return f"{n} {one if n < 2 else many}"


def norm_team(t):
    return re.sub(r"[\s_\-]+", " ", (t or "").strip()).casefold()


# ------------------------------------------------------------------ sessions
def collect_sessions(champ):
    """[(event_idx, event, session_key, results_dict)] triées par date."""
    out = []
    for i, e in enumerate(champ.get("Events", []), start=1):
        for key, s in (e.get("Sessions") or {}).items():
            r = (s or {}).get("Results")
            if r and r.get("Result"):
                out.append((i, e, key, r))
    out.sort(key=lambda t: t[3].get("Date", ""))
    return out


def unique_collisions(events, car_to_guid):
    """Une collision loguée des deux côtés n'est comptée qu'une fois."""
    seen, out = set(), []
    for ev in events or []:
        if ev.get("AfterSessionEnd") or ev.get("ImpactSpeed", 0) < MIN_IMPACT:
            continue
        a = (ev.get("Driver") or {}).get("Guid") or car_to_guid.get(ev.get("CarId"))
        if ev["Type"] == "COLLISION_WITH_CAR":
            b = (ev.get("OtherDriver") or {}).get("Guid") or car_to_guid.get(ev.get("OtherCarId"))
            key = (ev.get("Timestamp"), frozenset((a, b)))
            if key in seen:
                continue
            seen.add(key)
            out.append(("car", [g for g in (a, b) if g]))
        elif ev["Type"] == "COLLISION_WITH_ENV":
            out.append(("env", [a] if a else []))
    return out


def lap_tables(laps, winner_laps):
    """Tours par pilote (ordre chronologique) + positions cumulées par tour."""
    by = defaultdict(list)
    for l in sorted(laps, key=lambda x: x.get("Timestamp", 0)):
        by[l["DriverGuid"]].append(l)
    cum = {}
    for g, ls in by.items():
        t, arr = 0, []
        for l in ls[:winner_laps]:
            t += l["LapTime"]
            arr.append(t)
        cum[g] = arr
    order_by_lap = []
    for n in range(winner_laps):
        present = [(c[n], g) for g, c in cum.items() if len(c) > n]
        present.sort()
        order_by_lap.append([g for _, g in present])
    return by, order_by_lap


# ------------------------------------------------------------------ construction
def build(champ):
    cls = (champ.get("Classes") or [{}])[0]
    places = (cls.get("Points") or {}).get("Places") or []
    pole_pts = (cls.get("Points") or {}).get("PolePosition", 0)
    best_lap_pts = (cls.get("Points") or {}).get("BestLap", 0)
    need_pct = max(75, (cls.get("Points") or {}).get("RequiredRaceTimePercentage", 0))
    configured_teams = champ.get("DriverTeams", {}) or {}

    sessions = collect_sessions(champ)
    qualifs = {i: r for (i, e, k, r) in sessions if r.get("Type") == "QUALIFY"}

    drivers = {}
    teams = {}
    races = []
    per_driver_rows = defaultdict(list)

    def note_driver(guid, name, team):
        d = drivers.setdefault(guid, {"id": guid, "name": name, "team": "Sans équipe"})
        d["name"] = name
        team = configured_teams.get(guid) or team
        if team and str(team).strip():
            team = str(team).strip()
            teams.setdefault(norm_team(team), team)
            d["team"] = teams[norm_team(team)]
            d["teamSource"] = "configuration" if configured_teams.get(guid) else "source"
        else:
            d["team"] = "Sans équipe"
            d["teamSource"] = "unassigned"

    for (ev_i, ev, key, r) in sessions:
        if r.get("Type") != "RACE":
            continue
        car_to_guid = {c["CarId"]: c["Driver"]["Guid"] for c in r.get("Cars", [])}
        for c in r.get("Cars", []):
            note_driver(c["Driver"]["Guid"], c["Driver"]["Name"], c["Driver"].get("Team"))

        res = r["Result"]
        winner = res[0]
        raw_duration = (r.get("SessionConfig") or {}).get("time") or 0
        duration = raw_duration / 60 if raw_duration > 180 else raw_duration
        wl = winner["NumLaps"]
        by_laps, order_by_lap = lap_tables(r.get("Laps", []), wl)
        has_quali = ev_i in qualifs
        first_race_of_event = key == "RACE"

        # pole : meilleur chrono de la qualification de la manche (course 1 uniquement)
        pole_guid, pole_time = None, None
        quali_rank = {}
        if has_quali:
            qr = [x for x in qualifs[ev_i]["Result"] if x["BestLap"] > 0]
            qr.sort(key=lambda x: x["BestLap"])
            for pos, x in enumerate(qr, start=1):
                quali_rank[x["DriverGuid"]] = pos
            if qr:
                pole_guid, pole_time = qr[0]["DriverGuid"], qr[0]["BestLap"]

        # fastest lap
        timed = [x for x in res if x["BestLap"] > 0]
        fastest = min(timed, key=lambda x: x["BestLap"]) if timed else None
        fastest_lap_no = None
        if fastest:
            for n, l in enumerate(by_laps.get(fastest["DriverGuid"], []), start=1):
                if l["LapTime"] == fastest["BestLap"]:
                    fastest_lap_no = n
                    break

        # contacts
        cols = unique_collisions(r.get("Events"), car_to_guid)
        contacts = defaultdict(int)
        env_hits = defaultdict(int)
        for kind, gs in cols:
            for g in gs:
                (contacts if kind == "car" else env_hits)[g] += 1
        n_car = sum(1 for k, _ in cols if k == "car")
        n_env = sum(1 for k, _ in cols if k == "env")

        # rythme (médiane des tours propres)
        pace = {}
        cons = {}
        cut_laps = {}
        for g, ls in by_laps.items():
            clean = [l["LapTime"] for l in ls[1:] if l.get("Cuts", 0) == 0 and l["LapTime"] > 0]
            cut_laps[g] = sum(1 for l in ls if l.get("Cuts", 0) > 0)
            if len(clean) >= MIN_CLEAN_LAPS:
                med = statistics.median(clean)
                kept = [t for t in clean if t <= med * OUTLIER]
                if len(kept) >= MIN_CLEAN_LAPS:
                    pace[g] = statistics.median(kept)
                    cons[g] = statistics.pstdev(kept) / pace[g] * 100
        best_pace = min(pace.values()) if pace else None

        # classement et points
        rows = []
        for pos, x in enumerate(res, start=1):
            g = x["DriverGuid"]
            laps_done = x["NumLaps"]
            finished = (
                x["TotalTime"] > 0
                and not x.get("Disqualified")
                and laps_done >= wl * (need_pct / 100.0)
            )
            base_points = [30, 26, 23, 21, 20, 19][pos - 1] if pos <= 6 else max(1, 25 - pos)
            pts = (base_points * (2 if duration >= 50 else 1)) if finished else 0
            if finished and pole_guid == g and first_race_of_event:
                pts += 2 if duration >= 50 else 1
            if finished and fastest and fastest["DriverGuid"] == g:
                pts += 2 if duration >= 50 else 1
            if laps_done == wl:
                gap = x["TotalTime"] - winner["TotalTime"]
                gap_laps = 0
            else:
                gap, gap_laps = None, wl - laps_done
            grid = x.get("GridPosition") or None
            rows.append({
                "driver": g, "pos": pos,
                "status": "FIN" if finished else "DNF",
                "grid": grid,
                "gain": (grid - pos) if (grid and finished) else None,
                "reverseGrid": key != "RACE",
                "laps": laps_done,
                "gap": gap, "gapLaps": gap_laps,
                "bestLap": x["BestLap"],
                "points": pts,
                "contacts": contacts.get(g, 0),
                "envHits": env_hits.get(g, 0),
                "pace": pace.get(g),
                "consistency": cons.get(g),
                "cutLaps": cut_laps.get(g, 0),
            })

        # tours en tête / changements de leader
        led = defaultdict(int)
        leader_changes, prev = 0, None
        for order in order_by_lap:
            if not order:
                continue
            led[order[0]] += 1
            if prev is not None and order[0] != prev:
                leader_changes += 1
            prev = order[0]

        # courbe des positions (top 6 à l'arrivée)
        top = [x["driver"] for x in rows if x["status"] == "FIN"][:6]
        series = {}
        for g in top:
            pts_ = []
            for order in order_by_lap:
                pts_.append(order.index(g) + 1 if g in order else None)
            series[g] = pts_

        # stats course pour profils
        for row in rows:
            g = row["driver"]
            row = dict(row)
            row["fastestGap"] = ((row["bestLap"] / fastest["BestLap"] - 1) * 100) if (fastest and row["bestLap"] > 0) else None
            row["paceGap"] = ((row["pace"] / best_pace - 1) * 100) if (row["pace"] and best_pace) else None
            row["qualiRank"] = quali_rank.get(g) if first_race_of_event else None
            row["raceId"] = None  # rempli plus bas
            per_driver_rows[g].append((len(races), row, g == pole_guid and first_race_of_event))

        race_no = 2 if key != "RACE" else 1
        two_races = any(k != "RACE" and k.startswith("RACE") for k in (ev.get("Sessions") or {}))
        label = ev.get("Name", "").strip()
        sc = r.get("SessionConfig", {})
        races.append({
            "id": f"m{ev_i}-{key.lower()}",
            "event": ev_i,
            "eventName": label,
            "session": key,
            "raceNo": race_no,
            "twoRaces": two_races,
            "date": r.get("Date"),
            "track": pretty_track(r.get("TrackName")),
            "layout": pretty_track(r.get("TrackConfig")),
            "durationMinutes": duration,
            "laps": wl,
            "pole": pole_guid,
            "poleTime": pole_time,
            "fastestLap": {"driver": fastest["DriverGuid"], "time": fastest["BestLap"], "lap": fastest_lap_no} if fastest else None,
            "contactsCar": n_car,
            "contactsEnv": n_env,
            "leaderChanges": leader_changes,
            "lapsLed": dict(led),
            "results": rows,
            "positions": series,
            "_gridKind": "quali" if (has_quali and first_race_of_event) else ("inversee" if key != "RACE" else "autre"),
        })

    # ---------------------------------------------------------- résumés (texte)
    for rc in races:
        rc["summary"] = summarize(rc, drivers)

    # ---------------------------------------------------------- classement
    st = {}
    for rc in races:
        for x in rc["results"]:
            s = st.setdefault(x["driver"], {"driver": x["driver"], "points": 0, "wins": 0, "podiums": 0, "poles": 0, "races": 0, "byRace": {}})
            s["points"] += x["points"]
            s["races"] += 1
            s["byRace"][rc["id"]] = x["points"]
            if x["status"] == "FIN" and x["pos"] == 1:
                s["wins"] += 1
            if x["status"] == "FIN" and x["pos"] <= 3:
                s["podiums"] += 1
        if rc["pole"] and rc["raceNo"] == 1 and rc["pole"] in st:
            st[rc["pole"]]["poles"] += 1
    standings = sorted(st.values(), key=lambda s: (-s["points"], -s["wins"], -s["podiums"], drivers[s["driver"]]["name"].lower()))
    for i, s in enumerate(standings, start=1):
        s["rank"] = i

    # ---------------------------------------------------------- profils
    profiles = build_profiles(per_driver_rows, drivers, races, st)

    total_laps = sum(sum(x["laps"] for x in rc["results"]) for rc in races)
    return {
        "meta": {
            "name": champ.get("Name", "Championnat"),
            "updated": champ.get("Updated"),
            "eventsPlanned": (champ.get("Stats") or {}).get("NumEvents") or len(champ.get("Events", [])),
            "eventsCompleted": len({rc["event"] for rc in races}),
            "races": len(races),
            "drivers": len(drivers),
            "totalLaps": total_laps,
            "car": (cls.get("AvailableCars") or [None])[-1],
            "notes": [
                "Points recalculés d'après le barème du championnat : "
                + ", ".join(str(p) for p in places[:5]) + "… ; "
                + (f"+{pole_pts} pour la pole de la course 1 d'une manche avec qualification ; " if pole_pts else "")
                + (f"abandon si moins de {need_pct} % des tours du vainqueur." if need_pct else ""),
                f"Les contacts comptent les collisions à plus de {MIN_IMPACT:.0f} km/h, une fois par collision, pour chaque pilote impliqué (le fichier ne dit pas qui est en faute).",
            ],
        },
        "drivers": drivers,
        "standings": standings,
        "races": races,
        "profiles": profiles,
    }


# ------------------------------------------------------------------ texte des résumés
def summarize(rc, drivers):
    nm = lambda g: drivers[g]["name"]
    fin = [x for x in rc["results"] if x["status"] == "FIN"]
    if not fin:
        return {"headline": "Course sans classé", "paragraphs": [], "highlights": []}
    w = fin[0]
    p2 = fin[1] if len(fin) > 1 else None
    p3 = fin[2] if len(fin) > 2 else None
    from_pole = rc["pole"] == w["driver"] and rc["raceNo"] == 1
    g = w["grid"]

    if from_pole:
        headline = f"{nm(w['driver'])} gagne depuis la pole"
    elif g and g >= 6:
        headline = f"{nm(w['driver'])} s'impose après un départ en {ordinal(g)} position"
    else:
        headline = f"{nm(w['driver'])} s'impose"

    dur = f" de {rc['durationMinutes']} minutes" if rc["durationMinutes"] else ""
    p = []
    head = f"Course{dur} ({rc['laps']} tours) à {rc['track']}."
    if p2 and p2["gap"] is not None:
        gp = p2["gap"] / 1000
        podium = f"{nm(w['driver'])} l'emporte devant {nm(p2['driver'])} (+{fr(gp, 3)} s)"
        if p3 and p3["gap"] is not None:
            podium += f" et {nm(p3['driver'])} (+{fr(p3['gap'] / 1000, 3)} s)"
        podium += "."
        if gp < 1:
            podium += " Moins d'une seconde entre les deux premiers."
        elif gp > 15:
            podium += " Il termine avec une avance confortable."
        head += " " + podium
    p.append(head)

    led = rc["lapsLed"]
    flow = []
    if led:
        top_leader, n_led = max(led.items(), key=lambda kv: kv[1])
        if len(led) == 1:
            flow.append(f"{nm(top_leader)} mène de bout en bout.")
        else:
            flow.append(f"Le leadership change {plural(rc['leaderChanges'], 'fois', 'fois')} entre {len(led)} pilotes ; {nm(top_leader)} passe le plus de tours en tête ({n_led} sur {rc['laps']}).")
    if rc["pole"] and rc["raceNo"] == 1:
        pole_txt = f"Pole : {nm(rc['pole'])} en {lap_str(rc['poleTime'])}"
        pr = next((x for x in rc["results"] if x["driver"] == rc["pole"]), None)
        if pr and pr["status"] == "FIN" and rc["pole"] != w["driver"]:
            pole_txt += f", arrivé {ordinal(pr['pos'])}"
        flow.append(pole_txt + ".")
    elif rc["_gridKind"] == "inversee":
        flow.append("Grille de la course 2 établie d'après le résultat de la course 1.")
    if flow:
        p.append(" ".join(flow))

    facts = []
    if rc["fastestLap"]:
        fl = rc["fastestLap"]
        facts.append(f"Meilleur tour : {nm(fl['driver'])} en {lap_str(fl['time'])}" + (f" (tour {fl['lap']})." if fl["lap"] else "."))
    gainers = [x for x in fin if x["gain"] is not None]
    if gainers:
        bg = max(gainers, key=lambda x: x["gain"])
        if bg["gain"] >= 3:
            facts.append(f"Plus belle remontée : {nm(bg['driver'])}, de la {ordinal(bg['grid'])} à la {ordinal(bg['pos'])} place (+{bg['gain']}).")
    dnf = [x for x in rc["results"] if x["status"] == "DNF"]
    inc = f"{plural(rc['contactsCar'], 'contact', 'contacts')} entre voitures, {plural(rc['contactsEnv'], 'sortie', 'sorties')} contre le décor"
    if dnf:
        inc += f", {plural(len(dnf), 'abandon', 'abandons')}"
    facts.append(inc[0].upper() + inc[1:] + ".")
    most = max(rc["results"], key=lambda x: x["contacts"])
    if most["contacts"] >= 4:
        facts.append(f"{nm(most['driver'])} est impliqué dans le plus de contacts ({most['contacts']}).")
    p.append(" ".join(facts))

    hl = []
    if rc["pole"] and rc["raceNo"] == 1:
        hl.append({"label": "Pole", "driver": rc["pole"], "value": lap_str(rc["poleTime"])})
    if rc["fastestLap"]:
        hl.append({"label": "Meilleur tour", "driver": rc["fastestLap"]["driver"], "value": lap_str(rc["fastestLap"]["time"])})
    if gainers:
        bg = max(gainers, key=lambda x: x["gain"])
        if bg["gain"] >= 3:
            hl.append({"label": "Remontée", "driver": bg["driver"], "value": f"+{bg['gain']} places"})
    if led:
        tl, nl = max(led.items(), key=lambda kv: kv[1])
        hl.append({"label": "Tours en tête", "driver": tl, "value": f"{nl} / {rc['laps']}"})
    return {"headline": headline, "paragraphs": p, "highlights": hl}


# ------------------------------------------------------------------ profils
AXES = [
    # clé, libellé, plus petit = meilleur ?
    ("quali", "Qualifications", True),
    ("speed", "Vitesse pure", True),
    ("pace", "Rythme de course", True),
    ("consistency", "Régularité", True),
    ("clean", "Propreté", True),
    ("gain", "Remontées", False),
    ("finish", "Fiabilité", False),
]


def build_profiles(rows_by_driver, drivers, races, st):
    raw = {}
    for g, entries in rows_by_driver.items():
        rows = [r for _, r, _ in entries if r["laps"] > 0]
        n = len(rows)
        fin = [r for r in rows if r["status"] == "FIN"]
        a = {"races": n}
        qs = [r["qualiRank"] for r in rows if r["qualiRank"]]
        a["quali"] = (statistics.mean(qs), len(qs)) if qs else None
        sp = [r["fastestGap"] for r in rows if r["fastestGap"] is not None]
        a["speed"] = (statistics.mean(sp), len(sp)) if len(sp) >= MIN_RACES_PROFILE else None
        pc = [r["paceGap"] for r in rows if r["paceGap"] is not None]
        a["pace"] = (statistics.mean(pc), len(pc)) if len(pc) >= MIN_RACES_PROFILE else None
        cs = [r["consistency"] for r in rows if r["consistency"] is not None]
        a["consistency"] = (statistics.mean(cs), len(cs)) if len(cs) >= MIN_RACES_PROFILE else None
        cl = [r["contacts"] + r["envHits"] for r in rows]
        a["clean"] = (statistics.mean(cl), n) if n >= MIN_RACES_PROFILE else None
        gs = [r["gain"] for r in fin if r["gain"] is not None and not r.get("reverseGrid")]
        a["gain"] = (statistics.mean(gs), len(gs)) if len(gs) >= MIN_RACES_PROFILE else None
        a["finish"] = (len(fin) / n, n) if n >= MIN_RACES_PROFILE else None
        raw[g] = a

    # percentiles : 1 = meilleur du plateau, 0 = dernier
    pct = defaultdict(dict)
    rank_of = defaultdict(dict)
    size_of = {}
    for key, label, low_better in AXES:
        vals = {g: a[key][0] for g, a in raw.items() if a.get(key)}
        # arrondi pour que de vraies égalités le restent (ex. 100 % de courses terminées)
        vals = {g: round(v, 6) for g, v in vals.items()}
        order = sorted(vals, key=lambda g: vals[g], reverse=not low_better)
        N = len(order)
        size_of[key] = N
        for g in order:
            better = sum(1 for h in order if (vals[h] < vals[g] if low_better else vals[h] > vals[g]))
            equal = sum(1 for h in order if vals[h] == vals[g])
            rank_of[g][key] = better + 1
            mid = better + (equal - 1) / 2  # rang moyen en cas d'égalité
            pct[g][key] = 1.0 if N == 1 else 1 - mid / (N - 1)

    def phrase(key, good, g, a):
        v, n = a[key]
        r, N = rank_of[g][key], size_of[key]
        pos = f"n°{r} sur {N}"
        if key == "quali":
            return (f"Rapide sur un tour lancé : {ordinal(round(v))} en moyenne en qualification ({pos})." if good
                    else f"Moins à l'aise en qualification : {ordinal(round(v))} en moyenne ({pos}).")
        if key == "speed":
            return (f"Vitesse pure : son meilleur tour est à {fr(v, 2)} % du meilleur de la course en moyenne ({pos})." if good
                    else f"Manque de pointe : son meilleur tour est à {fr(v, 2)} % du meilleur de la course en moyenne ({pos}).")
        if key == "pace":
            return (f"Bon rythme de course : tour médian à {fr(v, 2)} % du plus rapide ({pos})." if good
                    else f"Rythme de course en retrait : tour médian à {fr(v, 2)} % du plus rapide ({pos}).")
        if key == "consistency":
            return (f"Très régulier : seulement {fr(v, 2)} % de dispersion entre ses tours ({pos})." if good
                    else f"Irrégulier : {fr(v, 2)} % de dispersion entre ses tours ({pos}).")
        if key == "clean":
            return (f"Course propre : {fr(v, 1)} contact ou sortie de piste par course ({pos})." if good
                    else f"Souvent mêlé aux incidents : {fr(v, 1)} contacts ou sorties par course ({pos}).")
        if key == "gain":
            if good:
                return f"Fort en course : gagne {fr(v, 1)} places en moyenne par rapport à sa grille ({pos})."
            if v < 0:
                return f"Perd {fr(abs(v), 1)} places en moyenne par rapport à sa grille ({pos})."
            return f"Gagne peu de places en course : {fr(v, 1)} en moyenne depuis la grille ({pos})."
        if key == "finish":
            return (f"Fiable : {round(v * 100)} % des courses terminées dans le classement." if good
                    else f"Abandons fréquents : {round((1 - v) * n)} course(s) sans arriver au bout sur {n}.")
        return ""

    out = {}
    for g, a in raw.items():
        s = st.get(g, {"points": 0, "wins": 0, "podiums": 0, "poles": 0})
        rows = [(i, r, pole) for i, r, pole in rows_by_driver[g] if r["laps"] > 0]
        fin = [r for _, r, _ in rows if r["status"] == "FIN"]
        poles = sum(1 for _, r, pole in rows if pole)
        ok = a["races"] >= MIN_RACES_PROFILE
        cand = [(k, pct[g][k]) for k, _, _ in AXES if k in pct[g]]
        def real_strength(k):
            v = raw[g][k][0]
            return (k != "gain" or v > 0) and (k != "finish" or v == 1)

        def real_weakness(k):
            v = raw[g][k][0]
            return (k != "finish" or v < 1) and (k != "clean" or v >= 1)

        strengths = [k for k, p in sorted(cand, key=lambda t: -t[1]) if p >= 0.66 and real_strength(k)][:2] if ok else []
        weaknesses = [k for k, p in sorted(cand, key=lambda t: t[1]) if p <= 0.34 and k not in strengths and real_weakness(k)][:2] if ok else []
        out[g] = {
            "driver": g,
            "races": a["races"],
            "points": s["points"], "wins": s["wins"], "podiums": s["podiums"], "poles": poles,
            "bestFinish": min((r["pos"] for r in fin), default=None),
            "avgFinish": round(statistics.mean(r["pos"] for r in fin), 1) if fin else None,
            "avgGrid": round(statistics.mean(r["grid"] for _, r, _ in rows if r["grid"]), 1) if any(r["grid"] for _, r, _ in rows) else None,
            "dnf": sum(1 for _, r, _ in rows if r["status"] != "FIN"),
            "contacts": sum(r["contacts"] for _, r, _ in rows),
            "enough": ok,
            "axes": [{"key": k, "label": lbl, "pct": round(pct[g][k], 2), "rank": rank_of[g][k], "of": size_of[k]}
                     for k, lbl, _ in AXES if k in pct[g]],
            "strengths": [phrase(k, True, g, raw[g]) for k in strengths],
            "weaknesses": [phrase(k, False, g, raw[g]) for k in weaknesses],
        }
    return out


# ------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", required=True, help="export JSON du championnat")
    ap.add_argument("--out", default="data/championship.json")
    a = ap.parse_args()
    champ = json.loads(Path(a.input).read_text(encoding="utf-8-sig"))
    out = build(champ)
    for rc in out["races"]:
        rc.pop("_gridKind", None)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{out['meta']['name']}: {len(out['races'])} courses, {len(out['drivers'])} pilotes -> {a.out}")


if __name__ == "__main__":
    main()
