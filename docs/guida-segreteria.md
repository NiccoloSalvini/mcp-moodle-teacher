# Moodle con Claude — guida per la segreteria

Una pagina, niente di tecnico. Serve l'app **Claude Desktop** con l'estensione
*Moodle (staff)* installata e il proprio token Moodle inserito.

## Installazione (una volta sola)

1. Scaricare `mcp-moodle-staff.mcpb` dall'[ultima versione](https://github.com/NiccoloSalvini/mcp-moodle-staff/releases/latest).
2. Aprire Claude Desktop ▸ **Impostazioni ▸ Estensioni ▸ Installa estensione…** e scegliere il file.
3. Compilare le due caselle:
   - **indirizzo**: `https://esestudents.com/webservice/rest/server.php`
   - **token**: quello ricevuto dall'amministratore di Moodle (non va mai scritto in chat né mandato per mail).

## Le tre richieste pronte

Nella chat, dal pulsante **+** (o dal menu dei comandi), scegliere:

| Richiesta | Cosa fa |
|---|---|
| **Orario della settimana** | tutte le lezioni della sede con aula, docente e numero di studenti; segnala sovrapposizioni e lezioni senza aula; prepara il messaggio WhatsApp e salva la pagina dell'orario sulla Scrivania |
| **Carica i voti dei professori** | controlla la cartella con gli Excel dei professori, dice cosa non torna, prepara i file da importare su Moodle e le mail ai professori per le righe da chiarire |
| **Controllo presenze del venerdì** | assenze della settimana corso per corso, registri non compilati, studenti che hanno raggiunto la soglia, bozze delle mail di avviso (mai inviate da sole) |
| **Registri presenze in ritardo** | docenti che non hanno fatto l'appello su Moodle entro 24 ore dalla lezione, con una bozza di sollecito per ciascuno |
| **Studenti a rischio** | gli studenti in difficoltà su più corsi insieme (assenze, consegne mancanti, voti insufficienti), prima i casi più seri, con una bozza di mail per un colloquio |

## Si può anche chiedere a parole

- *"Chi insegna martedì pomeriggio e in che aula?"*
- *"C'è un'aula libera giovedì dalle 14:30 alle 17:30?"*
- *"Mandami il messaggio WhatsApp con le lezioni della prof. Blanchard di questa settimana."*
- *"Quante assenze ha lo studente con matricola E000… in Research & QBM?"*
- *"Nella cartella Voti T1, il file di Marketing è a posto?"*

## Le aule

Moodle non conosce le aule: si scrivono nella **descrizione della sessione** del
registro presenze, così: `Aula: DREAM`. Per una lezione online basta la parola
`online`. Quando si creano più sessioni insieme, la descrizione vale per tutte.
Per spostare una lezione si modifica la sessione su Moodle; l'orario si aggiorna
alla richiesta successiva.

## Cosa Claude non fa mai da solo

Non cambia voti, presenze o messaggi agli studenti senza una conferma esplicita.
I voti dei professori vengono copiati come sono: se un voto è dubbio (scritto
male, studente non iscritto, stesso studente due volte) lo segnala e non lo carica.
