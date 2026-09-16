# Partey Timeline — Server

*[English](README.md) | Deutsch*

Selbst gehosteter Hitster/[HitStar](https://github.com/Born2Root/HitStar)-Klon: kein Drucken, kein
QR-Code. Spieler:innen loggen sich mit eigenem Account ein, bilden Teams (mind. 2, beliebig viele),
und spielen jede:r auf dem eigenen Handy mit — ein Team teilt sich eine Zeitleiste, jedes
Teammitglied kann am Zug der Gruppe mitziehen/mitraten.

Playlisten kommen aus **Deezer, Spotify oder YouTube** und werden beim Hinzufügen in der
Bibliothek gespeichert. Beim Spiel werden sie **gleich gewichtet** gezogen: eine Playlist mit 300
Songs kommt nicht öfter dran als eine mit 15 — wer mehr Songs beisteuert, hat keinen Vorteil.

## Wie die Playlist-Quellen funktionieren

- **Deezer**: verwendet zuerst die eigene Vorschau. Fehlt diese, prüft die App passende
  alternative Deezer-Veröffentlichungen, danach Spotify-Vorschauen und zuletzt YouTube.
- **Spotify**: liest öffentliche Playlisten vollständig und seitenweise über SpotAPI, ohne
  Spotify-Login oder eigenen API-Client. Zuerst wird die Vorschau der originalen Spotify-ID
  aus der öffentlichen Embed-Seite geprüft. Danach folgen passende Deezer-Veröffentlichungen,
  weitere Spotify-Treffer und zuletzt YouTube mit MusicBrainz-Metadaten.
  Die Importhinweise zählen Spotify-, Deezer- und YouTube-Songs getrennt.
  Spotify-Track-Links und Exportify-CSV behalten vorhandene Spotify-IDs ebenfalls bei.
  Ist SpotAPI nicht verfügbar, wird die Playlist-Embed-Seite verwendet; diese liefert höchstens
  100 Songs und der Importhinweis nennt den Fallback ausdrücklich.
  Spotify-Vorschau-URLs werden beim Abspielen frisch geladen; nicht jeder Track hat eine.
- **YouTube**: liest bis zu 300 Videos über `yt-dlp`. Titel und Interpret werden aus den
  Video-Metadaten erkannt und mit MusicBrainz abgeglichen. Nur eindeutige, passende Treffer
  mit Erscheinungsjahr werden übernommen; Titel, Interpret und Jahr kommen von MusicBrainz.
  Das Audio kommt direkt vom ursprünglichen YouTube-Video, unabhängig von Deezer.
  Beim ersten Abspielen erzeugen `yt-dlp` und `ffmpeg` einen 30-Sekunden-MP3-Clip
  (die ersten 30 Sekunden). Das kann eine kurze Ladezeit verursachen. Bis zu 32 Clips
  bleiben im Arbeitsspeicher; es werden keine Audiodateien dauerhaft gespeichert.
  Private, gesperrte oder entfernte Videos können trotz passender Metadaten nicht abspielbar sein.
  Vorhandene YouTube-Playlisten behalten ihre bisherigen Deezer-Tracks; für den neuen Ablauf
  die Playlist aus der Bibliothek entfernen und erneut importieren.

Playlisten hinzufügen kann etwas dauern (Deezer throttled bei zu vielen parallelen Anfragen sehr
aggressiv — der Import läuft deshalb bewusst langsam mit Retries; bei ~100 Songs ca. 20–80s).

## Lokal starten

```bash
npm install
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") npm start
```

Läuft dann auf `http://localhost:3000`. Ohne `SESSION_SECRET` startet der Server trotzdem (mit
Warnung), aber alle Logins gehen beim nächsten Neustart verloren. Für YouTube-Playlist-Importe
braucht es zusätzlich aktuelles `yt-dlp[default]` und `ffmpeg` im `PATH`, für die
YouTube-Audioextraktion außerdem Node.js 22 oder neuer
([yt-dlp-Laufzeit-Anforderungen](https://github.com/yt-dlp/yt-dlp/wiki/EJS)); das Docker-Image bringt diese mit.
Für vollständige Spotify-Playlisten zusätzlich `python3 -m pip install "spotapi==1.2.8" pymongo redis`
installieren. Die beiden Zusatzpakete beheben fehlende Import-Abhängigkeiten von SpotAPI;
es werden keine MongoDB- oder Redis-Server benötigt. Docker enthält diese Pakete bereits.
Deezer-Import und Spotify-Embed-Fallback funktionieren ohne Python.

## Mit Docker

```bash
cp .env.example .env
# .env öffnen und SESSION_SECRET setzen (Befehl dafür steht als Kommentar in der Datei)
docker compose up -d --build
```

Der Container bindet standardmäßig nur an `127.0.0.1:3000` (nicht öffentlich erreichbar) — gedacht
zum Dahinterschalten eines Reverse Proxies, siehe unten. Nutzer- und Playlist-Daten liegen in
`./data/store.json` (Bind-Mount, übersteht Container-Neustarts). **Aktive Logins nicht** — Sessions
leben nur im Arbeitsspeicher des Prozesses; nach einem Neustart müssen sich alle neu einloggen
(Accounts selbst bleiben erhalten).

### Das veröffentlichte Image statt selbst zu bauen

Jedes `android-v*`-Release veröffentlicht auch ein passendes Image in der GitHub
Container Registry — `ghcr.io/parteytimeline/app` zu ziehen spart das eigene
Bauen des `Dockerfile`:

```bash
docker run -d --name partey-timeline \
  --env-file .env \
  -p 127.0.0.1:3000:3000 \
  -v "$(pwd)/data:/app/data" \
  ghcr.io/parteytimeline/app:latest
```

`:latest` zeigt immer auf das neueste Release; eine bestimmte Version stattdessen mit
z. B. `ghcr.io/parteytimeline/app:0.5.3` fixieren (der Tag entspricht dem
`android-vX.Y.Z`-Release der App, ohne das `android-v`-Präfix). In `docker-compose.yml`
`build: .` durch `image: ghcr.io/parteytimeline/app:latest` ersetzen, um dasselbe zu
erreichen.

## Konfiguration

Alle Optionen (siehe `.env.example` für Details und Beispiele):

| Variable | Pflicht? | Zweck |
|---|---|---|
| `SESSION_SECRET` | für Dauerbetrieb | Ohne das gehen alle Logins beim nächsten Neustart verloren |
| `COOKIE_SECURE` | nein (Default `0`) | `1` setzen, sobald die App über HTTPS läuft |
| `PORT` | nein (Default `3000`) | nur relevant ohne Docker |
| `MUSICBRAINZ_USER_AGENT` | empfohlen | Identifiziert die Instanz gegenüber MusicBrainz (siehe deren API-Etikette) |
| `ADMIN_PASSWORD_HASH` | für Playlist-Verwaltung | bcrypt-Hash des Admin-Passworts, das Umbenennen/Löschen/Importieren von Playlisten schützt (siehe `.env.example`); ohne diese Variable ist der Bildschirm nicht verfügbar. Auf dem eigenen Host-Gerät der Android-App nicht nötig, das authentifiziert sich automatisch |

## Reverse Proxy (optional)

Für einen öffentlichen Domain-Zugriff reicht ein normaler nginx-Reverse-Proxy vor dem Container.
`deploy/nginx.example.conf` zeigt ein Beispiel für den Fall, dass die App unter einem Unterpfad
einer bestehenden Domain laufen soll (z. B. `https://deine-domain.example/partey/`) — die
`Upgrade`/`Connection`-Header sind dabei nicht optional, ohne sie bricht die WebSocket-Verbindung
ab, über die der Spielzustand läuft. Läuft die App stattdessen auf einer eigenen (Sub-)Domain,
genügt ein einfacher `location / { proxy_pass ...; }`-Block mit denselben Headern.

## Offline spielen (Vorschauen vorab herunterladen)

In der Playlist-Bibliothek lässt sich pro Playliste "📥 für offline herunterladen"
antippen — lädt alle Vorschau-Clips einmal herunter und speichert sie unter
`data/audio-cache/`. Danach kommt `/api/track/:id/preview` aus dem lokalen Cache statt per
Redirect von Deezer/Spotify bzw. Live-Generierung bei YouTube — nützlich bei wackliger
Verbindung, und Voraussetzung für komplett internetfreies Spielen über die Android-App
(siehe unten).

## Android-App: mit Freunden in der Nähe, ganz ohne Server

Im Verzeichnis `android/` liegt eine Android-App, mit der ein Handy den Server lokal
hostet und andere Handys sich **ohne gemeinsames WLAN** verbinden (Nearby Connections,
funktioniert auch wenn der Host nur Mobilfunk-Internet hat) — oder, falls der Host
zufällig im WLAN ist, per normalem Browser samt QR-Code (auch für iPhones/Laptops, ohne
App-Install). Details, Setup und bekannte Einschränkungen: [`android/README.md`](android/README.md).

### Anleitung: herunterladen, installieren und ein Spiel starten

1. **APK herunterladen.** Auf dem Handy, das als Host dienen soll, die `app-release.apk`
   aus dem [neuesten Release](https://github.com/ParteyTimeline/App/releases/latest)
   laden und die heruntergeladene Datei öffnen.
2. **Installation erlauben.** Da es sich nicht um eine Play-Store-App handelt, fragt
   Android beim ersten Mal, ob "Apps aus unbekannten Quellen" installiert werden
   dürfen — eine allgemeine, quellenunabhängige Anleitung dazu gibt es bei Heise:
   [Externe Apps: APK-Dateien bei Android installieren – so klappt's](https://www.heise.de/tipps-tricks/Externe-Apps-APK-Dateien-bei-Android-installieren-so-klappt-s-3714330.html).
   Danach die Installation bestätigen.
3. **Die abgefragten Berechtigungen erteilen** (Bluetooth, Geräte in der Nähe,
   Standort) — die verlangt Androids Nearby-Connections-API selbst, die App erhebt
   darüber keine eigenen Daten; ohne sie können Handys in der Nähe nicht gefunden
   werden.
4. **Auf dem Host-Handy** die App öffnen und das Hosting starten. Es erscheint entweder
   ein Nearby-Connections-Bildschirm (für andere Android-Handys zum Beitreten) oder,
   falls man im WLAN ist, eine IP-Adresse mit QR-Code (für jedes Gerät im selben Netz,
   auch iPhone und Laptop, zum Beitreten per Browser).
5. **Auf den beitretenden Geräten**: Andere Android-Handys brauchen dieselbe APK und
   finden den Host dann über Nearby Connections; wer im selben WLAN ist, kann
   stattdessen einfach den QR-Code scannen oder die angezeigte Adresse im Browser
   öffnen — dafür ist keine Installation nötig.
6. **Losspielen.** Alle geben einen Namen ein, bilden Teams, und der Host startet die
   Runde — siehe [`android/README.md`](android/README.md) für die Architektur im
   Detail und bekannte Einschränkungen (z. B. kein YouTube-Playback auf dem Host,
   Peers brauchen eigenes Internet für nicht zwischengespeicherte
   Deezer/Spotify-Vorschauen).

## Bekannte Einschränkungen

- Räume (laufende Spiele) leben nur im Arbeitsspeicher — ein Server-Neustart beendet alle laufenden
  Runden (Accounts/Playlisten bleiben erhalten).
- SpotAPI nutzt inoffizielle Spotify-Endpunkte, die sich ändern können. Der Embed-Fallback
  liefert höchstens 100 Songs. Vollständige Importe sind auf 10.000 Einträge begrenzt.
- YouTube-Titel-Erkennung und MusicBrainz-Abgleich garantieren keine 100 % Trefferquote.
  MusicBrainz-Abfragen sind auf etwa eine Anfrage pro Sekunde begrenzt.
- YouTube kann Audioanfragen blockieren; `yt-dlp` muss aktuell gehalten werden.
- `npm audit` zeigt eine moderate `qs`-DoS-Advisory (transitive Abhängigkeit von `express`); es
  gibt aktuell keine gepatchte Version. Für diese App (keine komplexen Query-Strings von
  Fremden) geringes Risiko, aber im Auge behalten.

## Rechtlicher Hinweis

Dieses Projekt ist ein inoffizielles, nicht-kommerzielles Fanprojekt, inspiriert von
[HitStar](https://github.com/Born2Root/HitStar) (selbst wiederum eine Fan-Umsetzung der
Spielmechanik von *Hitster*). Es steht in keiner Verbindung zu und wird nicht unterstützt von
Hitster A/S oder deren Rechteinhabern.

Die App verwendet Deezers öffentliche API und Vorschauen, Spotifys öffentliche Playlist-Metadaten über SpotAPI beziehungsweise Embed-Seiten
sowie MusicBrainz-Metadaten. Für YouTube werden Playlist-Metadaten und Audio über `yt-dlp`
abgerufen; `ffmpeg` erstellt daraus kurze Spielclips im Arbeitsspeicher. Wer diese App selbst hostet, ist
selbst dafür verantwortlich, das im eigenen Nutzungskontext (privat, nicht-kommerziell) mit den
Nutzungsbedingungen der jeweiligen Plattform sowie dem in der eigenen Rechtsordnung geltenden
Recht in Einklang zu halten.

## Lizenz

[MIT](LICENSE)
