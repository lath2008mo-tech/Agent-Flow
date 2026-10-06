/**
 * Agent Flow – miljövariabler.
 * Små hjälpare så att alla moduler tolkar miljön på samma sätt.
 */

/** Första icke-tomma miljövariabeln av de angivna namnen. */
function first(...names) {
  for (const name of names) {
    const v = process.env[name];
    if (v && String(v).trim()) return String(v).trim();
  }
  return '';
}

/** Sant om miljövariabeln är satt till 1/true/yes/on. */
function flag(name) {
  const v = String(process.env[name] || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Sant när appen körs hos en host (t.ex. Render) där den lokala disken är
 * tillfällig. Då krävs extern lagring + krypteringsnyckel + API-skydd
 * innan Google-kontot får kopplas.
 */
function isHosted() {
  if (flag('REQUIRE_DURABLE_STORAGE')) return true;
  if (flag('ALLOW_LOCAL_FILE_STORAGE')) return false;
  return Boolean(
    first('RENDER', 'RENDER_SERVICE_ID', 'RENDER_EXTERNAL_URL') ||
    process.env.RENDER === 'true'
  );
}

module.exports = { first, flag, isHosted };
