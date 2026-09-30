/**
 * Agent Flow – Shopify-koppling (Admin REST API).
 * Ger AI:n verktyg för att läsa och styra butiken: produkter, ordrar,
 * kunder, kollektioner, lager, rabatter och statistik.
 */

function normalizeStore(store) {
  let s = String(store || '').trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.myshopify\.com$/, '');
  if (!s) return '';
  return `${s}.myshopify.com`;
}

async function shopifyRequest(settings, method, path, body) {
  const { store, token, apiVersion } = settings.shopify;
  const domain = normalizeStore(store);
  if (!domain || !token) {
    const err = new Error('Shopify är inte anslutet. Gå till "Integrationer" och koppla din butik (butiksadress + Admin API-token).');
    err.status = 400;
    throw err;
  }
  const url = `https://${domain}/admin/api/${apiVersion || '2026-04'}/${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000)
    });
  } catch (e) {
    const err = new Error(`Kunde inte nå Shopify (${domain}): ${e.message}`);
    err.status = 502;
    throw err;
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      detail = JSON.stringify(j).slice(0, 300);
    } catch { /* behåll text */ }
    let message;
    if (res.status === 401 || res.status === 403) {
      message = 'Shopify avvisade nyckeln. Kontrollera att Admin API-token är rätt och att appen har rätt behörigheter (scopes).';
    } else if (res.status === 404) {
      message = `Shopify hittade inte resursen (${path}). Kontrollera butiksadressen.`;
    } else if (res.status === 429) {
      message = 'Shopify rate limit nådd – vänta en stund och försök igen.';
    } else {
      message = `Shopify-fel ${res.status}: ${detail}`;
    }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

// ---------- Hjälp: smala, AI-vänliga svar ----------

function slimProduct(p) {
  const variants = p.variants || [];
  return {
    id: p.id,
    title: p.title,
    handle: p.handle,
    status: p.status,
    vendor: p.vendor,
    product_type: p.product_type,
    tags: p.tags,
    price: variants[0] ? variants[0].price : null,
    compare_at_price: variants[0] ? variants[0].compare_at_price : null,
    sku: variants[0] ? variants[0].sku : null,
    inventory: variants.reduce((n, v) => n + (v.inventory_quantity || 0), 0),
    variants_count: variants.length,
    description: p.body_html ? String(p.body_html).replace(/<[^>]+>/g, ' ').trim().slice(0, 400) : '',
    created_at: p.created_at,
    updated_at: p.updated_at
  };
}

function slimOrder(o) {
  return {
    id: o.id,
    name: o.name,
    email: o.email,
    created_at: o.created_at,
    financial_status: o.financial_status,
    fulfillment_status: o.fulfillment_status || 'unfulfilled',
    total_price: o.total_price,
    currency: o.currency,
    item_count: (o.line_items || []).reduce((n, li) => n + (li.quantity || 0), 0),
    customer: o.customer ? `${o.customer.first_name || ''} ${o.customer.last_name || ''}`.trim() : null,
    tags: o.tags,
    note: o.note
  };
}

function slimCustomer(c) {
  return {
    id: c.id,
    name: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
    email: c.email,
    phone: c.phone,
    orders_count: c.orders_count,
    total_spent: c.total_spent,
    tags: c.tags,
    created_at: c.created_at
  };
}

function slimCollection(c) {
  return {
    id: c.id,
    title: c.title,
    handle: c.handle,
    products_count: c.products_count,
    published: c.published_at ? true : false
  };
}

function limitArg(args) {
  const n = parseInt(args && args.limit, 10);
  return Math.min(Math.max(isNaN(n) ? 25 : n, 1), 100);
}

// ---------- Verktygsdefinitioner ----------

const TOOLS = [
  {
    name: 'get_shop_info',
    description: 'Hämta info om butiken: namn, domän, valuta, språk, antal produkter m.m. Använd för att orientera dig.',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    },
    execute: (args, ctx) => shopifyRequest(ctx.settings, 'GET', 'shop.json').then((d) => d.shop)
  },
  {
    name: 'list_products',
    description: 'Lista eller sök produkter. Sök med "query" (t.ex. "t-shirt", "klänning"), filtrera på status (active/draft/archived).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Söktext – matchar titel, beskrivning, vendor m.m.' },
        status: { type: 'string', enum: ['active', 'draft', 'archived', 'any'], description: 'Standard: active' },
        limit: { type: 'integer', description: 'Antal produkter (1-100, standard 25)' }
      },
      required: []
    },
    execute: async (args, ctx) => {
      const limit = limitArg(args);
      const status = args.status && args.status !== 'any' ? `&status=${args.status}` : '';
      let data;
      if (args.query) {
        data = await shopifyRequest(ctx.settings, 'GET', `products/search.json?query=${encodeURIComponent(args.query)}&limit=${limit}${status}&fields=id,title,handle,status,vendor,product_type,tags,variants,body_html,created_at,updated_at`);
      } else {
        data = await shopifyRequest(ctx.settings, 'GET', `products.json?limit=${limit}${status}`);
      }
      return { count: (data.products || []).length, products: (data.products || []).map(slimProduct) };
    }
  },
  {
    name: 'get_product',
    description: 'Hämta en enskild produkt med alla detaljer inklusive varianter, priser och lagersaldo.',
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'integer', description: 'Produktens ID' }
      },
      required: ['product_id']
    },
    execute: async (args, ctx) => {
      const d = await shopifyRequest(ctx.settings, 'GET', `products/${args.product_id}.json`);
      return slimProduct(d.product);
    }
  },
  {
    name: 'create_product',
    description: 'Skapa en ny produkt i butiken. Skapa alltid minst titel och pris. Beskrivningar skrivs i HTML (t.ex. "<p>text</p>").',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Produktens namn' },
        description: { type: 'string', description: 'Produktbeskrivning i HTML' },
        price: { type: 'string', description: 'Pris, t.ex. "499.00"' },
        compare_at_price: { type: 'string', description: 'Ordinariepris (för reor), t.ex. "699.00"' },
        sku: { type: 'string' },
        vendor: { type: 'string', description: 'Leverantör/varumärke' },
        product_type: { type: 'string', description: 'Produkttyp, t.ex. "T-shirts"' },
        tags: { type: 'string', description: 'Kommaseparerade taggar, t.ex. "sommar,rea"' },
        inventory_quantity: { type: 'integer', description: 'Lagersaldo' },
        status: { type: 'string', enum: ['active', 'draft', 'archived'], description: 'Standard: active' }
      },
      required: ['title', 'price']
    },
    execute: async (args, ctx) => {
      const variant = {
        price: String(args.price),
        option1: 'Default Title'
      };
      if (args.compare_at_price) variant.compare_at_price = String(args.compare_at_price);
      if (args.sku) variant.sku = args.sku;
      if (args.inventory_quantity != null) {
        variant.inventory_management = 'shopify';
        variant.inventory_quantity = args.inventory_quantity;
      }
      const d = await shopifyRequest(ctx.settings, 'POST', 'products.json', {
        product: {
          title: args.title,
          body_html: args.description || '',
          vendor: args.vendor || '',
          product_type: args.product_type || '',
          tags: args.tags || '',
          status: args.status || 'active',
          variants: [variant]
        }
      });
      return slimProduct(d.product);
    }
  },
  {
    name: 'update_product',
    description: 'Uppdatera en befintlig produkts titel, beskrivning, pris, taggar, status eller lager. Skicka bara fält som ska ändras.',
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'integer', description: 'Produktens ID' },
        title: { type: 'string' },
        description: { type: 'string', description: 'Ny produktbeskrivning i HTML' },
        price: { type: 'string', description: 'Nytt pris, t.ex. "399.00"' },
        compare_at_price: { type: 'string' },
        sku: { type: 'string' },
        vendor: { type: 'string' },
        product_type: { type: 'string' },
        tags: { type: 'string' },
        status: { type: 'string', enum: ['active', 'draft', 'archived'] },
        inventory_quantity: { type: 'integer', description: 'Nytt lagersaldo' }
      },
      required: ['product_id']
    },
    execute: async (args, ctx) => {
      const current = await shopifyRequest(ctx.settings, 'GET', `products/${args.product_id}.json`);
      const p = current.product;
      const update = { id: p.id };
      for (const f of ['title', 'vendor', 'product_type', 'tags', 'status']) {
        if (args[f] != null) update[f] = args[f];
      }
      if (args.description != null) update.body_html = args.description;
      if (args.price != null || args.compare_at_price != null || args.sku != null || args.inventory_quantity != null) {
        update.variants = (p.variants || []).map((v, i) => {
          const nv = { id: v.id };
          if (i === 0) {
            if (args.price != null) nv.price = String(args.price);
            if (args.compare_at_price != null) nv.compare_at_price = String(args.compare_at_price);
            if (args.sku != null) nv.sku = args.sku;
            if (args.inventory_quantity != null) {
              nv.inventory_management = 'shopify';
              nv.inventory_quantity = args.inventory_quantity;
            }
          }
          return nv;
        });
      }
      const d = await shopifyRequest(ctx.settings, 'PUT', `products/${args.product_id}.json`, { product: update });
      return slimProduct(d.product);
    }
  },
  {
    name: 'delete_product',
    description: 'Radera en produkt permanent. Använd ENDAST om användaren uttryckligen bett om det.',
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'integer', description: 'Produktens ID' }
      },
      required: ['product_id']
    },
    execute: async (args, ctx) => {
      if (!ctx.settings.allowDestructive) {
        return {
          error: 'Raderingar är avstängda i inställningarna. Säg till användaren att slå på "Tillåt raderingar" under Inställningar om de verkligen vill radera.'
        };
      }
      await shopifyRequest(ctx.settings, 'DELETE', `products/${args.product_id}.json`);
      return { deleted: true, product_id: args.product_id };
    }
  },
  {
    name: 'list_orders',
    description: 'Lista ordrar. Filtrera på status: open, closed, cancelled, any. Visa senaste ordrarna.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'closed', 'cancelled', 'any'], description: 'Standard: open' },
        limit: { type: 'integer', description: 'Antal ordrar (1-100, standard 25)' },
        query: { type: 'string', description: 'Sök på kundnamn, e-post eller ordernummer' }
      },
      required: []
    },
    execute: async (args, ctx) => {
      const limit = limitArg(args);
      const status = args.status || 'open';
      let path = `orders.json?status=${status}&limit=${limit}&order=created_at desc`;
      if (args.query) {
        path = `orders.json?status=${status}&limit=${limit}&order=created_at desc&name=${encodeURIComponent(args.query)}`;
      }
      const d = await shopifyRequest(ctx.settings, 'GET', path);
      let orders = (d.orders || []).map(slimOrder);
      if (args.query) {
        const q = String(args.query).toLowerCase();
        orders = orders.filter(
          (o) =>
            (o.name || '').toLowerCase().includes(q) ||
            (o.email || '').toLowerCase().includes(q) ||
            (o.customer || '').toLowerCase().includes(q)
        );
      }
      return { count: orders.length, orders };
    }
  },
  {
    name: 'get_order',
    description: 'Hämta en enskild order med radprodukter, kund och betalstatus.',
    parameters: {
      type: 'object',
      properties: {
        order_id: { type: 'integer', description: 'Orderns ID' }
      },
      required: ['order_id']
    },
    execute: async (args, ctx) => {
      const d = await shopifyRequest(ctx.settings, 'GET', `orders/${args.order_id}.json`);
      const o = d.order;
      return {
        ...slimOrder(o),
        line_items: (o.line_items || []).map((li) => ({
          title: li.title,
          variant_title: li.variant_title,
          quantity: li.quantity,
          price: li.price,
          sku: li.sku
        })),
        shipping_address: o.shipping_address || null,
        billing_address: o.billing_address || null
      };
    }
  },
  {
    name: 'update_order',
    description: 'Uppdatera en order: lägg till/ändra taggar eller intern notering.',
    parameters: {
      type: 'object',
      properties: {
        order_id: { type: 'integer', description: 'Orderns ID' },
        tags: { type: 'string', description: 'Kommaseparerade taggar, t.ex. "VIP,skyndad"' },
        note: { type: 'string', description: 'Intern notering om ordern' }
      },
      required: ['order_id']
    },
    execute: async (args, ctx) => {
      const update = { id: args.order_id };
      if (args.tags != null) update.tags = args.tags;
      if (args.note != null) update.note = args.note;
      const d = await shopifyRequest(ctx.settings, 'PUT', `orders/${args.order_id}.json`, { order: update });
      return slimOrder(d.order);
    }
  },
  {
    name: 'list_customers',
    description: 'Lista eller sök kunder.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Sök på namn eller e-post' },
        limit: { type: 'integer', description: '1-100, standard 25' }
      },
      required: []
    },
    execute: async (args, ctx) => {
      const limit = limitArg(args);
      const d = await shopifyRequest(ctx.settings, 'GET', `customers.json?limit=${limit}`);
      let customers = (d.customers || []).map(slimCustomer);
      if (args.query) {
        const q = String(args.query).toLowerCase();
        customers = customers.filter(
          (c) => (c.name || '').toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q)
        );
      }
      return { count: customers.length, customers };
    }
  },
  {
    name: 'list_collections',
    description: 'Lista produktkollektioner (kategorier) i butiken.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '1-100, standard 50' }
      },
      required: []
    },
    execute: async (args, ctx) => {
      const limit = limitArg(args);
      const custom = await shopifyRequest(ctx.settings, 'GET', `custom_collections.json?limit=${limit}`);
      let smart = { smart_collections: [] };
      try {
        smart = await shopifyRequest(ctx.settings, 'GET', `smart_collections.json?limit=${limit}`);
      } catch { /* smarta kollektioner kan vara avstängda */ }
      const collections = [
        ...(custom.custom_collections || []).map(slimCollection),
        ...(smart.smart_collections || []).map(slimCollection)
      ];
      return { count: collections.length, collections };
    }
  },
  {
    name: 'create_collection',
    description: 'Skapa en manuell produktkollektion.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Kollektionens namn' },
        description: { type: 'string', description: 'Beskrivning i HTML' }
      },
      required: ['title']
    },
    execute: async (args, ctx) => {
      const d = await shopifyRequest(ctx.settings, 'POST', 'custom_collections.json', {
        custom_collection: { title: args.title, body_html: args.description || '' }
      });
      return slimCollection(d.custom_collection);
    }
  },
  {
    name: 'list_locations',
    description: 'Lista lagar/lokationer (behövs för lagersaldo per plats).',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    },
    execute: async (args, ctx) => {
      const d = await shopifyRequest(ctx.settings, 'GET', 'locations.json');
      return {
        locations: (d.locations || []).map((l) => ({ id: l.id, name: l.name, active: l.active, city: l.city }))
      };
    }
  },
  {
    name: 'set_inventory',
    description: 'Sätt lagersaldo för en variant på en specifik lokation.',
    parameters: {
      type: 'object',
      properties: {
        variant_id: { type: 'integer', description: 'Variantens ID (från get_product)' },
        location_id: { type: 'integer', description: 'Lokationens ID (från list_locations)' },
        available: { type: 'integer', description: 'Nytt lagersaldo' }
      },
      required: ['variant_id', 'location_id', 'available']
    },
    execute: async (args, ctx) => {
      // Hämta variantens inventory_item_id först
      const vd = await shopifyRequest(ctx.settings, 'GET', `variants/${args.variant_id}.json`);
      const inventoryItemId = vd.variant && vd.variant.inventory_item_id;
      if (!inventoryItemId) return { error: `Variant ${args.variant_id} saknar lagerpost (inventory_item).` };
      const d = await shopifyRequest(ctx.settings, 'POST', 'inventory_levels/set.json', {
        location_id: args.location_id,
        inventory_item_id: inventoryItemId,
        available: args.available
      });
      return d.inventory_level || { ok: true, variant_id: args.variant_id, available: args.available };
    }
  },
  {
    name: 'create_discount',
    description: 'Skapa en rabattkod (t.ex. "SOMMAR10" med 10% rabatt).',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Rabattkoden kunderna skriver, t.ex. "SOMMAR10"' },
        value_type: { type: 'string', enum: ['percentage', 'fixed_amount'], description: 'percentage = %, fixed_amount = belopp' },
        value: { type: 'string', description: 'Rabattens storlek, t.ex. "10" för 10% eller "50" för 50 kr' },
        minimum_purchase: { type: 'string', description: 'Minsta orderbelopp för att koden ska gälla (valfritt)' },
        usage_limit: { type: 'integer', description: 'Max antal gånger koden kan användas (valfritt)' }
      },
      required: ['code', 'value_type', 'value']
    },
    execute: async (args, ctx) => {
      const val = args.value_type === 'percentage' ? `-${args.value}` : `-${args.value}`;
      const priceRule = {
        title: args.code,
        target_type: 'line_item',
        target_selection: 'all',
        allocation_method: 'across',
        value_type: args.value_type,
        value: val,
        customer_selection: 'all',
        once_per_customer: false,
        starts_at: new Date().toISOString()
      };
      if (args.minimum_purchase) priceRule.prerequisite_subtotal_range = { greater_than_or_equal_to: String(args.minimum_purchase) };
      if (args.usage_limit) priceRule.usage_limit = args.usage_limit;
      const rule = await shopifyRequest(ctx.settings, 'POST', 'price_rules.json', { price_rule: priceRule });
      const code = await shopifyRequest(ctx.settings, 'POST', `price_rules/${rule.price_rule.id}/discount_codes.json`, {
        discount_code: { code: args.code }
      });
      return {
        created: true,
        price_rule_id: rule.price_rule.id,
        code: code.discount_code.code,
        value_type: args.value_type,
        value: args.value
      };
    }
  },
  {
    name: 'list_discounts',
    description: 'Lista befintliga rabatter/prisregler.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '1-100, standard 25' }
      },
      required: []
    },
    execute: async (args, ctx) => {
      const d = await shopifyRequest(ctx.settings, 'GET', `price_rules.json?limit=${limitArg(args)}`);
      return {
        count: (d.price_rules || []).length,
        discounts: (d.price_rules || []).map((r) => ({
          id: r.id,
          title: r.title,
          value_type: r.value_type,
          value: r.value,
          starts_at: r.starts_at,
          ends_at: r.ends_at,
          usage_limit: r.usage_limit
        }))
      };
    }
  },
  {
    name: 'shop_stats',
    description: 'Sammanfattning av butiken: antal produkter, ordrar och intäkter senaste dagarna, plus topprodukter.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Hur många dagar bakåt att sammanfatta (standard 30)' }
      },
      required: []
    },
    execute: async (args, ctx) => {
      const days = Math.min(Math.max(parseInt(args.days, 10) || 30, 1), 365);
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const [productsCount, customersCount, ordersData] = await Promise.all([
        shopifyRequest(ctx.settings, 'GET', 'products/count.json'),
        shopifyRequest(ctx.settings, 'GET', 'customers/count.json'),
        shopifyRequest(ctx.settings, 'GET', `orders.json?status=any&limit=250&created_at_min=${encodeURIComponent(since)}&order=created_at desc`)
      ]);
      const orders = ordersData.orders || [];
      const revenue = orders
        .filter((o) => o.financial_status === 'paid' || o.financial_status === 'partially_paid')
        .reduce((n, o) => n + parseFloat(o.total_price || 0), 0);
      const topProducts = {};
      for (const o of orders) {
        for (const li of o.line_items || []) {
          topProducts[li.title] = (topProducts[li.title] || 0) + (li.quantity || 0);
        }
      }
      return {
        period_days: days,
        products: productsCount.count,
        customers: customersCount.count,
        orders_in_period: orders.length,
        revenue_in_period: Math.round(revenue * 100) / 100,
        currency: orders[0] ? orders[0].currency : null,
        top_products: Object.entries(topProducts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([title, qty]) => ({ title, sold: qty }))
      };
    }
  }
];

async function runTool(name, args, ctx) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { error: `Okänt verktyg: ${name}` };
  try {
    const result = await tool.execute(args || {}, ctx);
    return result;
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { TOOLS, runTool, normalizeStore, shopifyRequest, slimProduct, slimOrder };
