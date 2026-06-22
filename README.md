# Cafe Daniels Bierverbrauch – Web-App

Die PWA speichert alle Einträge ausschließlich im Browser des Geräts (`localStorage`) und funktioniert nach dem ersten Laden auch offline.

## Lokal testen

Im Ordner `WebApp` einen einfachen Webserver starten, zum Beispiel:

```powershell
python -m http.server 8080
```

Danach `http://localhost:8080` öffnen.

## Auf dem iPhone verwenden

Für die Installation auf einem iPhone muss der Ordner über eine öffentliche HTTPS-Adresse bereitgestellt werden, zum Beispiel über GitHub Pages, Netlify oder einen eigenen Webserver.

Die Adresse anschließend in Safari öffnen, auf **Teilen** und dann auf **Zum Home-Bildschirm** tippen.

## GitHub Pages ohne Kommandozeile

1. Auf GitHub ein neues öffentliches Repository namens `cafe-daniels-bierverbrauch` erstellen.
2. **uploading an existing file** auswählen.
3. Den gesamten Inhalt dieses `WebApp`-Ordners in die Upload-Fläche ziehen und speichern.
4. Unter **Settings → Pages** bei **Source** „Deploy from a branch“ wählen.
5. Branch `main`, Ordner `/ (root)` auswählen und speichern.
