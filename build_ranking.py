#!/usr/bin/env python3
"""
Convertit les résultats du serveur Assetto Corsa (fichiers results/*.json
de acServer, AssettoServer ou Server Manager) en data/ranking.json,
le fichier lu par la page web.

Usage :
    python3 build_ranking.py --results /chemin/vers/results --config config.json --out data/ranking.json

Seule la fonction parse_session() dépend du format des fichiers de résultats.
Tout le reste (barème, poles, meilleurs tours, championnats) est générique.
"""
import argparse
import hashlib
import json
import re
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

NO_LAP = 99_000_000  # acServer écrit ~999999999 quand il n'y a pas de tour


# --------------------------------------------------------------------------
# Lecture des fichiers de résultats (format acServer / AC1)
# --------------------------------------------------------------------------
def parse_date(data, path):
    raw = data.get("Date")
    if raw:
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc)
        except ValueError:
            pass
    m = re.match(r"(\d{4})_(\d{1,2})_(\d{1,2})_(\d{1,2})_(\d{1,2})", path.name)
    if m:
        y, mo, d, h, mi = map(int, m.groups())
        return datetime(y, mo, d, h, mi, tzinfo=timezone.utc)
    return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)


def pretty(name):
    name = re.sub(r"^(ks_|layout_|acu_)", "", name or "")
    return " ".join(w.capitalize() for w in name.replace("-", "_").split("_") if w)


def parse_session(path, cfg):
    """Retourne un dict normalisé, ou None si le fichier n'est pas une session."""
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or "Result" not in data:
        return None

    laps = data.get("Laps", [])
    ignore_cuts = cfg.get("ignoreCutLaps", True)

    lap_count = Counter(str(l.get("DriverGuid") or "").strip() for l in laps if isinstance(l, dict))
    clean_best = {}
    for l in laps:
        t = l.get("LapTime", 0)
        if t <= 0 or t >= NO_LAP:
            continue
        if ignore_cuts and l.get("Cuts", 0) > 0:
            continue
        g = str(l.get("DriverGuid") or "").strip()
        if g not in clean_best or t < clean_best[g]:
            clean_best[g] = t

    entries = []
    for r in data.get("Result", []):
        guid = str(r.get("DriverGuid") or "").strip()
        if not guid:
            continue
        best = clean_best.get(guid)
        if best is None:
            rb = r.get("BestLap", 0)
            best = rb if 0 < rb < NO_LAP and not ignore_cuts else 0
        entries.append({
            "guid": guid,
            "name": (r.get("DriverName") or guid).strip(),
            "car": pretty(r.get("CarModel", "")),
            "laps": lap_count.get(guid, 0),
            "totalTime": int(r.get("TotalTime", 0) or 0),
            "bestLap": int(best or 0),
        })

    return {
        "path": path.name,
        "type": str(data.get("Type", "")).upper(),
        "date": parse_date(data, path),
        "trackId": data.get("TrackName", ""),
        "layoutId": data.get("TrackConfig", ""),
        "durationSecs": int(data.get("DurationSecs", 0) or 0),
        "entries": entries,
    }


# --------------------------------------------------------------------------
# Règles du classement
# --------------------------------------------------------------------------
def base_points(pos, scoring):
    scale = scoring["baseScale"]
    return scale[pos - 1] if pos <= len(scale) else scoring["beyond"]


def find_championship(local_day, cfg):
    for c in cfg.get("championships", []):
        if c["from"] <= local_day <= c["to"]:
            return c
    return {"id": "hors-championnat", "name": "Hors championnat", "level": "open"}


def classify(entries, min_ratio):
    """Ordre d'arrivée : les classés d'abord (dans l'ordre du fichier), puis les abandons."""
    if not entries:
        return [], []
    max_laps = max(e["laps"] for e in entries)
    finished, dnf = [], []
    for e in entries:
        ok = e["totalTime"] > 0 and max_laps > 0 and e["laps"] >= min_ratio * max_laps
        (finished if ok else dnf).append(e)
    finished.sort(key=lambda e: (-e["laps"], e["totalTime"], e["guid"]))
    dnf.sort(key=lambda e: (-e["laps"], e["guid"]))
    return finished, dnf


def pole_for(race, qualifs, max_hours):
    best = None
    for q in qualifs:
        if q["trackId"] != race["trackId"] or q["layoutId"] != race["layoutId"]:
            continue
        delta = race["date"] - q["date"]
        if not (timedelta(0) <= delta <= timedelta(hours=max_hours)):
            continue
        times = [(e["bestLap"], e["guid"]) for e in q["entries"] if e["bestLap"] > 0]
        if times:
            cand = (q["date"], min(times)[1])
            if best is None or cand[0] > best[0]:
                best = cand
    return best[1] if best else None


# --------------------------------------------------------------------------
def build(results_dir, cfg):
    tz = ZoneInfo(cfg.get("timezone", "Europe/Paris"))
    scoring = cfg["scoring"]
    min_ratio = cfg.get("minLapRatio", 0.5)
    min_drivers = cfg.get("minDrivers", 2)
    endurance = cfg.get("endurance", {"minMinutes": 0, "multiplier": 1})

    sessions = []
    for p in sorted(Path(results_dir).rglob("*.json")):
        s = parse_session(p, cfg)
        if s:
            sessions.append(s)
    if not sessions:
        sys.exit(f"Aucun fichier de résultats trouvé dans {results_dir}")

    qualifs = [s for s in sessions if s["type"].startswith("QUALIF")]
    races_raw = sorted((s for s in sessions if s["type"] == "RACE"), key=lambda s: s["date"])

    drivers = {}
    overrides = cfg.get("drivers", {})

    def register(guid, name):
        d = drivers.setdefault(guid, {"id": guid, "name": name, "category": None})
        d["name"] = name  # dernier pseudo vu
        o = overrides.get(guid)
        if o:
            d["name"] = o.get("name", d["name"])
            d["category"] = o.get("category")

    races = []
    for s in races_raw:
        if len(s["entries"]) < min_drivers:
            continue
        local_day = s["date"].astimezone(tz).strftime("%Y-%m-%d")
        champ = find_championship(local_day, cfg)
        level = champ["level"]
        level_cfg = scoring["levels"].get(level, scoring["levels"]["open"])
        mult = level_cfg["multiplier"]
        is_endurance = endurance.get("minMinutes", 0) > 0 and s["durationSecs"] >= endurance["minMinutes"] * 60
        if is_endurance:
            mult *= endurance.get("multiplier", 1)

        finished, dnf = classify(s["entries"], min_ratio)
        results = []
        for i, e in enumerate(finished, start=1):
            register(e["guid"], e["name"])
            results.append({
                "driver": e["guid"], "pos": i, "status": "FIN",
                "points": round(base_points(i, scoring) * mult),
                "car": e["car"], "laps": e["laps"],
                "totalTime": e["totalTime"], "bestLap": e["bestLap"],
            })
        for j, e in enumerate(dnf, start=len(finished) + 1):
            register(e["guid"], e["name"])
            results.append({
                "driver": e["guid"], "pos": j, "status": "DNF", "points": 0,
                "car": e["car"], "laps": e["laps"],
                "totalTime": 0, "bestLap": e["bestLap"],
            })

        laps_times = [(r["bestLap"], r["driver"]) for r in results if r["bestLap"] > 0]
        fastest = None
        if laps_times:
            t, g = min(laps_times)
            fastest = {"driver": g, "time": t}

        track = pretty(s["trackId"])
        layout = pretty(s["layoutId"])
        label = f"{track} — {layout}" if layout and layout.lower() != track.lower() else track
        stamp = s["date"].astimezone(tz).strftime("%Y%m%d-%H%M")
        races.append({
            "id": f"{stamp}-{s['trackId']}-{hashlib.sha256(s['path'].encode('utf-8')).hexdigest()[:12]}",
            "date": s["date"].strftime("%Y-%m-%dT%H:%M:%SZ"),
            "championship": champ["id"],
            "championshipName": champ["name"],
            "level": level,
            "endurance": is_endurance,
            "durationMinutes": round(s["durationSecs"] / 60),
            "trackKey": f"{s['trackId']}/{s['layoutId']}",
            "track": label,
            "pole": pole_for(s, qualifs, cfg.get("poleMaxHoursBeforeRace", 6)),
            "fastestLap": fastest,
            "results": results,
        })

    return {
        "meta": {
            "serverName": cfg.get("serverName", "Serveur Assetto Corsa"),
            "simulator": cfg.get("simulator", "Assetto Corsa"),
            "timezone": cfg.get("timezone", "Europe/Paris"),
            "windowYears": cfg.get("windowYears", 5),
            "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "enduranceMultiplier": endurance.get("multiplier", 1) if endurance.get("minMinutes", 0) else None,
            "enduranceMinMinutes": endurance.get("minMinutes", 0),
        },
        "scoring": scoring,
        "championships": cfg.get("championships", []),
        "drivers": drivers,
        "races": races,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--results", required=True, help="dossier contenant les fichiers de résultats .json")
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--out", default="data/ranking.json")
    a = ap.parse_args()

    cfg = json.loads(Path(a.config).read_text(encoding="utf-8"))
    out = build(a.results, cfg)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(out['races'])} courses, {len(out['drivers'])} pilotes -> {a.out}")


if __name__ == "__main__":
    main()
