// lib/config.js: where Evergreen sends anonymous totals for the world map.
//
// Fill these in from your Supabase project (Project Settings → API):
//   url:     the "Project URL", e.g. "https://abcdefgh.supabase.co"
//   anonKey: the public key: either the "Publishable key" (sb_publishable_…)
//            or the legacy "anon public" key (eyJ…). It's designed to be
//            public, so it's fine to ship in the extension. NEVER put the
//            secret key (sb_secret_…) or the service_role key here.
// Then run supabase/setup.sql once in the project's SQL Editor.
//
// While these are empty, sharing shows as "not set up" and nothing is sent.

(function () {
  const CLOUD = {
    url: "https://dtosarirwvatrvewssvx.supabase.co",
    anonKey: "sb_publishable_I30rf_kt2ENAHrKwcLmyGg_t2Tzf1cv",
    minUsersPerCountry: 1, // hackathon demo: show countries with 1+ sharing user. Raise to 3+ before a public launch.
    days: 30,              // the map shows the last 30 days
  };

  const configured = () => /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(CLOUD.url) && CLOUD.anonKey.length > 20;

  // Calls one of the database functions in supabase/setup.sql.
  async function rpc(name, args) {
    if (!configured()) throw new Error("Sharing isn't set up in this version (no database configured).");
    // Works with both kinds of public key: the newer "publishable" key
    // (sb_publishable_…) goes only in the apikey header; the older "anon"
    // key (a JWT starting with eyJ) is also sent as a Bearer token.
    const headers = { apikey: CLOUD.anonKey, "Content-Type": "application/json" };
    if (CLOUD.anonKey.startsWith("eyJ")) headers.Authorization = `Bearer ${CLOUD.anonKey}`;
    const res = await fetch(`${CLOUD.url}/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(args) });
    if (!res.ok) throw new Error(`Database error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  globalThis.PP = globalThis.PP ?? {};
  Object.assign(globalThis.PP, { CLOUD, cloudConfigured: configured, rpc });
})();
