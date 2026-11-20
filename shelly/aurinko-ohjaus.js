// ============================================================
// Shelly Pro 2 – Aurinko-ohjaus + turvalogiikka (v6: mediaanisuodatus + HA-sykevalvonta)
// ============================================================
//
// Hallinnoi vesivaraajaa (output 0) ja lattialämmitystä (output 1):
//   - Aurinko-ohjaus klo 07:00–21:30 (aurinkoylijäämän hyödyntäminen)
//   - Iltanollaus klo 21:45 (kuormat pois ennen pörssäriaikaa)
//   - Turvalogiikka 24/7 (vaihekohtainen siirtoraja)
//
// Muutos v3 -> v4: päätökset tehdään mediaanisuodatetusta
// mittauksesta hetkellisarvon sijaan. Syy: pilvenraosta tuleva
// muutaman sekunnin tuotantopiikki (jopa >7 kW) ja vastaava
// hetkellinen notkahdus aiheuttivat turhia kytkentöjä.
//
//   - Mittausväli 30 s -> 10 s (suodatus vaatii näytteitä)
//   - KÄYNNISTYS: 5 näytteen mediaani (~50 s). Hidas tahallaan:
//     odottaminen maksaa vain menetettyä myyntiä, ei verkkosähköä.
//   - SAMMUTUS: 3 näytteen mediaani (~30 s). Riittävän nopea kun
//     aurinko oikeasti loppuu, mutta ohittaa 1 näytteen varjot.
//   - TURVALOGIIKKA: 3 näytteen mediaani (~30 s) TAI välitön katkaisu
//     jos vaihe ylittää PIKARAJA. 30 s lievää ylitystä on gG-sulakkeelle
//     merkityksetön (sulamiskäyrä on minuutteja/tunteja), mutta iso
//     ylitys katkaistaan heti ilman vahvistusta.
//   - Jokainen kytkentä tyhjentää suodattimen: seuraava käynnistys
//     odottaa aina tuoreen ikkunan (~50 s), eli sama pilvenrako ei
//     aja kuormia päälle-pois peräkkäin.
//   - MAX_VIRHEET 3 -> 9, jotta mittarin sietoaika pysyy ~90 s:ssa
//     mittausvälin tihennyttyä.
//   - Lattialle jäähtymisaika epäonnistuneen käynnistyksen jälkeen
//     (LATTIA_MIN_HYOTY_S / LATTIA_JAAHTY_S): jos aurinkokäynnistys
//     kaatuu alle 10 minuutissa, uutta ei yritetä 10 minuuttiin.
//     Syy: 18.8.2026 lattia kytkeytyi 10 kertaa kahdessa tunnissa,
//     koska auton laturi ramppaa samasta ylijäämästä ja molemmat
//     yhdessä ylittävät tuotannon. Päiväkohtainen katto (kuten
//     varaajan MAX_STARTTIA) olisi väärä lääke: sinä päivänä
//     10. käynnistys kesti 4 h 38 min ja oli päivän arvokkain,
//     eli kiintiö olisi palanut hukkakierroksiin. Onnistunut jakso
//     (yli 10 min) ei laukaise estoa lainkaan.
//     Jäähtymisaika ei menetä pitkää jaksoa vaan siirtää sen alkua:
//     18.8. datalla ajettuna 600 s siirsi sen 15:46 -> 15:55 ja
//     vähensi kytkentäparit kuudesta viiteen. Pidemmät ajat (1800 s)
//     maksoivat jo 0,7 h lämmitystä yhdestä säästetystä parista,
//     joten 300-600 s on paras vaihto.
//   - Varaajalle minimipäälläoloaika (MIN_ON_S, oletus 10 min):
//     todellinen 11.8. data osoitti, että kytkentäsarjat syntyvät
//     1-25 min aidoista tuotantonotkahduksista, joita suodatus ei
//     saa piilottaa. Minimiaika karsi ne (kytkennät -55 % simussa)
//     ja maksoi ~0,8 kWh/pv tuontia, joka päätyi tankkiin. Kun
//     termostaatti on kylläinen, pakotetut minuutit eivät vedä
//     juuri mitään. Ei koske turvalogiikkaa eikä lattiaa: siirto-
//     raja ohittaa minimiajan aina.
//
// Muutos v5 -> v6: HA-sykevalvonta ja autonominen yövara samassa skriptissä
//
//   Ongelma: yöllä kuormia ohjaa HA (Pörssäri). Kun HA ei pysty siihen
//   (Pörssärin välimuistiaikataulu vanhentui nettikatkon aikana, HA tai Pi
//   kaatui, LAN-vika), kukaan ei kytke kuormia eikä palauta turvapudotettua,
//   eikä skriptiä voi vaihtaa etänä. Ratkaisu on tämän skriptin sisällä:
//
//   - HA kutsuu osoitetta /script/<id>/syke minuutin välein, kun Pörssäri-
//     aikataulu on voimassa (ks. ha-shelly-syke.yaml). Pelkkä nettikatko ei
//     katkaise sykettä: Pörssäri-client ajaa välimuistissa olevaa aikataulua,
//     kunnes se vanhenee.
//   - Syke puuttuu SYKE_MAX_MIN (15) min -> AUTONOMINEN tila. Ajastus on
//     pääsilmukan kierroslaskuri, ei kello, joten NTP-viat eivät sekoita sitä.
//     Skriptin käynnistys antaa saman 15 min armonajan sykkeen odottamiselle.
//   - Autonominen tila + yöikkuna (22:00-07:00): varaaja ja lattia kytketään
//     itse, varaaja ensin, yksi kytkentä per suodatinikkuna (~50 s), vain jos
//     suodatettu vaihekuorma on alle YO_RAJA_V / YO_RAJA_L (samat rajat kuin
//     HA:n palautusautomaatioissa).
//   - Turvapudotuksen ja mittarikatkon (MAX_VIRHEET) sammuttamat kuormat
//     palautetaan 5 min viiveellä, kun suodatin on täynnä ja vaihekuorma
//     sallii. Jos kuorma pudotetaan uudelleen 15 min sisällä kytkennästä,
//     viive tuplaantuu (5, 10, 20, 40 min), jottei esim. auton lataus
//     aiheuta jatkuvaa kytkentäsahaa. Viiveen kerroin nollautuu uuden
//     yövara-jakson alussa ja mittarikatkon sammutuksen yhteydessä
//     (mittarikatko ei ole ylikuorma). Mittarikatkon 5 min viive lasketaan
//     oikeasta sammutuksesta myös silloin, kun syke katoaa vasta katkon aikana.
//   - Yövaran alkaessa molemmat kuormat jäävät odottamaan päällekytkentää
//     (myös aiemmin käsin sammutettu: HA ei ole ohjaamassa). Yövaran aikana
//     tehtyä käsin-OFF:ia ei kumota: lisäosa kytkee vain kuorman, jonka
//     aktivoituminen, turvapudotus tai mittarikatko on jättänyt odottamaan
//     päällekytkentää.
//   - Syke palaa -> HA/Pörssäri ohjaa, lisäosa ei koske releisiin: yövarana
//     päälle kytketyt kuormat jäävät päälle, kunnes HA muuttaa niiden tilaa
//     tai aamunollaus 07:00 sammuttaa ne. Päivällä lisäosa ei tee mitään
//     (aurinko-ohjaus on jo paikallinen).
//   - Kello: sys.unixtime on null, kunnes NTP on synkannut (esim. käynnistys
//     nettikatkon aikana), ja silloin new Date() oletettavasti laskee aikaa
//     käynnistyksestä. Ilman voimassa olevaa kelloa ilta-/aamunollaus ja
//     aurinko-ohjaus eivät toimi eikä yövara aktivoidu (muuten V5 sammuttaisi
//     kuormat väärään aikaan); turvalogiikka toimii aina.
//   - Diagnostiikka: GET /script/<id>/tila palauttaa JSON:n (autonominen,
//     yoAutoAktiivinen, sykeIkaS, sykeita, kelloOk, mittariVirheet, viimeMaxV,
//     odottaaPaalle, palautuskerroin) sekä jälkikäteen luettavat laskurit:
//     autoKertaa, autoAlkuMinSitten, autoKestoMin (autonomisen tilan alku ja
//     kesto; sykkeen puuttuminen alkoi SYKE_MAX_MIN min ennen alkua),
//     yoKertaa, yoKytkentoja (yövaran omat päällekytkennät), mittarikatkoja,
//     mittarikatkoMinSitten ja turvapudotuksia. Ajat ovat minuutteja
//     (-1 = ei koskaan) ja perustuvat kierroslaskuriin; laskurit nollautuvat
//     skriptin käynnistyessä.
//
//   Muutokset V5:een (H1-H7): lisäosa-lohko ennen pääsilmukkaa (H1);
//   sykeTikki() pääsilmukan alkuun (H2); kelloOk-ehto ilta-/aamunollaukseen
//   (H3); turvaPudota() siirtorajapudotuksiin (H4); yöhaara kutsuu
//   yoVaralogiikka() ja aurinko-ohjaus vaatii kellon (H5); sykeAlusta() ennen
//   Timer.set (H6); mittariKirjaa() mittarikatkon sammutuksen perään (H7).
//
//   Testaus: virtuaaliaikasimulaattori, 26 skenaariota (syke elossa/poissa,
//   käynnistys keskellä yötä, auton lataus 5/11/14 kW, käsin OFF, kello pois,
//   mittarikatkot, backoffin nollautuminen, sykkeen paluu kesken kierroksen)
//   sekä V5-vertailu: kuudella syötteellä V6 tekee V5:n kanssa täsmälleen samat
//   releohjaukset ja lokirivit, kun syke on elossa tai on päivä. Yhteensä 141
//   tarkistusta; lisäksi 30 tahallista rikkomista (mutanttia) huomattiin kaikki,
//   ja noin 2 000 satunnaista ajoa (sykkeen katoamiset, mittarikatkot, auton
//   lataukset, käsin kytkennät, kello pois) täyttivät oraakkelin ehdot.
//   Simulaatio ei korvaa kenttäkoetta: laitteella varmistetaan
//   HTTPServer.registerEndpoint ja syke HA:sta.
//
// Mittaus: Shelly Pro 3 EM (HTTP-rajapinta EM.GetStatus)
// ============================================================

// --- ASETUKSET ---
var MITTARIN_IP   = "192.168.X.X";    // Shelly Pro 3 EM:n IP – muokkaa omaksesi
var VARAAJA       = 0;                 // Vesivaraajan output
var LATTIA        = 1;                 // Lattialämmityksen output

var VAIHE_TEHORAJA  = 5750;   // Absoluuttinen vaiheraja (W), vahvistetaan 30 s
var PIKARAJA        = 6600;   // Välitön katkaisu ilman vahvistusta (W/vaihe)

var AURINKO_RAJA_V  = -4500;  // Varaajan käynnistys (W, neg. = verkkoon syöttö).
                              // -4500: varaaja käytännössä yösähkölle (Pörssäri) -
                              // 5-6 kW paneeleilla ja ~2 kW pohjalla ylijäämä ei
                              // juuri koskaan yllä tähän. Säästää termostaatti-
                              // ja relesyklit; paluu aurinkolämmitykseen: -3000.
var AURINKO_RAJA_L  = -5000;  // Lattian käynnistys (W)
var AURINKO_MAXV    = 3000;   // Sallittu vaiheteho käynnistyshetkellä (W)
var SAMMUTUS_RAJA   = 3000;   // Sammutus kun aurinko loppuu (W)

// --- SUODATUS ---
var POLL_MS      = 10000;  // Mittausväli (ms)
var MIN_ON_S     = 600;    // Varaajan minimipäälläoloaika (s), 0 = pois
var MAX_STARTTIA = 2;      // Varaajan aurinkokäynnistyksiä / pv (tankki täyttyy ~2 vedolla)
var LATTIA_MIN_HYOTY_S = 600;   // Lyhyempi lattiajakso = epäonnistunut käynnistys (s)
var LATTIA_JAAHTY_S    = 600;   // Esto epäonnistumisen jälkeen (s), 0 = pois
var IKKUNA       = 5;      // Käynnistyspäätöksen ikkuna (näytettä, ~50 s)
var IKKUNA_NOPEA = 3;      // Sammutus + turvalogiikka (näytettä, ~30 s)

// Aikarajat minuutteina keskiyöstä
var AURINKO_KAYNNISTYS_LOPPU_MIN = 21 * 60 + 30;  // 21:30
var ILTANOLLAUS_MIN              = 21 * 60 + 45;  // 21:45
var PORSSARI_ALKU_MIN            = 22 * 60;       // 22:00
var PORSSARI_LOPPU_MIN           = 7 * 60;        // 07:00
var AAMUNOLLAUS_MIN              = 7 * 60;        // 07:00

// --- TILAMUISTI ---
var edellinenTila    = { varaaja: null, lattia: null };
var mittariVirheet   = 0;
var MAX_VIRHEET      = 9;
var iltanollausTehty = false;
var aamunollausTehty = false;
var viimeinenPaiva   = -1;
var kyselyKesken     = false;
var varaajaOnS       = -1;    // sekunteja varaajan kytkennästä, -1 = ei päällä
var varaajaStartit   = 0;     // aurinkokäynnistykset tänään
var lattiaOnS        = -1;    // sekunteja lattian kytkennästä, -1 = ei päällä
var lattiaEstoS      = 0;     // jäljellä olevat estosekunnit

// --- RENGASPUSKURIT (kiinteä koko, ei push/slice/sort – mJS) ---
var bufMaxV = [0, 0, 0, 0, 0];
var bufKok  = [0, 0, 0, 0, 0];
var bufIdx  = 0;   // seuraava kirjoituskohta
var bufN    = 0;   // kelvollisten näytteiden määrä

// ============================================================
// APUFUNKTIOT
// ============================================================
function nytMinuutteina() {
    var nyt = new Date();
    return nyt.getHours() * 60 + nyt.getMinutes();
}

function nytPaiva() {
    return new Date().getDate();
}

function voiKaynnistaaAuringolla() {
    var min = nytMinuutteina();
    return (min >= AAMUNOLLAUS_MIN && min < AURINKO_KAYNNISTYS_LOPPU_MIN);
}

function tyhjennaSuodatin() {
    bufIdx = 0;
    bufN   = 0;
}

function lisaaNayte(maxV, kok) {
    bufMaxV[bufIdx] = maxV;
    bufKok[bufIdx]  = kok;
    bufIdx = (bufIdx + 1) % IKKUNA;
    if (bufN < IKKUNA) bufN++;
}

// n uusimman näytteen mediaani (n <= IKKUNA)
function mediaani(buf, n) {
    var tmp = [0, 0, 0, 0, 0];
    var i   = 0;
    var j   = 0;
    var idx = 0;
    var apu = 0;

    if (n > bufN) n = bufN;
    if (n < 1)    return 0;

    for (i = 0; i < n; i++) {
        idx = bufIdx - 1 - i;
        while (idx < 0) idx = idx + IKKUNA;
        tmp[i] = buf[idx];
    }
    for (i = 0; i < n - 1; i++) {
        for (j = i + 1; j < n; j++) {
            if (tmp[j] < tmp[i]) {
                apu = tmp[i];
                tmp[i] = tmp[j];
                tmp[j] = apu;
            }
        }
    }
    return tmp[Math.floor(n / 2)];
}

function asetaKuorma(id, paalle, syy) {
    var nimi = (id === VARAAJA) ? "Varaaja" : "Lattia";
    if (id === VARAAJA) varaajaOnS = paalle ? 0 : -1;
    if (id === LATTIA) {
        if (paalle) {
            lattiaOnS = 0;
        } else {
            // Vain aurinkokäynnistyksen kaatuminen laukaisee eston.
            // lattiaOnS < 0 = ei ollut skriptin päälle laittama (esim. nollaus).
            if (lattiaOnS >= 0 && lattiaOnS < LATTIA_MIN_HYOTY_S) {
                lattiaEstoS = LATTIA_JAAHTY_S;
                print("Lattia esto " + (LATTIA_JAAHTY_S / 60) + " min (jakso " + lattiaOnS + " s)");
            }
            lattiaOnS = -1;
        }
    }
    Shelly.call("Switch.Set", { id: id, on: paalle });
    tyhjennaSuodatin();   // kytkentä muuttaa mittausta -> vanhat näytteet roskaa
    print(nimi + (paalle ? " ON" : " OFF") + " <- " + syy);
}

function sammutaKaikki(syy) {
    asetaKuorma(LATTIA,  false, syy);
    asetaKuorma(VARAAJA, false, syy);
}

function haeTilat() {
    var v = Shelly.getComponentStatus("switch:" + JSON.stringify(VARAAJA));
    var l = Shelly.getComponentStatus("switch:" + JSON.stringify(LATTIA));
    if (!v || !l) return null;
    return { varaaja: v.output, lattia: l.output };
}

function logitaMuutos(tilat) {
    if (tilat.varaaja !== edellinenTila.varaaja ||
        tilat.lattia  !== edellinenTila.lattia) {
        print("TILA: Varaaja=" + tilat.varaaja + " Lattia=" + tilat.lattia);
        edellinenTila = { varaaja: tilat.varaaja, lattia: tilat.lattia };
    }
}

function tarkistaPaivanVaihto() {
    var paiva = nytPaiva();
    if (paiva !== viimeinenPaiva) {
        iltanollausTehty = false;
        aamunollausTehty = false;
        varaajaStartit = 0;
        lattiaEstoS = 0;
        viimeinenPaiva = paiva;
    }
}

// ============================================================
// V6-LISÄOSA – ks. "Muutos v5 -> v6" tiedoston alussa
// ============================================================

// ============================================================
// V6-LISÄOSA: HA-sykevalvonta + autonominen yövara
// ============================================================
// HA kutsuu osoitetta /script/<id>/syke minuutin välein, kun sillä on
// voimassa oleva Pörssäri-aikataulu. Jos syke puuttuu SYKE_MAX_MIN min,
// skripti siirtyy AUTONOMISEEN tilaan: yöikkunassa (22:00-07:00) varaaja ja
// lattia kytketään itse, varaaja ensin, vain jos suodatettu vaihekuorma
// sallii. Turvapudotuksen ja mittarikatkon sammuttamat kuormat palautetaan
// viiveellä (backoff 5 -> 40 min). Yövaran alkaessa molemmat kuormat jäävät
// odottamaan päällekytkentää (myös aiemmin käsin sammutettu); yövaran aikana
// tehtyä käsin-OFF:ia ei kumota. Päivällä lisäosa ei tee mitään.
// Kynnykset YO_RAJA_V/L ovat samat kuin HA:n palautusautomaatioissa
// (vaihekohtainen teho).

// --- ASETUKSET (lisäosa) ---
var SYKE_MAX_MIN     = 15;    // syke puuttuu näin kauan -> autonominen tila (min)
var YO_RAJA_V        = 4500;  // varaajan yökytkentä vain jos vaihekuorma < tämä (W)
var YO_RAJA_L        = 4000;  // lattian yökytkentä vain jos vaihekuorma < tämä (W)
var PALAUTUS_VIIVE_S = 300;   // pudotuksen jälkeen odotus ennen palautusta (s)
var BACKOFF_IKKUNA_S = 900;   // pudotus näin pian kytkennän jälkeen kasvattaa viivettä (s)
var BACKOFF_MAX      = 8;     // viiveen enimmäiskerroin (8 x 5 min = 40 min)

// Johdetut arvot. Tikki = yksi pääsilmukan kierros (POLL_MS).
// Ajastus perustuu kierroslaskuriin, ei kelloon, joten NTP-viat ja
// uptime-ympäripyörähdykset eivät vaikuta sykevalvontaan.
var TIKKI_S              = POLL_MS / 1000;
var SYKE_MAX_TIKIT       = Math.round(SYKE_MAX_MIN * 60 / TIKKI_S);
var PALAUTUS_VIIVE_TIKIT = Math.round(PALAUTUS_VIIVE_S / TIKKI_S);
var BACKOFF_TIKIT        = Math.round(BACKOFF_IKKUNA_S / TIKKI_S);

// --- TILAMUISTI (lisäosa) ---
var tikki            = 0;       // kierroslaskuri
var sykeIka          = 0;       // kierroksia viimeisestä sykkeestä (0 = armonaika alkaa)
var sykeLaskuri      = 0;       // saatuja sykkeitä (diagnostiikka)
var autonominen      = false;   // true = syke puuttuu
var yoAutoAktiivinen = false;   // autonominen JA yöikkuna
var kelloOk          = true;    // NTP-aika kunnossa
var viimeMaxV        = 0;       // viimeisin suodatettu suurin vaihekuorma (diagnostiikka)
var yoOn             = [false, false];              // odottaa päällekytkentää (indeksi = output-id)
var pudotusTikki     = [-1000000, -1000000];        // viimeisin pudotus
var palautusTikki    = [-1000000, -1000000];        // viimeisin yökytkentä
var palautusKerroin  = [1, 1];                      // viiveen kerroin (1, 2, 4, 8)

// Diagnostiikka (/tila): laskurit nollautuvat skriptin käynnistyessä. Ajat ovat
// kierroksia (-1 = ei koskaan), joten ne eivät riipu kellosta.
var autoKertaa       = 0;       // autonomisen tilan alkamiskerrat
var autoAlkuTikki    = -1;      // viimeisimmän autonomisen jakson alku
var autoKestoTikit   = 0;       // viimeksi päättyneen jakson kesto
var yoKertaa         = 0;       // yövara-jaksojen (autonominen + 22-07) alkamiskerrat
var yoKytkentoja     = 0;       // yövaran tekemät päällekytkennät
var mittarikatkoja   = 0;       // mittarikatkojaksot (sammutus tehty)
var katkoTikki       = -1;      // viimeisimmän mittarikatkon alku
var katkoAuki        = false;   // mittarikatko käynnissä
var turvapudotuksia  = 0;       // Siirtorajan pudotukset

// ============================================================
// APUFUNKTIOT (lisäosa)
// ============================================================

// sys.unixtime on null, kunnes NTP-synkronointi on onnistunut
function kelloValidi() {
    var s = Shelly.getComponentStatus("sys");
    if (s && s.unixtime) return true;
    return false;
}

function yoIkkunassa(minNyt) {
    return (minNyt >= PORSSARI_ALKU_MIN || minNyt < PORSSARI_LOPPU_MIN);
}

// GET /script/<id>/syke  (HA kutsuu minuutin välein)
function sykeKasittelija(pyynto, vastaus) {
    sykeIka = 0;
    sykeLaskuri++;
    vastaus.code = 200;
    vastaus.body = "ok";
    vastaus.send();
}

// Kierroksista minuutit (-1 = ei koskaan)
function ikaMin(t) {
    if (t < 0) return -1;
    return Math.round((tikki - t) * TIKKI_S / 60);
}

// GET /script/<id>/tila  (diagnostiikka: selaimella tai HA:n rest-sensorilla)
function tilaKasittelija(pyynto, vastaus) {
    vastaus.code = 200;
    vastaus.body = JSON.stringify({
        autonominen:      autonominen,
        yoAutoAktiivinen: yoAutoAktiivinen,
        sykeIkaS:         sykeIka * TIKKI_S,
        sykeita:          sykeLaskuri,
        kelloOk:          kelloOk,
        mittariVirheet:   mittariVirheet,
        viimeMaxV:        viimeMaxV,
        odottaaPaalle:    { varaaja: yoOn[VARAAJA], lattia: yoOn[LATTIA] },
        palautuskerroin:  { varaaja: palautusKerroin[VARAAJA], lattia: palautusKerroin[LATTIA] },
        autoKertaa:       autoKertaa,
        autoAlkuMinSitten: ikaMin(autoAlkuTikki),
        autoKestoMin:     autonominen ? ikaMin(autoAlkuTikki) : Math.round(autoKestoTikit * TIKKI_S / 60),
        yoKertaa:         yoKertaa,
        yoKytkentoja:     yoKytkentoja,
        mittarikatkoja:   mittarikatkoja,
        mittarikatkoMinSitten: ikaMin(katkoTikki),
        turvapudotuksia:  turvapudotuksia
    });
    vastaus.send();
}

// Kutsutaan pääsilmukan ALUSSA joka kierroksella (H2).
// Päivittää sykelaskurin, autonomisen tilan ja yövara-aktiivisuuden.
function sykeTikki() {
    var aktiivinen = false;
    var uusi       = false;

    tikki++;
    if (sykeIka < 1000000) sykeIka++;
    kelloOk = kelloValidi();

    uusi = (sykeIka >= SYKE_MAX_TIKIT);
    if (uusi !== autonominen) {
        autonominen = uusi;
        if (uusi) { autoKertaa++; autoAlkuTikki = tikki; }
        else      { autoKestoTikit = tikki - autoAlkuTikki; }
        if (uusi) print("Syke puuttuu " + SYKE_MAX_MIN + " min -> AUTONOMINEN tila");
        else      print("Syke palasi -> HA/Porssari ohjaa");
    }
    if (mittariVirheet === 0) katkoAuki = false;

    aktiivinen = (autonominen && kelloOk && yoIkkunassa(nytMinuutteina()));
    if (aktiivinen !== yoAutoAktiivinen) {
        yoAutoAktiivinen = aktiivinen;
        yoOn[VARAAJA] = aktiivinen;   // aktivoituessa molemmat odottavat päällekytkentää,
        yoOn[LATTIA]  = aktiivinen;   // poistuessa odotukset nollataan
        if (aktiivinen) {
            yoKertaa++;
            palautusKerroin[VARAAJA] = 1;   // uusi jakso: edellisen yön backoff unohtuu
            palautusKerroin[LATTIA]  = 1;
            print("Yovara alkaa: kuormat paalle, varaaja ensin");
        } else {
            print("Yovara paattyy");
        }
    }
}

// Ylikuormapudotus (H4): sammuttaa kuorman ja kirjaa pudotuksen palautusta varten.
// Pudotus pian edellisen kytkennän jälkeen = kuorma ei mahdu -> viive tuplaantuu.
function turvaPudota(id, syy) {
    asetaKuorma(id, false, syy);
    turvapudotuksia++;

    if (tikki - palautusTikki[id] < BACKOFF_TIKIT) {
        palautusKerroin[id] = palautusKerroin[id] * 2;
        if (palautusKerroin[id] > BACKOFF_MAX) palautusKerroin[id] = BACKOFF_MAX;
    } else {
        palautusKerroin[id] = 1;
    }
    pudotusTikki[id] = tikki;

    if (yoAutoAktiivinen) yoOn[id] = true;   // odottaa palautusta
}

// Mittarikatko (H7): V5 sammuttaa kuormat, kun mittari on ollut poissa
// MAX_VIRHEET kierrosta, ja toistaa sammutuksen joka kierroksella katkon ajan.
// Kutsutaan sammutuksen jälkeen; tilat on sammutusta edeltävä tila, joten vain
// oikeasti päällä olleet (= nyt sammutetut) kuormat kirjataan, käsin sammutettuja
// ei. Pudotushetki kirjataan aina, myös ennen yövaran alkua: jos syke katoaa
// vasta katkon aikana, 5 min viive lasketaan silti oikeasta pudotuksesta.
// Mittarikatko ei ole ylikuorma, joten kuorman backoff nollataan. Odottamaan
// palautusta (yoOn) jäävät kuormat vain autonomisessa yössä; palautus tapahtuu
// vasta, kun mittaus on taas kunnossa.
function mittariKirjaa(tilat) {
    if (!katkoAuki) { katkoAuki = true; mittarikatkoja++; katkoTikki = tikki; }
    if (tilat.varaaja) {
        pudotusTikki[VARAAJA]    = tikki;
        palautusKerroin[VARAAJA] = 1;
        if (yoAutoAktiivinen) yoOn[VARAAJA] = true;
    }
    if (tilat.lattia) {
        pudotusTikki[LATTIA]    = tikki;
        palautusKerroin[LATTIA] = 1;
        if (yoAutoAktiivinen) yoOn[LATTIA] = true;
    }
}

// Saako kuorman kytkeä: viive kulunut JA vaihekuorma alle rajan
function yoVapaa(id, raja, maxVHidas) {
    if (tikki - pudotusTikki[id] < PALAUTUS_VIIVE_TIKIT * palautusKerroin[id]) return false;
    return (maxVHidas < raja);
}

function yoKytke(id, maxVHidas) {
    asetaKuorma(id, true, "Yovara (med " + Math.round(maxVHidas) + "W)");
    yoOn[id] = false;
    yoKytkentoja++;
    palautusTikki[id] = tikki;
}

// Kutsutaan mittauskierroksella turvalogiikan JÄLKEEN yöikkunassa (H5).
// maxVHidas = suodatettu suurin vaihekuorma (W), suodatinValmis = suodatin täynnä
// (kytkentä tyhjentää suodattimen, joten kytkentöjä tulee enintään ~50 s välein).
function yoVaralogiikka(tilat, maxVHidas, suodatinValmis) {
    if (suodatinValmis) viimeMaxV = Math.round(maxVHidas);
    if (!yoAutoAktiivinen) return;
    if (!suodatinValmis) return;
    if (sykeIka < SYKE_MAX_TIKIT) return;   // syke ehti palata tämän kierroksen aikana

    // joku muu ehti jo kytkeä päälle -> ei odoteta enää
    if (yoOn[VARAAJA] && tilat.varaaja) yoOn[VARAAJA] = false;
    if (yoOn[LATTIA]  && tilat.lattia)  yoOn[LATTIA]  = false;

    // varaaja ensin (pieni kuorma, lämmin vesi), sitten lattia; yksi kytkentä per kierros
    if (yoOn[VARAAJA] && yoVapaa(VARAAJA, YO_RAJA_V, maxVHidas)) {
        yoKytke(VARAAJA, maxVHidas);
        return;
    }
    if (yoOn[LATTIA] && yoVapaa(LATTIA, YO_RAJA_L, maxVHidas)) {
        yoKytke(LATTIA, maxVHidas);
    }
}

// Rekisteröi HTTP-päätepisteet (H6). Tulostaa polut konsoliin.
function sykeAlusta() {
    var p1 = HTTPServer.registerEndpoint("syke", sykeKasittelija);
    var p2 = HTTPServer.registerEndpoint("tila", tilaKasittelija);
    print("Syke-osoite: " + p1 + "  Tila-osoite: " + p2);
    print("Autonominen yotila: syke puuttuu " + SYKE_MAX_MIN + " min = " + SYKE_MAX_TIKIT + " kierrosta");
}

// ============================================================
// PÄÄSILMUKKA – 10 s välein, yksi mittaus per kierros
// ============================================================
function paaSilmukka() {
    sykeTikki();
    tarkistaPaivanVaihto();

    var tilat = haeTilat();
    if (!tilat) return;

    var minNyt = nytMinuutteina();

    // --- 1) AIKASIIRTYMÄT (eivät tarvitse mittaria) ---

    // Iltanollaus klo 21:45
    if (kelloOk && minNyt >= ILTANOLLAUS_MIN && minNyt < PORSSARI_ALKU_MIN && !iltanollausTehty) {
        if (tilat.varaaja || tilat.lattia) sammutaKaikki("Iltanollaus");
        else print("Iltanollaus: kuormat jo OFF");
        iltanollausTehty = true;
        return;
    }

    // Aamunollaus klo 07:00
    if (kelloOk && minNyt >= AAMUNOLLAUS_MIN && minNyt < AAMUNOLLAUS_MIN + 15 && !aamunollausTehty) {
        if (tilat.varaaja || tilat.lattia) sammutaKaikki("Aamunollaus");
        else print("Aamunollaus: kuormat jo OFF");
        aamunollausTehty = true;
        return;
    }

    // --- 2) YKSI MITTAUS: turva + aurinko samasta datasta ---
    if (kyselyKesken) return;   // ei päällekkäisiä kyselyitä 10 s välillä
    kyselyKesken = true;

    if (varaajaOnS >= 0) varaajaOnS += POLL_MS / 1000;
    if (lattiaOnS  >= 0) lattiaOnS  += POLL_MS / 1000;
    if (lattiaEstoS > 0) lattiaEstoS -= POLL_MS / 1000;

    Shelly.call("HTTP.GET", { url: "http://" + MITTARIN_IP + "/rpc/EM.GetStatus?id=0" },
    function(res, err) {
        kyselyKesken = false;

        if (err !== 0 || !res || res.code !== 200) {
            mittariVirheet++;
            tyhjennaSuodatin();
            print("Mittarivirhe " + mittariVirheet + "/" + MAX_VIRHEET);
            if (mittariVirheet >= MAX_VIRHEET) {
                sammutaKaikki("Mittari ei vastaa");
                mittariKirjaa(tilat);
            }
            return;
        }
        mittariVirheet = 0;

        var data = JSON.parse(res.body);
        var maxV = Math.max(data.a_act_power, data.b_act_power, data.c_act_power);
        var kok  = data.total_act_power;

        lisaaNayte(maxV, kok);

        var maxVNopea = mediaani(bufMaxV, IKKUNA_NOPEA);  // ~30 s
        var kokNopea  = mediaani(bufKok,  IKKUNA_NOPEA);  // ~30 s
        var maxVHidas = mediaani(bufMaxV, IKKUNA);        // ~50 s
        var kokHidas  = mediaani(bufKok,  IKKUNA);        // ~50 s

        logitaMuutos(tilat);

        // --- 3) TURVALOGIIKKA ENSIN ---
        // Iso ylitys heti, lievä ylitys vasta 30 s vahvistuksella.
        // Lattia ensin pois (varaaja jää lämmittämään vettä).
        if (maxV > PIKARAJA || maxVNopea > VAIHE_TEHORAJA) {
            if (tilat.lattia)       turvaPudota(LATTIA, "Siirtoraja " + Math.round(maxV) + "W");
            else if (tilat.varaaja) turvaPudota(VARAAJA, "Siirtoraja " + Math.round(maxV) + "W");
            return;
        }

        // --- 4) AURINKO-OHJAUS ---

        // Pörssäri-aikana (21:45–07:00) ei muuta kuin turvavalvonta
        if (!kelloOk) return;   // ei kelloa -> vain turvalogiikka
        if (minNyt >= ILTANOLLAUS_MIN || minNyt < PORSSARI_LOPPU_MIN) {
            yoVaralogiikka(tilat, maxVHidas, bufN >= IKKUNA);
            return;
        }

        // Käynnistys vain klo 07:00–21:30, varaaja ensin.
        // Vaatii täyden ikkunan: yksittäinen pilvenrako ei riitä.
        if (voiKaynnistaaAuringolla() && bufN >= IKKUNA) {
            if (!tilat.varaaja && varaajaStartit < MAX_STARTTIA &&
                kokHidas < AURINKO_RAJA_V && maxVHidas < AURINKO_MAXV) {
                varaajaStartit++;
                asetaKuorma(VARAAJA, true, "Aurinko " + varaajaStartit + "/" + MAX_STARTTIA + " (med " + Math.round(kokHidas) + "W)");
                return;   // suodatin tyhjennetty – lattia harkitaan seuraavassa ikkunassa
            }
            if (tilat.varaaja && !tilat.lattia && lattiaEstoS <= 0 &&
                kokHidas < AURINKO_RAJA_L && maxVHidas < AURINKO_MAXV) {
                asetaKuorma(LATTIA, true, "Aurinko (med " + Math.round(kokHidas) + "W)");
                return;
            }
        }

        // Sammutus jos aurinko loppui (kokonaiskulutus nousi).
        // Varaaja kunnioittaa minimipäälläoloaikaa - turvalogiikka
        // (kohta 3 ylempänä) EI kunnioita, se katkaisee aina.
        if (bufN >= IKKUNA_NOPEA && kokNopea > SAMMUTUS_RAJA) {
            if (tilat.lattia)
                asetaKuorma(LATTIA, false, "Aurinko loppui (med " + Math.round(kokNopea) + "W)");
            else if (tilat.varaaja && (varaajaOnS < 0 || varaajaOnS >= MIN_ON_S))
                asetaKuorma(VARAAJA, false, "Aurinko loppui (med " + Math.round(kokNopea) + "W)");
        }
    });
}

// ============================================================
// KÄYNNISTYS
// ============================================================
print("Aurinko-ohjaus + turvalogiikka v6 (mediaanisuodatus + HA-syke)");
print("Mittausvali: " + (POLL_MS / 1000) + " s | ikkuna ON: " + IKKUNA + " | OFF/turva: " + IKKUNA_NOPEA);
print("Aurinko: 07:00-21:30 | Iltanollaus: 21:45 | Aamunollaus: 07:00");
print("Porssari (HA) ohjaa: 22:00-07:00");
print("Vaiheraja: " + VAIHE_TEHORAJA + " W (pikaraja " + PIKARAJA + " W)");
print("Varaajan min-on: " + MIN_ON_S + " s | lattian jaahty: " + LATTIA_JAAHTY_S + " s");

sykeAlusta();
Timer.set(POLL_MS, true, paaSilmukka);
