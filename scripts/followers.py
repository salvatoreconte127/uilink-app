#!/usr/bin/env python3
"""Aggiorna data/followers.json con i follower di Instagram, Facebook e TikTok.

Variabili d'ambiente (GitHub Secrets):
  META_PAGE_ID, META_PAGE_TOKEN   -> Facebook + Instagram (Instagram collegato alla Pagina)
  IG_TOKEN                        -> in alternativa per Instagram (token "Instagram Login")
  TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_REFRESH_TOKEN -> TikTok (API Display)
Se TikTok restituisce un nuovo refresh token lo scrive in $NEW_TIKTOK_REFRESH_FILE,
così il workflow può aggiornare il secret.
Se una piattaforma non risponde, resta l'ultimo valore salvato.
"""
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data" / "followers.json"
NOW = datetime.now(timezone.utc).isoformat(timespec="minutes")
env = os.environ.get
log = lambda *a: print(*a, file=sys.stderr, flush=True)


def get(url, headers=None, data=None):
    req = urllib.request.Request(url, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def meta(res):
    pid, tok = env("META_PAGE_ID"), env("META_PAGE_TOKEN")
    if not (pid and tok):
        return
    q = urllib.parse.urlencode({
        "fields": "name,followers_count,fan_count,instagram_business_account{followers_count,username}",
        "access_token": tok,
    })
    d = get(f"https://graph.facebook.com/{pid}?{q}")
    fb = d.get("followers_count") or d.get("fan_count")
    if fb is not None:
        res["facebook"] = {"count": fb, "aggiornato": NOW, "auto": True}
    ig = d.get("instagram_business_account") or {}
    if ig.get("followers_count") is not None:
        res["instagram"] = {"count": ig["followers_count"], "aggiornato": NOW, "auto": True}


def instagram_login(res):
    tok = env("IG_TOKEN")
    if not tok or res.get("instagram", {}).get("aggiornato") == NOW:
        return
    d = get("https://graph.instagram.com/me?" + urllib.parse.urlencode(
        {"fields": "username,followers_count", "access_token": tok}))
    if d.get("followers_count") is not None:
        res["instagram"] = {"count": d["followers_count"], "aggiornato": NOW, "auto": True}


def tiktok(res):
    key, secret, refresh = env("TIKTOK_CLIENT_KEY"), env("TIKTOK_CLIENT_SECRET"), env("TIKTOK_REFRESH_TOKEN")
    if not (key and secret and refresh):
        return
    tok = get("https://open.tiktokapis.com/v2/oauth/token/",
              {"Content-Type": "application/x-www-form-urlencoded"},
              urllib.parse.urlencode({"client_key": key, "client_secret": secret,
                                      "grant_type": "refresh_token", "refresh_token": refresh}).encode())
    if "access_token" not in tok:
        raise RuntimeError(f"refresh TikTok fallito: {tok.get('error')} {tok.get('error_description')}")
    new_refresh = tok.get("refresh_token")
    if new_refresh and new_refresh != refresh and env("NEW_TIKTOK_REFRESH_FILE"):
        Path(env("NEW_TIKTOK_REFRESH_FILE")).write_text(new_refresh)
    d = get("https://open.tiktokapis.com/v2/user/info/?fields=follower_count,display_name",
            {"Authorization": "Bearer " + tok["access_token"]})
    user = (d.get("data") or {}).get("user") or {}
    if user.get("follower_count") is not None:
        res["tiktok"] = {"count": user["follower_count"], "aggiornato": NOW, "auto": True}
    else:
        raise RuntimeError(f"risposta TikTok inattesa: {d.get('error')}")


def main():
    res = json.loads(OUT.read_text()) if OUT.exists() else {}
    for name, fn in (("Meta", meta), ("Instagram", instagram_login), ("TikTok", tiktok)):
        try:
            fn(res)
        except Exception as e:  # noqa: BLE001
            log(f"!! {name}: {e}")
    OUT.write_text(json.dumps(res, indent=1))
    log(json.dumps(res))


if __name__ == "__main__":
    main()
