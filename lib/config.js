// lib/config.js: where Evergreen sends anonymous totals for the world map.
//
// Fill these in from your Supabase project (Project Settings → API):
//   url:     the "Project URL", e.g. "https://abcdefgh.supabase.co"
//   anonKey: the "anon public" key. It's designed to be public, so it's
//            fine to ship in the extension. NEVER put the service_role key here.
// Then run supabase/setup.sql once in the project's SQL Editor.
//
// While these are empty, sharing shows as "not set up" and nothing is sent.

(function () {
  const CLOUD = {
    url: "",
    anonKey: "",
    minUsersPerCountry: 3, // countries with fewer sharing users stay hidden
    days: 30,              // the map shows the last 30 days
  };

  const configured = () => /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(CLOUD.url) && CLOUD.anonKey.length > 20;

  // Calls one of the database functions in supabase/setup.sql.
  async function rpc(name, args) {
    if (!configured()) throw new Error("Sharing isn't set up in this version (no database configured).");
    const res = await fetch(`${CLOUD.url}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { apikey: CLOUD.anonKey, Authorization: `Bearer ${CLOUD.anonKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`Database error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  globalThis.PP = globalThis.PP ?? {};
  Object.assign(globalThis.PP, { CLOUD, cloudConfigured: configured, rpc });
})();
