# Partey Timeline — Nearby (Android)

*[English](README.md) | Deutsch*

Android-App, um **ohne gehosteten Server** mit Freunden in der Nähe zu spielen. Ein Handy
("Host") startet den bestehenden Node-Server lokal eingebettet und hält den Spielstand
(wie beim normalen Web-Betrieb); andere Handys verbinden sich darauf auf zwei Wegen:

- **Nearby Connections** (Bluetooth/Wi-Fi Direct): funktioniert **ohne gemeinsames WLAN**
  und auch wenn der Host nur Mobilfunk-Internet hat — braucht die App auch auf den
  beitretenden Geräten (nur Android).
- **Browser im selben WLAN**: falls der Host zufällig im WLAN ist, zeigt die App eine IP
  + einen QR-Code — jedes Gerät im selben Netz (auch iPhone/Laptop) kann dann ganz normal
  per Browser mitspielen, ganz ohne App-Install.

Die Web-UI (`public/`) läuft dabei unverändert in einer WebView — `public/app.js` baut
WebSocket-URL und Fetch-Pfade bereits relativ zu `location.host`/`location.pathname` auf,
weshalb ein reiner **TCP-Byte-Tunnel** (kein HTTP/WS-Parsing) als Bridge zum Host reicht.

## Architektur (Kurzfassung)

```
Host-Handy: eingebetteter Node-Server (nodejs-mobile) auf 127.0.0.1:3000
            ↕ TCP
   HostTunnelServer  ←── Mux über Nearby Connections ──→  PeerTunnelClient
   (tunnel/Tunnel.kt)   (zwei STREAM-Payloads = ein         (tunnel/Tunnel.kt)
                         Full-Duplex-Link, siehe             ↕
                         nearby/NearbyHost.kt)          lokaler Port → WebView (Peer)
```

`tunnel/MuxProtocol.kt` + `tunnel/Tunnel.kt` sind reines Kotlin/JVM ohne Android-Imports
und mit `./gradlew test` prüfbar (`MuxProtocolTest`, `TunnelIntegrationTest`) — siehe
unten. `nearby/NearbyHost.kt`/`NearbyPeer.kt` sind die Android-spezifische Anbindung an
die Nearby-Connections-API (zwei STREAM-Payloads pro Verbindung, je eine Richtung, exakt
wie im offiziellen `NearbyConnectionsWalkieTalkie`-Beispiel von Google).

## Setup

1. **libnode-Binaries laden** (nicht im Git, ~55 MB, drei ABIs):
   ```bash
   ../scripts/fetch-libnode.sh
   ```
2. In Android Studio öffnen (`android/` als Projekt). Der erste Gradle-Sync installiert
   bei Bedarf NDK 26.1.10909125 und CMake 3.22.1 automatisch.
3. Der `:app:syncNodeProject`-Task kopiert `server.js`/`src/`/`public/`/`package.json`/
   `node_modules` bei jedem Build frisch aus dem Repo-Root nach
   `app/src/main/assets/nodejs-project/` — keine manuelle Kopie nötig, keine
   Server-Code-Duplizierung im Android-Projekt.
4. Auf **zwei echten Android-Geräten** installieren (Nearby Connections braucht echte
   BLE-/Wi-Fi-Direct-Radios — funktioniert in Standard-Emulatoren nicht zuverlässig, siehe
   unten).

## Berechtigungen

Nearby Connections' Berechtigungsmodell hat sich über Android-Versionen mehrfach
geändert; `nearby/NearbyPermissions.kt` und das Manifest bilden das 1:1 nach Googles
eigenem Referenzcode ab (`android/connectivity-samples`, `NearbyConnectionsWalkieTalkie`):
Bluetooth-Scan/Advertise/Connect + `NEARBY_WIFI_DEVICES` ab Android 13, Standort ab
Android 12 bzw. älter je nach OS-Version.

## Was zuverlässig getestet ist — und was nicht

- **`tunnel/` per Unit-Test verifiziert**: `MuxProtocolTest` (Framing/Edge-Cases) und
  `TunnelIntegrationTest` (Host+Peer über einen echten Loopback-Socket, mehrere parallele
  Verbindungen, Payload > 1 internem Puffer) laufen als reine JVM-Tests, keine
  Android-Abhängigkeit. `./gradlew test` ausführen.
- **Restliche App (Kotlin/Ressourcen/Manifest/Gradle-Setup inkl. NDK/CMake) wurde per
  `gradle assembleDebug` in einer isolierten Docker-Umgebung gebaut** (Android SDK 34,
  NDK 26.1.10909125, echte libnode-Binaries) — kompiliert und paketiert erfolgreich zu
  einer APK. Das prüft, dass der Code compilable ist, **nicht** dass Nearby Connections,
  der eingebettete Node-Server oder die WebView zur Laufzeit korrekt funktionieren.
- **Keine automatisierte Geräte-Farm/CI-Abdeckung für echtes Geräteverhalten**
  (Nearby Connections, der eingebettete Node-Server, die WebView): In dieser
  Entwicklungsumgebung ist kein Android-Emulator mit Hardwarebeschleunigung
  verfügbar (kein `/dev/kvm`), und Nearby Connections braucht ohnehin echte
  Bluetooth/Wi-Fi-Direct-Radios, die kein Emulator zuverlässig nachbildet. In der
  Praxis wurden die zentralen Abläufe (Hosten/Beitreten, der Nearby-Tunnel,
  Host-Control, Playlist-Import/-Export) stattdessen vor jedem Release manuell auf
  echten Geräten per `adb` verifiziert — das ist aber manuelles Testen, keine
  wiederholbare automatisierte Suite. **Vor dem ersten echten Spielabend mit einem
  eigenen Fork trotzdem unbedingt manuell durchspielen** (Login, Raum, Team, Song
  ziehen/platzieren, Audio — mit und ohne gemeinsames WLAN, siehe Checkliste im
  Hauptprojekt-Kontext).

## Bekannte Einschränkungen

- **Kein YouTube-Import/-Wiedergabe auf dem Host-Handy**: `yt-dlp`/`ffmpeg` sind externe
  Binaries, die hier nicht mitgebaut werden. Deezer- und Spotify-Playlisten funktionieren
  voll (inkl. Offline-Cache, siehe Haupt-README). Eine mitgebrachte `data/store.json` mit
  YouTube-Playlisten importiert zwar, Wiedergabe schlägt aber fehl.
- **Peers brauchen weiterhin eigenes Internet für Deezer/Spotify-Vorschauen** (302-Redirect
  direkt zur jeweiligen CDN, am Tunnel vorbei) — außer die Playlist wurde vorher über
  "Vorschauen herunterladen" auf dem Host zwischengespeichert; dann läuft alles rein über
  den Tunnel bzw. das LAN, auch ganz ohne Internet.
- **Nur der Host hält eine Foreground-Notification** (`HostForegroundService`) — Peers
  laufen nur innerhalb der App-Lebensdauer; wird die App auf einem Peer-Gerät in den
  Hintergrund geschickt, kann die Verbindung abbrechen.
- Viele gleichzeitige Peers unter Last sind bewusst nicht Teil dieser ersten
  Version.

## Neuverbindung nach Verbindungsabbruch

Eine Nearby-Verbindung kann aus Gründen abbrechen, die nichts mit dem Spiel selbst zu
tun haben — ein paar Meter außerhalb der Bluetooth-/Wi-Fi-Direct-Reichweite laufen, das
OS pausiert kurz die Funkmodule, der Bildschirm eines Peers wird gesperrt. Da der
eigentliche Spielstand serverseitig hinter dem Session-Cookie des Hosts liegt (siehe
`/api/local/join` in `server.js`), ist ein neuer Tunnel für die Web-App funktional
nicht vom alten zu unterscheiden — beide Seiten erholen sich deshalb automatisch,
statt einen manuellen Neubeitritt vom Startbildschirm zu erzwingen:

- **Peer-Seite** (`nearby/NearbyPeer.kt`): Ein unerwarteter Verbindungsabbruch (kein
  von der App selbst ausgelöster) löst automatische Neuverbindungsversuche mit
  exponentiellem Backoff aus (1s, 2s, 4s, 8s, gedeckelt, bis zu 20 Versuche — insgesamt
  einige Minuten) gegen denselben Host, zunächst per Endpoint-ID, sonst per Anzeigename
  falls sich die ID des Hosts geändert hat. `GameWebViewActivity` zeigt währenddessen
  ein "Verbinde neu…"-Banner und lädt die WebView nach erfolgreicher Neuverbindung mit
  dem neuen Tunnel-Port neu — der lokale Port, den ein `PeerTunnelClient` bindet, kann
  sich nach einem Abbruch ändern. Sind alle Versuche ausgeschöpft, erscheint eine
  Fehlermeldung und es geht zurück zum Startbildschirm.
- **Host-Seite** (`nearby/NearbyHost.kt`): Das Advertising selbst läuft über
  Peer-Abbrüche hinweg einfach weiter, ein neu verbindender Peer sieht daher wie eine
  ganz normale neue eingehende Verbindung aus — dafür ist keine host-seitige
  Buchhaltung nötig. Was mit demselben Backoff neu versucht wird, ist ein
  fehlgeschlagener (Neu-)Start des Advertisings selbst (z. B. ein vorübergehender
  GMS-/Bluetooth-Fehler), damit der Host für neue oder neu verbindende Peers nicht
  einfach unsichtbar bleibt.
