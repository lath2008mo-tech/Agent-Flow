# Konfigurera beständig lagring på Render Free (Supabase, gratis)

Den här guiden tar dig från "Google-inloggningen försvinner när tjänsten vilar" till
"inloggningen finns kvar efter omstart" – utan att uppgradera Render och utan
betalda resurser. Räkna med **~10 minuter**. Inga nycklar ska klistras in i en chat.

> **Varför:** Render Free har en tillfällig disk. Allt som sparas i `data/` försvinner
> vid omstart, utrullning och när instansen startas om. Därför sparar Agent Flow
> tokens i din egen Supabase-databas (gratisnivån) – krypterade med AES-256-GCM.

---

## Del 1 – Supabase (5 min)

1. Gå till **[supabase.com](https://supabase.com)** → **Start your project** → skapa ett konto
   (GitHub-inloggning går bra). Inga betalkort behövs.
2. **New project**:
   - Namn: `agent-flow`
   - Databaslösenord: låt Supabase generera ett (vi använder det inte i appen)
   - Region: **Europe (Frankfurt)** eller **Stockholm** om det erbjuds – närmast dig
   - Plan: **Free**
3. Vänta tills projektet är klart (~1 min).
4. Öppna **SQL Editor** (vänstermenyn) → **New query** → klistra in och kör:

   ```sql
   create table if not exists public.agent_flow_store (
     id text primary key,
     payload jsonb not null default '{}'::jsonb,
     updated_at timestamptz not null default now()
   );
   alter table public.agent_flow_store enable row level security;
   ```

   Du ska få `Success. No rows returned`. (Inga policies behövs: bara `service_role`
   kommer åt raden, och den nyckeln används uteslutande av din server.)
5. Öppna **Settings → API** och kopiera två saker – låt fliken ligga kvar:
   - **Project URL** (ser ut som `https://abcdefghijkl.supabase.co`)
   - **service_role** under *Project API keys* (den hemliga – klicka **Reveal**)

   ⚠️ Använd **inte** `anon`-nyckeln. `service_role` får aldrig hamna i en webbläsare,
   i git eller i en chatt.

## Del 2 – Två hemligheter till (1 min)

Kör det här i din egen terminal och kopiera utskrifterna. De genereras lokalt
och lämnar aldrig din dator förrän du klistrar in dem i Render.

```bash
node -e "console.log('SETTINGS_ENCRYPTION_KEY =', require('crypto').randomBytes(32).toString('base64url'))"
node -e "console.log('APP_API_KEY               =', require('crypto').randomBytes(24).toString('base64url'))"
```

- `SETTINGS_ENCRYPTION_KEY` krypterar tokens i databasen.
- `APP_API_KEY` blir din åtkomstnyckel till appen (den skriver du in i appen en gång).

## Del 3 – Render (3 min)

1. Öppna **[dashboard.render.com](https://dashboard.render.com)** → din tjänst (`agent-flow`).
2. Gå till **Environment** → **Add Environment Variable** och lägg in:

   | Key | Value |
   |---|---|
   | `SUPABASE_URL` | Project URL från Del 1 |
   | `SUPABASE_SERVICE_ROLE_KEY` | service_role-nyckeln från Del 1 |
   | `SETTINGS_ENCRYPTION_KEY` | nyckeln från Del 2 |
   | `APP_API_KEY` | nyckeln från Del 2 |
   | `SUPABASE_TABLE` | *(valfritt)* `agent_flow_store` |

3. **Save Changes** – Render startar om tjänsten automatiskt och rullar ut senaste commit.
4. Om tjänsten inte rullar ut senaste koden: **Manual Deploy → Deploy latest commit**.
5. Titta i **Logs**. Du ska se:

   ```
   [store] Lagring: Supabase · kryptering: på
   Agent Flow körs på http://0.0.0.0:10000
   ```

   Står det `lokal fil` eller `kryptering: AV` – kontrollera stavningen på variablerna
   (och att du sparade).

## Del 4 – Verifiera (1 min)

Öppna appen: `https://agent-flow-f2oo.onrender.com/app`

1. **Låsskärmen** dyker upp → skriv in `APP_API_KEY` → **Lås upp**.
   (Nyckeln sparas bara i din webbläsare; "Rensa sparad nyckel" tar bort den.)
2. Gå till **Integrationer → Driftstatus**. Allt ska vara grönt utom Google-uppgifterna.
3. Vill du kontrollera från terminalen i stället:

   ```bash
   # status för den deployade appen (inga hemligheter i svaret)
   curl -s https://agent-flow-f2oo.onrender.com/api/health | python3 -m json.tool

   # eller med hjälpskriptet (jämför även före/efter en omstart)
   node scripts/verify-deploy.js https://agent-flow-f2oo.onrender.com --api-key=DIN_APP_API_KEY
   ```

## Del 5 – Koppla Google och testa omstarten (2 min)

1. I appen: **Integrationer → Google** → fyll i **Client ID** + **Client Secret** (samma
   som förut, från Google Cloud Console) → **Spara**.
   Kontrollera att *Authorized redirect URI* i Google Cloud är
   `https://agent-flow-f2oo.onrender.com/api/google/callback`.
2. Klicka **Logga in med Google** → välj konto → godkänn. Du kommer tillbaka till appen
   med grön bock och "sparas nu i din externa databas (krypterat)".
3. **Omstartstestet** (det viktigaste):
   - Notera tidsstämpeln:
     `curl -s https://agent-flow-f2oo.onrender.com/api/health | python3 -c "import json,sys; print(json.load(sys.stdin)['setup']['google'])"`
   - Render → **Manual Deploy → Restart**
   - Kör samma kommando igen. Kör du `verify-deploy.js` två gånger i stället skriver
     skriptet ut svaret själv.

   ✅ `connected: true` och **samma `connectedAt`** som före omstarten = inloggningen överlevde.
   ❌ `connected: false` = databasen används inte – kontrollera `SUPABASE_URL` och
   `SUPABASE_SERVICE_ROLE_KEY` (och att tabellen skapades i Del 1).

## Vad sparas var?

| Data | Plats |
|---|---|
| Google-tokens (refresh/access), profil | Supabase, **krypterat** |
| Google Client ID + Secret | Supabase, Secret **krypterat** |
| Shopify-token, AI-nycklar | Supabase, **krypterat** |
| Botar, scheman, körloggar | Supabase (innehåller inga hemligheter) |
| `APP_API_KEY` | Render Environment – användarens kopia i webbläsaren |
| `SETTINGS_ENCRYPTION_KEY` | Render Environment (aldrig i databasen) |

## Felsökning

| Symptom | Åtgärd |
|---|---|
| Driftstatus: *"Tabellen agent_flow_store finns inte"* | Kör SQL:en i Del 1 i Supabase → SQL Editor. |
| Driftstatus: *"Nyckeln avvisades"* | Du använde `anon`-nyckeln. Använd `service_role`. |
| *"Krypteringsnyckeln stämmer inte med nyckeln som användes när … sparades"* | `SETTINGS_ENCRYPTION_KEY` ändrades. Sätt tillbaka den gamla, eller koppla Google på nytt. Inget data raderas. |
| Låsskärmen säger att nyckeln är fel | `APP_API_KEY` i Render har ett annat värde än det du skrev. Jämför (t.ex. genom att sätta ett nytt värde på båda ställena). |
| Appen svarar långsamt första gången | Gratisinstansen sover efter ~15 min. Första anropet väcker den (30–60 s). |
| Botarna kör inte på natten | Gratisinstansen sover – botar kör bara när tjänsten är vaken. Beständig *data* löser inte det; det kräver betald instans eller extern väckning. |
| `429` i API:t | 12 felaktiga nyckelförsök per minut. Vänta en minut. |

## Säkerhet och rotation

- Skriv aldrig in nycklar i en chatt eller ett ärende – klistra bara in dem i Render/Supabase.
- `service_role`-nyckeln ger full åtkomst till databasen: byt den i Supabase om den läckt
  (**Settings → API → Rotate**) och uppdatera värdet i Render.
- Byter du `APP_API_KEY`: alla webbläsare måste ange den nya nyckeln igen. Inloggningen
  mot Google påverkas inte.
- Byter du `SETTINGS_ENCRYPTION_KEY`: gamla tokens kan inte längre läsas (de behålls men
  blir oläsbara). Koppla i så fall Google på nytt. Byt därför helst aldrig denna.
- Rensa alltid testnycklar efteråt om du testat manuellt.
