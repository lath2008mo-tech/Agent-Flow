# Agent Flow

**Öppen källkod · AI-agent + workflow-botar som gör jobbet**

Säg vad du vill ha gjort. AI:n sköter din **Shopify-butik**, dina **Google-appar** (Gmail, Kalender, Drive, Sheets, Docs, Tasks, Kontakter – via *Logga in med Google*, inga API-nycklar) och webben – och du kan bygga **botar** som kör arbetsflöden automatiskt på schema.

---

## ✨ Vad appen gör

| Funktionalitet | Beskrivning |
|---|---|
| 🔵 **Logga in med Google** | Ett klick ger AI:n åtkomst till Gmail, Kalender, Drive, Sheets, Docs, Tasks och Kontakter. |
| 🤖 **Botar** | Beskriv ett arbetsflöde med ord → boten körs manuellt, var N:e minut, dagligen eller veckovis. Minne mellan körningar + körlogg. Kan skapas direkt i chatten ("skapa en bot som…"). |
| 🌍 **Webb** | `web_search` + `fetch_url` – AI:n kan läsa webben. |
| 🛒 **Shopify-koppling** | Koppla din butik med ett Admin API-token (Custom App, 2 minuter). |
| ✦ **AI-Assistent** | Chatta med AI:n som hämtar riktig data och gör ändringar i butiken (verktyg / function calling). |
| 🌐 **Alla AI på ett ställe** | OpenAI (GPT), Anthropic (Claude), Google Gemini, Groq, DeepSeek, xAI (Grok), Mistral, **OpenRouter (300+ modeller)** och Ollama (lokalt). |
| 📊 **Snabbflöden** | Färdiga flöden: sammanfatta försäljning, skriv produktbeskrivningar, granska ordrar, planera rea, hitta VIP-kunder, skapa produkter. |
| 🔒 **Säkerhet** | API-skydd med åtkomstnyckel, AES-256-krypterade tokens i din egen databas. Raderingar avstängda som standard. |

## 🚀 Kom igång

### 1. Kör lokalt

```bash
npm install
npm start
```

Öppna http://localhost:3000

### 2. Deploya på Render

1. Pusha koden till GitHub.
2. På [render.com](https://render.com) → **New → Web Service** → peka på ditt repo.
3. Render läser `render.yaml` automatiskt (Build: `npm install`, Start: `npm start`).
4. Lägg gärna API-nycklar som miljövariabler under **Environment**:
   `SHOPIFY_STORE`, `SHOPIFY_TOKEN`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` m.fl.
   – eller lägg in dem direkt i appens UI under **Integrationer**.
5. På gratisplanen: gör punkt **Beständig lagring** nedan. Utan den försvinner
   Google-inloggningen varje gång tjänsten startar om.

### 2b. Beständig lagring + API-skydd (gratis, krävs på Render Free)

Render Free har en **tillfällig disk** – allt som sparas i `data/` försvinner vid
omstart/utrullning. Därför sparas Google-inloggningen (och Shopify-nycklar, botar,
körloggar) i en extern databas med gratisnivå, **krypterad med AES-256-GCM**.
Detta krävs innan Google-kontot kan kopplas:

| Miljövariabel (Render → Environment) | Vad den gör |
|---|---|
| `SUPABASE_URL` | Din projekt-URL, t.ex. `https://abcdefgh.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → `service_role` (**hemlig, server-only**) |
| `SETTINGS_ENCRYPTION_KEY` | Minst 32 slumpade tecken – krypterar alla tokens innan de lämnar servern |
| `APP_API_KEY` | Åtkomstnyckel till appens API/UI (frågas efter i appen första gången) |
| `SUPABASE_TABLE` | Valfri, standard `agent_flow_store` |

**Steg för steg (~5 minuter, inga betalkort):**

1. Skapa ett konto på [supabase.com](https://supabase.com) → **New project** (gratisnivån räcker).
2. Öppna **SQL Editor** och kör:

   ```sql
   create table if not exists public.agent_flow_store (
     id text primary key,
     payload jsonb not null default '{}'::jsonb,
     updated_at timestamptz not null default now()
   );
   alter table public.agent_flow_store enable row level security;
   -- Inga policies: bara service_role-nyckeln (som appen använder) kommer åt raden.
   ```

3. **Settings → API**: kopiera **Project URL** och **service_role**-nyckeln.
4. Skapa två hemligheter (kör lokalt, klistra aldrig in dem i chatten):

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # SETTINGS_ENCRYPTION_KEY
   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"   # APP_API_KEY
   ```

5. Render → din tjänst → **Environment** → lägg in de fyra variablerna → **Save**
   (tjänsten startar om automatiskt).
6. Öppna appen → ange `APP_API_KEY` på låsskärmen → **Integrationer → Driftstatus**
   ska visa **Allt klart** → klicka **Logga in med Google**.
7. Kontroll: starta om tjänsten (**Manual Deploy → Restart**) – Google-kortet ska
   fortfarande visa ditt konto.

> ⚠️ Ändra aldrig `SETTINGS_ENCRYPTION_KEY` efter att Google kopplats. Den gamla
> krypterade datan kan då inte läsas: appen behåller den orörd (raderar inget) och
> visar i **Driftstatus** att nyckeln inte stämmer – koppla i så fall Google på nytt
> eller sätt tillbaka den gamla nyckeln.

Utan `SUPABASE_*` (t.ex. vid lokal körning) används `data/settings.json` precis som förut,
och appen visar en varning i **Driftstatus**.

### 3. Koppla Shopify (2 minuter)

1. Shopify-admin → **Appar → Utveckla appar → Skapa en app** (namn t.ex. *Agent Flow*).
2. **Configuration → Admin API integration → Configure** – välj scopes:
   `read_products, write_products, read_orders, write_orders, read_customers, read_inventory, write_inventory, read_price_rules, write_price_rules, read_content`
3. **Install app** → kopiera **Admin API access token** (`shpat_...`).
4. I Agent Flow: **Integrationer** → klistra in butiksadress + token → **Testa anslutning**.

### 4. Lägg till AI-nycklar

Under **Integrationer** lägger du in API-nycklar från de leverantörer du vill använda.
Tips: en enda **OpenRouter**-nyckel ger tillgång till *alla* modeller (GPT, Claude, Gemini, Grok, Llama m.fl.).

### 5. Aktivera "Logga in med Google" (engångsinställning, ~5 min)

Google kräver att appen registreras en gång. Därefter loggar du (och andra) in med ett klick.

1. [console.cloud.google.com](https://console.cloud.google.com/apis/credentials) → skapa projekt → **OAuth consent screen** (External, lägg till dig som test user).
2. **Enable APIs**: Gmail, Calendar, Drive, Sheets, Docs, Tasks, People.
3. **Credentials → Create → OAuth client ID → Web application** → Authorized redirect URI: `https://DIN-DOMÄN/api/google/callback` (visas i appen).
4. Lägg in Client ID + Secret i appen under **Integrationer → Google** (eller env `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`).
5. På Render: se till att **Beständig lagring** (avsnitt 2b) är klar först – annars
   vägrar appen koppla Google och visar exakt vad som saknas under **Driftstatus**.
6. Klicka **Logga in med Google**. Klart – inloggningen sparas krypterat i din databas
   och överlever att gratisinstansen startar om.

### 6. Skapa en bot

**Botar → + Ny bot** → skriv t.ex. *"Varje morgon kl 7: mejla mig gårdagens försäljning och dagens möten"* → **Låt AI:n fylla i** → Spara.
Eller säg det direkt i chatten – AI:n använder `create_bot`.

## 🧰 AI-verktyg

**Google:** `gmail_search`, `gmail_read`, `gmail_send`, `gmail_reply`, `gmail_draft`, `gmail_modify`, `calendar_list_events`, `calendar_create_event`, `calendar_update_event`, `drive_search`, `drive_read_file`, `drive_create_file`, `sheets_read`, `sheets_append`, `sheets_write`, `sheets_create`, `docs_create`, `docs_append`, `tasks_list`, `tasks_create`, `tasks_complete`, `contacts_search`

**Botar & webb:** `create_bot`, `list_bots`, `update_bot`, `run_bot`, `web_search`, `fetch_url`, `get_current_time`

**Shopify:**

Assistenten kan bl.a.:

- `list_products`, `get_product`, `create_product`, `update_product`, `delete_product`
- `list_orders`, `get_order`, `update_order`
- `list_customers`, `list_collections`, `create_collection`
- `list_locations`, `set_inventory`
- `create_discount`, `list_discounts`
- `shop_stats`, `get_shop_info`

## ⚙️ Teknik

- **Backend:** Node.js + Express, inga tunga beroenden.
- **Lagring:** JSON-dokument i Supabase (PostgREST, gratisnivå) eller lokal fil – skrivs igenom direkt, med kryptering av hemliga fält.
- **AI:** OpenAI-kompatibelt API mot alla leverantörer + strömming (SSE) + verktygsloop.
- **Shopify:** Admin REST API.
- **Frontend:** Vanilla JS SPA (ingen build-stepp).

## 🔐 Säkerhet

- **API-skydd:** sätt `APP_API_KEY` – då kräver alla `/api/*`-anrop nyckeln
  (`x-api-key` eller `Authorization: Bearer`). Appen visar en låsskärm där du anger
  nyckeln en gång per webbläsare. Endast `/api/health`, `/api/auth/status` och
  Googles OAuth-callback är publika (callbacken skyddas av ett signerat OAuth-state).
- **Kryptering:** Google-tokens, Shopify-token och AI-nycklar krypteras med
  AES-256-GCM (`SETTINGS_ENCRYPTION_KEY`) innan de skrivs till databasen/filen.
  Nycklarna lämnar aldrig servern och maskeras i UI:t.
- **Extern lagring:** allt sparas i din egen Supabase-databas (eller lokalt) – inte hos någon tredje part.
- API-nycklar skrivs aldrig till git (`data/*.json` är ignorerat).
- Kör appen bakom HTTPS (Render gör det automatiskt).
- Lägg aldrig publika behörigheter på Shopify-token – ge appen bara de scopes den behöver.
- Använd `service_role`-nyckeln från Supabase **endast** på servern (miljövariabel i Render) – aldrig i frontend eller git.

## ⏰ Render Free och botar

Gratisinstansen **sover** efter inaktivitet. Botar körs därför bara när tjänsten är
vaken (schemaläggaren kollar varje minut medan den kör). Datat och Google-inloggningen
är ändå kvar tack vare den externa databasen – men garanterad drift dygnet runt kräver
en betald instans eller en extern väckning (t.ex. ett schemalagt anrop till `/api/health`).

## Licens

MIT
