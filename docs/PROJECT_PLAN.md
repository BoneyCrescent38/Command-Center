# Command Center – prosjektplan

## Visjon

Bygge et personlig, modulært **Command Center** spesielt for **Corsair Xeneon Edge 14.5\" 2560×720 touch**, drevet direkte av Windows-PC-en.

Skjermen skal føles som en egen enhet, selv om PC-en driver den:

**PC starter → Command Center åpner automatisk → fullskjerm → ingen nettleserfaner, adresselinje eller annen browser chrome.**

Command Center skal ikke være en ny versjon av Project Dashboard. Det skal være et **skall/plattform som kan inneholde flere små apper og visninger**.

## Grunnprinsipp

En fast navigasjon på venstre side viser egne app-ikoner. Eksempler:

- Project Dashboard
- Spotify
- Skole
- Gaming
- senere andre apper/integrasjoner

Når brukeren trykker på et ikon, skal kun hovedinnholdet byttes. Man skal ikke måtte forlate Command Center eller bruke vanlig browser-navigasjon.

## Første app: Project Dashboard

Lag en egen Edge-layout for Project Dashboard.

Denne skal **ikke endre dagens `dashboard.liverod.app`-UI**. Command Center skal i stedet hente de samme dataene og presentere dem i en egen layout tilpasset 2560×720.

Aktuelle data:

- Codex / Work-kapasitet
- dagens retning / neste steg
- valgt arbeidsområde / fokus
- aktive prosjekter
- prosjekter på vent
- server- og appstatus
- Google Sheet-status

Plassering og størrelse bestemmes av Command Center-layouten, uavhengig av hoveddashboardet.

## Modulær arkitektur

Hver funksjon bør kunne legges til som en separat app/modul. En app bør grovt kunne definere:

- `id`
- navn
- ikon
- view/component
- datakilde
- eventuelle handlinger

Venstremenyen skal kunne utvides uten at hele UI-et må bygges om.

## Spotify senere

Spotify er et naturlig eksempel på neste integrasjon. Ønsket kontrollflate:

- albumcover
- sang
- artist
- play/pause
- neste/forrige
- eventuelt volum

Integrasjonen skal undersøkes mot offisiell Spotify-API/integrasjon når vi kommer dit.

## Display og interaksjon

Primær target:

- **2560 × 720 px**
- **32:9**
- **60 Hz**
- touch

Designkrav:

- fullskjerm/app-mode
- ingen browser chrome
- touch-first
- store nok trykkflater
- ingen hover-only-funksjoner
- minimalt behov for scrolling
- informasjon skal kunne forstås med et raskt blikk

Det skal finnes en utviklings-/preview-modus som viser nøyaktig **2560×720** på vanlig PC før den fysiske skjermen er på plass.

## Første milepæl: V0 – Command Center Shell

Bygg først fundamentet:

1. fullskjerms skall i 2560×720
2. fast venstre app-rail
3. placeholder-apps for Dashboard, Spotify, Skole og Gaming
4. fungerende app-switching
5. egen 2560×720 preview/dev-mode
6. Project Dashboard som første ekte datadrevne modul
7. struktur klar for flere apper senere

Unngå overkomplisert backend før det faktisk trengs.

## Senere muligheter

Mulige videre steg:

- Spotify
- skoleverktøy
- gaming/systeminformasjon
- mediakontroll
- flere lokale app-statusser
- PC-kontroller
- fysiske knapper/NFC
- andre integrasjoner

## Viktige avgrensninger

Command Center skal være **et eget prosjekt og eget repo**.

Det skal ikke:

- bygge om Project Dashboard
- kopiere hele Project Dashboard-koden hvis data kan deles via API
- endre KIF Vanskebygger
- være avhengig av Corsair iCUE for grunnfunksjonalitet
- låses til bare én app
- kreve browserfaner eller vanlig nettlesernavigasjon i daglig bruk

## Første Codex-oppgave

Før implementasjon skal Codex:

1. lese denne planen
2. foreslå en enkel V0-arkitektur
3. prioritere modulært app-shell, 2560×720 preview og Project Dashboard som første datadrevne app
4. unngå unødvendig kompleksitet
5. deretter bygge den første kjørbare prototypen

Selve visuelle detaljdesignet skal itereres i preview-modus og finjusteres når Xeneon Edge er fysisk tilgjengelig.