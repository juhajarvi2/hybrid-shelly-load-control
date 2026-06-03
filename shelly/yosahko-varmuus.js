// ============================================================
// Shelly Pro 2 – Yösähkö varmuus (manuaalinen varaskripti)
// ============================================================
//
// Yksinkertainen varaskripti tilanteisiin, joissa Home Assistant
// tai Pörssäri.fi ei toimi. Pidetään normaalisti STOPPED-tilassa
// ja käynnistetään käsin tarvittaessa.
//
//   - Klo 22: kytkee molemmat kuormat ON
//   - Klo 7:  kytkee molemmat kuormat OFF
//
// HUOM: Run on startup = OFF. Skripti ei käynnisty automaattisesti.
//       Aurinko-ohjaus (toinen skripti) hoitaa turvalogiikan myös
//       tämän rinnalla, joten siirtoraja on suojattu.
// ============================================================

function tarkista() {
    var tunti = new Date().getHours();

    if (tunti === 22) {
        Shelly.call("Switch.Set", { id: 0, on: true });
        Shelly.call("Switch.Set", { id: 1, on: true });
        print("Klo 22 - kuormat ON");
    }

    if (tunti === 7) {
        Shelly.call("Switch.Set", { id: 0, on: false });
        Shelly.call("Switch.Set", { id: 1, on: false });
        print("Klo 7 - kuormat OFF");
    }
}

print("Yösähkö varmuus käynnistetty");
print("Klo 22 -> kuormat ON, Klo 7 -> kuormat OFF");

Timer.set(300000, true, tarkista);   // tarkistus 5 min välein
