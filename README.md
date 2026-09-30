# Agent Flow

**Öppen källkod · AI-hubb för e-handel**

Koppla din Shopify-butik, prata med *alla* AI-modeller på ett ställe – och låt AI:n sköta butiken åt dig: produkter, ordrar, kunder, lager, rabatter och statistik.

---

## ✨ Vad appen gör

| Funktionalitet | Beskrivning |
|---|---|
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

## 🧰 AI-verktyg

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
