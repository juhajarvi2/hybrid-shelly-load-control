// ============================================================
// Shelly Pro 2 – Aurinko-ohjaus + turvalogiikka
// ============================================================
//
// Hallinnoi vesivaraajaa (output 0) ja lattialämmitystä (output 1):
//   - Aurinko-ohjaus klo 07:00–21:30 (aurinkoylijäämän hyödyntäminen)
//   - Iltanollaus klo 21:45 (kuormat pois ennen pörssäriaikaa)
//   - Turvalogiikka 24/7 (vaihekohtainen siirtoraja)
//
// Yöaikaan (22:00–07:00) skripti on passiivinen ja hoitaa vain
// turvavalvontaa – varsinainen pörssäriohjaus tulee Home Assistantilta.
//
// Mittaus: Shelly Pro 3 EM (HTTP-rajapinta EM.GetStatus)
// ============================================================

// --- ASETUKSET ---
var MITTARIN_IP   = "192.168.X.X";    // Shelly Pro 3 EM:n IP – muokkaa omaksesi
var VARAAJA       = 0;                 // Vesivaraajan output
var LATTIA        = 1;                 // Lattialämmityksen output

var VAIHE_TEHORAJA  = 5750;   // Absoluuttinen vaiheraja (W)
var YO_YLIKUORMA    = 5750;   // Ennakoiva yöraja (W)

var AURINKO_RAJA_V  = -3000;  // Varaajan käynnistys (W, neg. = verkkoon syöttö)
var AURINKO_RAJA_L  = -5000;  // Lattian käynnistys (W)
var AURINKO_MAXV    = 3000;   // Sallittu vaiheteho käynnistyshetkellä (W)
var SAMMUTUS_RAJA   = 3000;   // Sammutus kun aurinko loppuu (W)

// Aikarajat minuutteina keskiyöstä
var AURINKO_KAYNNISTYS_LOPPU_MIN = 21 * 60 + 30;  // 21:30
var ILTANOLLAUS_MIN              = 21 * 60 + 45;  // 21:45
var PORSSARI_ALKU_MIN            = 22 * 60;       // 22:00
var PORSSARI_LOPPU_MIN           = 7 * 60;        // 07:00
var AAMUNOLLAUS_MIN              = 7 * 60;        // 07:00

// --- TILAMUISTI ---
var edellinenTila    = { varaaja: null, lattia: null };
var mittariVirheet   = 0;
var MAX_VIRHEET      = 3;
var iltanollausTehty = false;
var aamunollausTehty = false;
var viimeinenPaiva   = -1;

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

function onPorssariAika() {
    var min = nytMinuutteina();
    return (min >= PORSSARI_ALKU_MIN || min < PORSSARI_LOPPU_MIN);
}

function voiKaynnistaaAuringolla() {
    var min = nytMinuutteina();
    return (min >= AAMUNOLLAUS_MIN && min < AURINKO_KAYNNISTYS_LOPPU_MIN);
}

function asetaKuorma(id, paalle, syy) {
    var nimi = (id === VARAAJA) ? "Varaaja" : "Lattia";
    Shelly.call("Switch.Set", { id: id, on: paalle });
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
        viimeinenPaiva = paiva;
    }
}

// ============================================================
// TURVAVALVONTA – 30 s välein, aina käynnissä
// ============================================================
function turvaValvonta() {
    var tilat = haeTilat();
    if (!tilat) return;

    Shelly.call("HTTP.GET", { url: "http://" + MITTARIN_IP + "/rpc/EM.GetStatus?id=0" },
    function(res, err) {
        if (err !== 0 || !res || res.code !== 200) {
            mittariVirheet++;
            print("Mittarivirhe " + mittariVirheet + "/" + MAX_VIRHEET);
            if (mittariVirheet >= MAX_VIRHEET) sammutaKaikki("Mittari ei vastaa");
            return;
        }
        mittariVirheet = 0;
        var data = JSON.parse(res.body);
        var maxV = Math.max(data.a_act_power, data.b_act_power, data.c_act_power);

        logitaMuutos(tilat);

        // Siirtoraja: lattia ensin pois (varaaja jää lämmittämään vettä)
        if (maxV > VAIHE_TEHORAJA) {
            if (tilat.lattia)        asetaKuorma(LATTIA,  false, "Siirtoraja " + Math.round(maxV) + "W");
            else if (tilat.varaaja)  asetaKuorma(VARAAJA, false, "Siirtoraja " + Math.round(maxV) + "W");
            return;
        }

        // Ennakoiva yöraja
        if (onPorssariAika() && maxV > YO_YLIKUORMA) {
            if (tilat.lattia)        asetaKuorma(LATTIA,  false, "Yö-ylikuorma " + Math.round(maxV) + "W");
            else if (tilat.varaaja)  asetaKuorma(VARAAJA, false, "Yö-ylikuorma " + Math.round(maxV) + "W");
        }
    });
}

// ============================================================
// AURINKO-OHJAUS + AIKASIIRTYMÄT – 30 s välein
// ============================================================
function aurinkoOhjaus() {
    tarkistaPaivanVaihto();

    var tilat = haeTilat();
    if (!tilat) return;

    var minNyt = nytMinuutteina();

    // Iltanollaus klo 21:45
    if (minNyt >= ILTANOLLAUS_MIN && minNyt < PORSSARI_ALKU_MIN && !iltanollausTehty) {
        if (tilat.varaaja || tilat.lattia) sammutaKaikki("Iltanollaus");
        else print("Iltanollaus: kuormat jo OFF");
        iltanollausTehty = true;
        return;
    }

    // Aamunollaus klo 07:00
    if (minNyt >= AAMUNOLLAUS_MIN && minNyt < AAMUNOLLAUS_MIN + 15 && !aamunollausTehty) {
        if (tilat.varaaja || tilat.lattia) sammutaKaikki("Aamunollaus");
        else print("Aamunollaus: kuormat jo OFF");
        aamunollausTehty = true;
        return;
    }

    // Pörssäri-aikana (21:45–07:00) ei muuta kuin turvavalvonta
    if (minNyt >= ILTANOLLAUS_MIN || minNyt < PORSSARI_LOPPU_MIN) return;

    // Aurinko-ohjaus klo 07:00–21:30
    Shelly.call("HTTP.GET", { url: "http://" + MITTARIN_IP + "/rpc/EM.GetStatus?id=0" },
    function(res, err) {
        if (err !== 0 || !res || res.code !== 200) return;

        var data         = JSON.parse(res.body);
        var maxV         = Math.max(data.a_act_power, data.b_act_power, data.c_act_power);
        var kokonaisteho = data.total_act_power;

        // Käynnistys vain klo 07:00–21:30, varaaja ensin
        if (voiKaynnistaaAuringolla()) {
            if (!tilat.varaaja && kokonaisteho < AURINKO_RAJA_V && maxV < AURINKO_MAXV)
                asetaKuorma(VARAAJA, true, "Aurinko");
            if (tilat.varaaja && !tilat.lattia && kokonaisteho < AURINKO_RAJA_L && maxV < AURINKO_MAXV)
                asetaKuorma(LATTIA, true, "Aurinko");
        }

        // Sammutus jos aurinko loppui (kokonaiskulutus nousi)
        if (kokonaisteho > SAMMUTUS_RAJA) {
            if (tilat.lattia)        asetaKuorma(LATTIA,  false, "Aurinko loppui");
            else if (tilat.varaaja)  asetaKuorma(VARAAJA, false, "Aurinko loppui");
        }
    });
}

// ============================================================
// KÄYNNISTYS
// ============================================================
print("Aurinko-ohjaus + turvalogiikka käynnistyy");
print("Aurinko: 07:00-21:30 | Iltanollaus: 21:45 | Aamunollaus: 07:00");
print("Pörssäri (HA) ohjaa: 22:00-07:00");
print("Vaiheraja: " + VAIHE_TEHORAJA + " W");

Timer.set(30000, true, turvaValvonta);
Timer.set(30000, true, aurinkoOhjaus);
