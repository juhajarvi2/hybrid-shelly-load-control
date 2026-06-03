# Home Energy Management – Shelly + Home Assistant

Load control for a domestic hot water tank and underfloor heating, based on
solar surplus, Nord Pool spot price (via Pörssäri.fi) and per-phase main-fuse
limit. Built on a Shelly Pro 2, a Shelly Pro 3 EM energy meter and Home
Assistant.

*[Suomeksi alempana ↓](#suomeksi)*

## Architecture

Three complementary layers:

| Layer | Implementation | Hours |
|---|---|---|
| Daytime solar control | Shelly script | 07:00–21:30 |
| Night-time spot-price control | Home Assistant + Pörssäri.fi | 22:00–07:00 |
| Safety logic (phase limit) | Shelly script | 24/7 |

```
07:00 ─────────── 21:30 ──── 21:45 ──── 22:00 ─────────── 07:00
  │                 │          │          │                  │
  │  SOLAR CONTROL   │ off only │  EVENING │  SPOT (HA)       │
  │  (on + off)      │          │  RESET   │  takes over       │
  ▼                 ▼          ▼          ▼                  ▼
       ◄──────────── SAFETY LOGIC 24/7 ────────────►
```

## Hardware

- **Shelly Pro 2** – water heater (output 0), underfloor heating (output 1)
- **Shelly Pro 3 EM** – per-phase metering at the main fuses
- **Home Assistant** (Raspberry Pi 5) – spot-price control and load recovery
- **Solar PV** – up to ~5–6 kW

## Repository layout

```
.
├── README.md
├── LICENSE
├── shelly/
│   ├── aurinko-ohjaus.js      Daytime control + safety logic
│   └── yosahko-varmuus.js     Manual fallback script
└── home-assistant/
    └── automations.yaml       Control + recovery automations
```

## Components

**shelly/aurinko-ohjaus.js** – Reads the Pro 3 EM every 30 s. Solar control
(07:00–21:30) starts the heater first, then floor heating, on solar surplus.
Evening reset (21:45) clears loads before the spot-price control window. Safety logic
(24/7) sheds the floor heating first if any phase exceeds the ~5750 W limit.
At night the script is passive – control comes from Home Assistant.

**shelly/yosahko-varmuus.js** – Minimal fallback kept in `Stopped` state.
Started manually if HA or the spot-price control is down. Loads on at 22:00,
off at 07:00.

**home-assistant/automations.yaml** – Switches the Shelly outputs per the
spot-price control's channel sensors, plus a recovery automation: if the
safety logic switched the floor heating off but the schedule still wants it
on, it is restored once phase load drops below 4000 W (checked every 15 min).

The night-time schedule comes from a spot-price control service. This setup
uses [Pörssäri.fi](https://www.porssari.fi/), whose Home Assistant client
exposes channel sensors (`sensor.porssari_channel_N_state`, value 0/1). Any
equivalent spot-price source can be adapted in its place by adjusting the
entity IDs in `automations.yaml`.

## Setup

**Shelly:** Scripts → *+ Create Script* → paste `aurinko-ohjaus.js`, set
`MITTARIN_IP`, *Save & Run*, *Run on startup: ON*. Repeat for
`yosahko-varmuus.js` but leave it **Stopped** with autostart **OFF**.

**Home Assistant:**
1. Set up your spot-price control source so that its channel sensors are
   available in Home Assistant
2. Add the automations to `automations.yaml` and restart HA
3. Adjust the entity IDs in `automations.yaml` to match your own devices and
   sensors

> The spot-price integration itself is not included in this repository –
> install it from its own source. For Pörssäri.fi, see the
> [official client](https://github.com/Porssari/HomeAssistant-client).

## Settings (aurinko-ohjaus.js)

| Parameter | Default | Description |
|---|---|---|
| `MITTARIN_IP` | – | Shelly Pro 3 EM IP |
| `VAIHE_TEHORAJA` | 5750 | Absolute per-phase limit (W) |
| `YO_YLIKUORMA` | 5750 | Night pre-emptive limit (W) |
| `AURINKO_RAJA_V` | -3000 | Heater start (W, neg. = export) |
| `AURINKO_RAJA_L` | -5000 | Floor heating start (W) |
| `SAMMUTUS_RAJA` | 3000 | Shut-off when solar ends (W) |

A 3 × 25 A connection ≈ 5750 W/phase (479 Wh / 5 min). Adjust to your fuse
rating.

## Notes

- The Shelly and the spot-price control are unaware of each other's loads. A
  3-phase EV charging session overlapping the heating loads can push a phase
  high – the safety logic sheds load as needed.
- Load recovery lives in HA because the spot-price control only sends commands
  on state change and won't restore a load the safety logic has shed.

## Disclaimer

Controls electrical loads; use at your own risk. Verify limits against your
own fuse rating. Electrical work must be done by a qualified electrician.

---

## Suomeksi

Vesivaraajan ja lattialämmityksen kuormanohjaus aurinkosähkön, pörssisähkön
spot-hinnan (Pörssäri.fi) ja vaihekohtaisen pääsulakerajan mukaan. Toteutus:
Shelly Pro 2, Shelly Pro 3 EM ja Home Assistant.

### Arkkitehtuuri

Kolme toisiaan täydentävää osaa:

| Osa | Toteutus | Aikaväli |
|---|---|---|
| Päiväajan aurinko-ohjaus | Shelly-skripti | 07:00–21:30 |
| Yöajan spot-hintaohjaus | Home Assistant + Pörssäri.fi | 22:00–07:00 |
| Turvalogiikka (vaiheraja) | Shelly-skripti | 24/7 |

### Komponentit

**shelly/aurinko-ohjaus.js** – Lukee Pro 3 EM:n 30 s välein. Aurinko-ohjaus
(07:00–21:30) käynnistää varaajan ensin, sitten lattian, aurinkoylijäämällä.
Iltanollaus (21:45) tyhjentää kuormat ennen spot-ohjauksen aikaikkunaa. Turvalogiikka (24/7)
sammuttaa lattian ensin, jos vaihe ylittää ~5750 W. Yöllä skripti on
passiivinen – ohjaus tulee Home Assistantilta.

**shelly/yosahko-varmuus.js** – Manuaalinen varaskripti, pidetään
`Stopped`-tilassa. Käynnistetään käsin, jos HA tai spot-ohjaus ei toimi.
Kuormat päälle klo 22, pois klo 7.

**home-assistant/automations.yaml** – Kytkee Shellyn outputit spot-ohjauksen
kanavasensorien mukaan. Lisäksi palautusautomaatio: jos turvalogiikka on
sammuttanut lattian mutta aikataulu haluaa sen päälle, lattia palautetaan kun
vaihekuorma on alle 4000 W (tarkistus 15 min välein).

Yöajan aikataulu tulee spot-ohjauspalvelusta. Tässä toteutuksessa käytetään
[Pörssäri.fi](https://www.porssari.fi/)-palvelua, jonka Home Assistant -client
tarjoaa kanavasensorit (`sensor.porssari_channel_N_state`, arvo 0/1). Tilalle
voi sovittaa minkä tahansa vastaavan spot-ohjauslähteen muokkaamalla
`automations.yaml`:n entity-ID:t.

### Asennus

**Shelly:** Scripts → *+ Create Script* → liitä `aurinko-ohjaus.js`, säädä
`MITTARIN_IP`, *Save & Run*, *Run on startup: ON*. Toista
`yosahko-varmuus.js`:lle, mutta jätä **Stopped** ja autostart **OFF**.

**Home Assistant:**
1. Ota spot-ohjauslähteesi käyttöön niin, että sen kanavasensorit ovat
   saatavilla Home Assistantissa
2. Lisää automaatiot `automations.yaml`:hin ja käynnistä HA uudelleen
3. Säädä `automations.yaml`:n entity-ID:t omia laitteitasi ja sensoreitasi
   vastaaviksi

> Itse spot-ohjausintegraatio ei sisälly tähän repoon – asenna se omasta
> lähteestään. Pörssäri.fi:n osalta katso
> [virallinen client](https://github.com/Porssari/HomeAssistant-client).

### Huomioita

- Shelly ja spot-ohjaus eivät tunne toistensa kuormia. 3-vaiheinen sähköauton
  lataus samaan aikaan lämmityskuormien kanssa voi nostaa vaihetehon korkeaksi
  – turvalogiikka katkaisee tarvittaessa.
- Lattian palautus on HA:ssa, koska spot-ohjaus lähettää komennot vain
  tilamuutoksilla eikä palauta turvalogiikan katkaisemaa kuormaa.

### Vastuuvapauslauseke

Ohjaa sähkökuormia, käyttö omalla vastuulla. Varmista rajat oman sulakekokosi
mukaan. Sähkötyöt vain pätevä asentaja.
