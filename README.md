# Home Energy Management – Shelly + Home Assistant

Load control for a domestic hot water tank and underfloor heating, based on
solar surplus, Nord Pool spot price (via Pörssäri.fi) and per-phase main-fuse
limit. Built on a Shelly Pro 2, a Shelly Pro 3 EM energy meter and Home
Assistant.

*[Suomeksi alempana ↓](#suomeksi)*

## Architecture

Four complementary layers:

| Layer | Implementation | Hours |
|---|---|---|
| Daytime solar control | Shelly script | 07:00–21:30 |
| Night-time spot-price control | Home Assistant + Pörssäri.fi | 22:00–07:00 |
| Autonomous night fallback (HA heartbeat lost) | Shelly script | 22:00–07:00 |
| Safety logic (phase limit) | Shelly script | 24/7 |

```
07:00 ─────────── 21:30 ──── 21:45 ──── 22:00 ─────────── 07:00
  │                 │          │          │                  │
  │  SOLAR CONTROL   │ off only │  EVENING │  SPOT (HA)       │
  │  (on + off)      │          │  RESET   │  or fallback     │
  ▼                 ▼          ▼          ▼                  ▼
       ◄──────────── SAFETY LOGIC 24/7 ────────────►
```

## Hardware

- **Shelly Pro 2** – water heater (output 0), underfloor heating (output 1)
- **Shelly Pro 3 EM** – per-phase metering at the main fuses
- **Home Assistant** (Raspberry Pi 5) – spot-price control, load recovery,
  heartbeat
- **Solar PV** – up to ~5–6 kW

## Repository layout

```
.
├── README.md
├── LICENSE
├── shelly/
│   └── aurinko-ohjaus.js      Solar control + safety logic + night fallback (v6)
└── home-assistant/
    ├── automations.yaml       Control, recovery and heartbeat automations
    └── rest.yaml              Heartbeat command + diagnostic sensors
```

## Components

**shelly/aurinko-ohjaus.js (v6)** – Reads the Pro 3 EM every 10 s and makes
decisions from median-filtered values: 5 samples (~50 s) to switch on,
3 samples (~30 s) to switch off or shed. Solar control (07:00–21:30) starts
the heater first, then floor heating. Evening reset (21:45) and morning reset
(07:00) clear loads. Safety logic (24/7) sheds floor heating first, then the
heater, if any phase exceeds 5750 W (30 s median) or 6600 W (instantly).

Home Assistant calls the script's `/script/<id>/syke` endpoint every minute
while the spot-price schedule is valid. If the heartbeat is missing for
15 min, the script enters **autonomous mode**: during 22:00–07:00 it switches
the loads on itself (heater first, only while the filtered phase load allows)
and restores loads shed by the safety logic, with a back-off delay
(5 → 40 min). Timing uses a loop counter, not the clock, and clock-dependent
logic is disabled until NTP time is valid. `GET /script/<id>/tila` returns a
JSON with the current state and diagnostic counters.

**home-assistant/automations.yaml** – Switches the Shelly outputs per the
spot-price control's channel sensors; restores a load shed by the safety
logic when the schedule still wants it on and the phase load is low enough
(floor < 4000 W, heater < 4500 W, checked every 15 min); sends the heartbeat;
Telegram notifications and air-conditioning interlocks.

**home-assistant/rest.yaml** – `rest_command.shelly_syke` (the heartbeat) and
REST sensors for the `/tila` counters. Uses digest authentication.

The night-time schedule comes from a spot-price control service. This setup
uses [Pörssäri.fi](https://www.porssari.fi/), whose Home Assistant client
exposes channel sensors (`sensor.porssari_channel_N_state`, value 0/1). Any
equivalent spot-price source can be adapted in its place by adjusting the
entity IDs in `automations.yaml`.

## Setup

**Shelly:** Scripts → *+ Create Script* → paste `aurinko-ohjaus.js`, set
`MITTARIN_IP`, *Save & Run*, *Run on startup: ON*. The console prints the
heartbeat and status paths (`Syke-osoite`, `Tila-osoite`); note the script
id in them.

**Home Assistant:**
1. Set up your spot-price control source so that its channel sensors are
   available in Home Assistant
2. Add the automations to `automations.yaml` and the contents of `rest.yaml`
   to `configuration.yaml`; set the Pro 2 IP and script id, and the Shelly
   password in `secrets.yaml` (`shelly_pro2_pw`)
3. Adjust the entity IDs in `automations.yaml` to match your own devices and
   sensors, restart HA
4. Check that `/tila` shows `sykeita` increasing and `autonominen: false`

> If the Shelly has a password, every HTTP call to it must use digest
> authentication. Repeated failed authentications make the Shelly throttle
> requests (HTTP 429), which also blocks the heartbeat.

> The spot-price integration itself is not included in this repository –
> install it from its own source. For Pörssäri.fi, see the
> [official client](https://github.com/Porssari/HomeAssistant-client).

## Settings (aurinko-ohjaus.js)

| Parameter | Default | Description |
|---|---|---|
| `MITTARIN_IP` | – | Shelly Pro 3 EM IP |
| `VAIHE_TEHORAJA` | 5750 | Per-phase limit, 30 s median (W) |
| `PIKARAJA` | 6600 | Per-phase limit, instant shed (W) |
| `AURINKO_RAJA_V` | -4500 | Heater start (W, neg. = export) |
| `AURINKO_RAJA_L` | -5000 | Floor heating start (W) |
| `AURINKO_MAXV` | 3000 | Max phase load allowed at start (W) |
| `SAMMUTUS_RAJA` | 3000 | Shut-off when solar ends (W) |
| `MIN_ON_S` | 600 | Heater minimum on-time (s) |
| `MAX_STARTTIA` | 2 | Heater solar starts per day |
| `LATTIA_JAAHTY_S` | 600 | Floor cooldown after a failed start (s) |
| `SYKE_MAX_MIN` | 15 | Heartbeat timeout → autonomous mode (min) |
| `YO_RAJA_V` / `YO_RAJA_L` | 4500 / 4000 | Autonomous switch-on limits (W/phase) |

A 3 × 25 A connection ≈ 5750 W/phase. Adjust to your fuse rating.

## Notes

- The Shelly and the spot-price control are unaware of other loads. A 3-phase
  EV charging session overlapping the heating loads can push a phase high –
  the safety logic sheds load as needed.
- Load recovery lives in HA because the spot-price control only sends commands
  on state change and won't restore a load the safety logic has shed. In
  autonomous mode the script does the recovery itself.

## Version history

| Version | Change |
|---|---|
| v2 | Single polling loop, one meter read per round |
| v3 | Removed the dead night pre-emptive limit branch |
| v4 | Median filtering, 10 s polling, instant limit, heater min on-time and daily start cap |
| v5 | Floor heating cooldown after a failed solar start |
| v6 | HA heartbeat, autonomous night fallback, NTP check, `/tila` diagnostics |

## Disclaimer

Controls electrical loads; use at your own risk. Verify limits against your
own fuse rating. Electrical work must be done by a qualified electrician.

---

## Suomeksi

Vesivaraajan ja lattialämmityksen kuormanohjaus aurinkosähkön, pörssisähkön
spot-hinnan (Pörssäri.fi) ja vaihekohtaisen pääsulakerajan mukaan. Toteutus:
Shelly Pro 2, Shelly Pro 3 EM ja Home Assistant.

### Arkkitehtuuri

Neljä toisiaan täydentävää osaa:

| Osa | Toteutus | Aikaväli |
|---|---|---|
| Päiväajan aurinko-ohjaus | Shelly-skripti | 07:00–21:30 |
| Yöajan spot-hintaohjaus | Home Assistant + Pörssäri.fi | 22:00–07:00 |
| Autonominen yövara (HA:n syke puuttuu) | Shelly-skripti | 22:00–07:00 |
| Turvalogiikka (vaiheraja) | Shelly-skripti | 24/7 |

### Komponentit

**shelly/aurinko-ohjaus.js (v6)** – Lukee Pro 3 EM:n 10 s välein ja tekee
päätökset mediaanisuodatetuista arvoista: 5 näytettä (~50 s) päällekytkentään,
3 näytettä (~30 s) sammutukseen ja turvapudotukseen. Aurinko-ohjaus
(07:00–21:30) käynnistää varaajan ensin, sitten lattian. Ilta- (21:45) ja
aamunollaus (07:00) tyhjentävät kuormat. Turvalogiikka (24/7) sammuttaa ensin
lattian, sitten varaajan, jos vaihe ylittää 5750 W (30 s mediaani) tai 6600 W
(heti).

Home Assistant kutsuu skriptin osoitetta `/script/<id>/syke` minuutin välein,
kun spot-aikataulu on voimassa. Jos syke puuttuu 15 min, skripti siirtyy
**autonomiseen tilaan**: klo 22–07 se kytkee kuormat itse (varaaja ensin,
vain kun suodatettu vaihekuorma sallii) ja palauttaa turvalogiikan pudottamat
kuormat kasvavalla viiveellä (5 → 40 min). Ajastus perustuu
kierroslaskuriin, ei kelloon, ja kellosta riippuva logiikka on pois päältä,
kunnes NTP-aika on voimassa. `GET /script/<id>/tila` palauttaa JSONin
tilasta ja diagnostiikkalaskureista.

**home-assistant/automations.yaml** – Kytkee Shellyn outputit spot-ohjauksen
kanavasensorien mukaan; palauttaa turvalogiikan pudottaman kuorman, kun
aikataulu haluaa sen yhä päälle ja vaihekuorma on riittävän pieni (lattia
< 4000 W, varaaja < 4500 W, tarkistus 15 min välein); lähettää sykkeen;
Telegram-ilmoitukset ja ilmalämpöpumpun lukitukset.

**home-assistant/rest.yaml** – `rest_command.shelly_syke` (syke) ja
REST-sensorit `/tila`-laskureille. Digest-tunnistus.

Yöajan aikataulu tulee spot-ohjauspalvelusta. Tässä toteutuksessa käytetään
[Pörssäri.fi](https://www.porssari.fi/)-palvelua, jonka Home Assistant -client
tarjoaa kanavasensorit (`sensor.porssari_channel_N_state`, arvo 0/1). Tilalle
voi sovittaa minkä tahansa vastaavan spot-ohjauslähteen muokkaamalla
`automations.yaml`:n entity-ID:t.

### Asennus

**Shelly:** Scripts → *+ Create Script* → liitä `aurinko-ohjaus.js`, säädä
`MITTARIN_IP`, *Save & Run*, *Run on startup: ON*. Konsoli tulostaa syke- ja
tilaosoitteet (`Syke-osoite`, `Tila-osoite`); niistä näkee skriptin id:n.

**Home Assistant:**
1. Ota spot-ohjauslähteesi käyttöön niin, että sen kanavasensorit ovat
   saatavilla Home Assistantissa
2. Lisää automaatiot `automations.yaml`:hin ja `rest.yaml`:n sisältö
   `configuration.yaml`:iin; säädä Pro 2:n IP ja skriptin id sekä Shellyn
   salasana `secrets.yaml`:iin (`shelly_pro2_pw`)
3. Säädä `automations.yaml`:n entity-ID:t omia laitteitasi vastaaviksi ja
   käynnistä HA uudelleen
4. Tarkista, että `/tila` näyttää `sykeita` kasvavan ja `autonominen: false`

> Jos Shellyllä on salasana, jokaisen HTTP-kutsun sille on käytettävä
> digest-tunnistusta. Toistuvat epäonnistuneet tunnistukset saavat Shellyn
> kuristamaan pyyntöjä (HTTP 429), mikä katkaisee myös sykkeen.

> Itse spot-ohjausintegraatio ei sisälly tähän repoon – asenna se omasta
> lähteestään. Pörssäri.fi:n osalta katso
> [virallinen client](https://github.com/Porssari/HomeAssistant-client).

### Huomioita

- Shelly ja spot-ohjaus eivät tunne muita kuormia. 3-vaiheinen sähköauton
  lataus samaan aikaan lämmityskuormien kanssa voi nostaa vaihetehon korkeaksi
  – turvalogiikka katkaisee tarvittaessa.
- Kuormien palautus on HA:ssa, koska spot-ohjaus lähettää komennot vain
  tilamuutoksilla eikä palauta turvalogiikan katkaisemaa kuormaa.
  Autonomisessa tilassa skripti palauttaa kuormat itse.

Asetukset ja versiohistoria: ks. englanninkieliset taulukot yllä.

### Vastuuvapauslauseke

Ohjaa sähkökuormia, käyttö omalla vastuulla. Varmista rajat oman sulakekokosi
mukaan. Sähkötyöt vain pätevä asentaja.
