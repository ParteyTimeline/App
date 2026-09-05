# Partey Timeline — Server

Selbst gehosteter Hitster/[HitStar](https://github.com/Born2Root/HitStar)-Klon: kein Drucken, kein
QR-Code. Spieler:innen loggen sich mit eigenem Account ein, bilden Teams (mind. 2, beliebig viele),
und spielen jede:r auf dem eigenen Handy mit — ein Team teilt sich eine Zeitleiste, jedes
Teammitglied kann am Zug der Gruppe mitziehen/mitraten.

Playlisten kommen aus **Deezer, Spotify oder YouTube** und werden beim Hinzufügen in der
Bibliothek gespeichert. Beim Spiel werden sie **gleich gewichtet** gezogen: eine Playlist mit 300
Songs kommt nicht öfter dran als eine mit 15 — wer mehr Songs beisteuert, hat keinen Vorteil.

## Wie die Playlist-Quellen funktionieren

- **Deezer**: nativ, volle Metadaten (Erscheinungsjahr, Cover, 30s-Vorschau) direkt von der
  öffentlichen Deezer-API.
- **Spotify**: liest die öffentliche Embed-Seite (`open.spotify.com/embed/playlist/<id>`) — keine
  API-Keys nötig, aber **nur die ersten 100 Songs** einer Playlist (Embed-Seiten-Limit). Jeder Song
  wird danach per Titel/Interpret auf Deezer gesucht und darüber gespielt (Erscheinungsjahr kommt
  von Deezer, nicht von Spotify).
- **YouTube**: liest die Playlist über `yt-dlp` (muss auf dem Server installiert sein/ist im
  Docker-Image enthalten), max. 300 Videos. Songtitel werden aus dem Video-Titel heuristisch
  geraten (`Artist - Titel`-Muster) und ebenfalls auf Deezer gematcht — Trefferquote hängt stark
  davon ab, wie sauber die Video-Titel sind (in Tests: 64–91 %). Nicht gefundene Songs werden
  einfach übersprungen; die Antwort beim Hinzufügen zeigt, wie viele es waren.

Playlisten hinzufügen kann etwas dauern (Deezer throttled bei zu vielen parallelen Anfragen sehr
aggressiv — der Import läuft deshalb bewusst langsam mit Retries; bei ~100 Songs ca. 20–80s).

## Lokal starten

```bash
npm install
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") npm start
```

Läuft dann auf `http://localhost:3000`. Ohne `SESSION_SECRET` startet der Server trotzdem (mit
Warnung), aber alle Logins gehen beim nächsten Neustart verloren. Für YouTube-Playlist-Importe
braucht es zusätzlich `yt-dlp` im `PATH` (Deezer- und Spotify-Import funktionieren ohne); das
Docker-Image bringt es bereits mit.

## Mit Docker

```bash
cp .env.example .env
# .env öffnen und SESSION_SECRET setzen (Befehl dafür steht als Kommentar in der Datei)
docker compose up -d --build
```

Der Container bindet standardmäßig nur an `127.0.0.1:4001` (nicht öffentlich erreichbar) — gedacht
zum Dahinterschalten eines Reverse Proxies, siehe unten. Nutzer- und Playlist-Daten liegen in
`./data/store.json` (Bind-Mount, übersteht Container-Neustarts). **Aktive Logins nicht** — Sessions
leben nur im Arbeitsspeicher des Prozesses; nach einem Neustart müssen sich alle neu einloggen
(Accounts selbst bleiben erhalten).

## Konfiguration

Alle Optionen (siehe `.env.example` für Details und Beispiele):

| Variable | Pflicht? | Zweck |
|---|---|---|
| `SESSION_SECRET` | für Dauerbetrieb | Ohne das gehen alle Logins beim nächsten Neustart verloren |
| `COOKIE_SECURE` | nein (Default `0`) | `1` setzen, sobald die App über HTTPS läuft |
| `PORT` | nein (Default `3000`) | nur relevant ohne Docker |
| `MUSICBRAINZ_USER_AGENT` | empfohlen | Identifiziert die Instanz gegenüber MusicBrainz (siehe deren API-Etikette) |

## Reverse Proxy (optional)

Für einen öffentlichen Domain-Zugriff reicht ein normaler nginx-Reverse-Proxy vor dem Container.
`deploy/nginx.example.conf` zeigt ein Beispiel für den Fall, dass die App unter einem Unterpfad
einer bestehenden Domain laufen soll (z. B. `https://deine-domain.example/partey/`) — die
`Upgrade`/`Connection`-Header sind dabei nicht optional, ohne sie bricht die WebSocket-Verbindung
ab, über die der Spielzustand läuft. Läuft die App stattdessen auf einer eigenen (Sub-)Domain,
genügt ein einfacher `location / { proxy_pass ...; }`-Block mit denselben Headern.

## Bekannte Einschränkungen

- Räume (laufende Spiele) leben nur im Arbeitsspeicher — ein Server-Neustart beendet alle laufenden
  Runden (Accounts/Playlisten bleiben erhalten).
- Spotify-Import liest nur die ersten 100 Songs einer Playlist (Embed-Seiten-Limit).
- YouTube-Titel-Erkennung ist ein Best-Effort-Regex, keine Garantie für 100 % Trefferquote.
- `npm audit` zeigt eine moderate `qs`-DoS-Advisory (transitive Abhängigkeit von `express`); es
  gibt aktuell keine gepatchte Version. Für diese App (keine komplexen Query-Strings von
  Fremden) geringes Risiko, aber im Auge behalten.

## Rechtlicher Hinweis

Dieses Projekt ist ein inoffizielles, nicht-kommerzielles Fanprojekt, inspiriert von
[HitStar](https://github.com/Born2Root/HitStar) (selbst wiederum eine Fan-Umsetzung der
Spielmechanik von *Hitster*). Es steht in keiner Verbindung zu und wird nicht unterstützt von
Hitster A/S oder deren Rechteinhabern.

Die App liest ausschließlich öffentlich zugängliche Metadaten und offizielle Vorschau-Mechanismen:
Deezers öffentliche API (inkl. der von Deezer selbst bereitgestellten 30-Sekunden-Vorschauen),
Spotifys öffentliche Embed-Seiten (keine Downloads, keine API-Keys) und `yt-dlp` ausschließlich
zum Lesen von YouTube-Playlist-**Metadaten** (Titel/Videoliste) — es wird zu keinem Zeitpunkt
Audio oder Video von YouTube heruntergeladen oder extrahiert. Wer diese App selbst hostet, ist
selbst dafür verantwortlich, das im eigenen Nutzungskontext (privat, nicht-kommerziell) mit den
Nutzungsbedingungen der jeweiligen Plattform sowie dem in der eigenen Rechtsordnung geltenden
Recht in Einklang zu halten.

## Lizenz

[MIT](LICENSE)
