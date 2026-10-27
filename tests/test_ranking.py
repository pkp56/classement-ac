import unittest
from build_ranking import classify, pole_for
from datetime import datetime, timezone, timedelta

class RankingTests(unittest.TestCase):
    def test_order_independent(self):
        entries = [
            {"guid": "slow", "laps": 10, "totalTime": 110000},
            {"guid": "dnf", "laps": 2, "totalTime": 0},
            {"guid": "fast", "laps": 10, "totalTime": 100000},
        ]
        finished, dnf = classify(entries, 0.5)
        self.assertEqual([e["guid"] for e in finished], ["fast", "slow"])
        self.assertEqual([e["guid"] for e in dnf], ["dnf"])

    def test_all_abandoned(self):
        finished, dnf = classify([{"guid": "a", "laps": 0, "totalTime": 0}], 0.5)
        self.assertEqual(finished, [])
        self.assertEqual(len(dnf), 1)

    def test_pole_uses_fastest_qualifier(self):
        date = datetime(2026, 10, 27, 12, tzinfo=timezone.utc)
        race = {"date": date, "trackId": "track", "layoutId": ""}
        q = {"date": date - timedelta(hours=1), "trackId": "track", "layoutId": "",
             "entries": [{"guid": "slow", "bestLap": 80000}, {"guid": "fast", "bestLap": 70000}]}
        self.assertEqual(pole_for(race, [q], 6), "fast")

if __name__ == "__main__":
    unittest.main()
