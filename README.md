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
| 🔒 **Säkerhet** | Raderingar avstängda som standard. Nycklar sparas bara på din server. |

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
5. Klicka **Logga in med Google**. Klart.

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
- **AI:** OpenAI-kompatibelt API mot alla leverantörer + strömming (SSE) + verktygsloop.
- **Shopify:** Admin REST API.
- **Frontend:** Vanilla JS SPA (ingen build-stepp).

## 🔐 Säkerhet

- API-nycklar maskeras i UI och skrivs aldrig till git (`data/settings.json` är ignorerad).
- Kör appen bakom HTTPS (Render gör det automatiskt).
- Lägg aldrig publika behörigheter på Shopify-token – ge appen bara de scopes den behöver.

## Licens

MIT
