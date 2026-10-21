#!/usr/bin/env python3
"""Builds the offline Quran data used by the app.

Run:  python3 tools/build_data.py
Writes data/surahs.json, data/quran/<n>.json (Arabic, transliteration, English, Swahili,
French), data/notes-index.json (which surahs have simple verse notes),
data/meanings-index.json (which lessons have "what the Prophet and scholars said" notes in
data/meanings/<n>.json) and data/study-order.json (Study order: shortest surahs first).
Text comes from api.alquran.cloud (Tanzil text; see the credits in the app).
"""
import json, os, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EDITIONS = {
    "ar": "quran-uthmani",
    "tl": "en.transliteration",
    "en": "en.itani",
    "sw": "sw.barwani",
    "fr": "fr.hamidullah",
}

def get(path):
    with urllib.request.urlopen("https://api.alquran.cloud/v1/" + path, timeout=60) as r:
        return json.load(r)["data"]

def main():
    os.makedirs(os.path.join(ROOT, "data", "quran"), exist_ok=True)
    surahs = get("surah")
    assert len(surahs) == 114
    books = {}
    for key, edition in EDITIONS.items():
        data = get("quran/" + edition)
        books[key] = [[a["text"] for a in s["ayahs"]] for s in data["surahs"]]
        assert len(books[key]) == 114, key
    total = 0
    for i, s in enumerate(surahs):
        n = s["number"]
        counts = {k: len(books[k][i]) for k in books}
        assert all(c == s["numberOfAyahs"] for c in counts.values()), (n, counts, s["numberOfAyahs"])
        out = {k: books[k][i] for k in books}
        with open(os.path.join(ROOT, "data", "quran", f"{n}.json"), "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        total += s["numberOfAyahs"]
    with open(os.path.join(ROOT, "data", "surahs.json"), "w", encoding="utf-8") as f:
        json.dump(surahs, f, ensure_ascii=False, separators=(",", ":"))
    notes_dir = os.path.join(ROOT, "data", "ayah-simple")
    have = sorted(int(x[:-5]) for x in os.listdir(notes_dir) if x.endswith(".json")) if os.path.isdir(notes_dir) else []
    with open(os.path.join(ROOT, "data", "notes-index.json"), "w") as f:
        json.dump(have, f)
    meanings_dir = os.path.join(ROOT, "data", "meanings")
    meanings = sorted(int(x[:-5]) for x in os.listdir(meanings_dir) if x.endswith(".json")) if os.path.isdir(meanings_dir) else []
    with open(os.path.join(ROOT, "data", "meanings-index.json"), "w") as f:
        json.dump(meanings, f)
    # Shortest first: fewest Arabic words in the whole surah, then fewest ayahs.
    # The Bismillah (first 4 words) is not part of ayah 1, so it is not counted (Al-Fatiha and At-Tawbah excepted).
    def count_words(i):
        verses = list(books["ar"][i])
        if i + 1 not in (1, 9) and len(verses[0].split()) > 4:
            verses[0] = " ".join(verses[0].split()[4:])
        return sum(len(t.split()) for t in verses)
    words = {i + 1: count_words(i) for i in range(114)}
    order = sorted(range(1, 115), key=lambda n: (words[n], surahs[n - 1]["numberOfAyahs"], n))
    with open(os.path.join(ROOT, "data", "study-order.json"), "w") as f:
        json.dump(order, f)
    print(f"ok: 114 surahs, {total} verses, notes for {len(have)} surahs")

if __name__ == "__main__":
    main()
