process.loadEnvFile(".env.local");
const { neon } = await import("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL!);
const rows = await sql`
  select case_id, tier, confidence, started_at,
         card->>'awaitingClassifier' awaiting,
         (select count(*) from turns t where t.conversation_id = c.id) turns
  from conversations c
  where case_id like 'live-%'
  order by started_at`;
console.log(`${rows.length} live cases\n`);
console.log("case              tier  scored?      conf     turns  started");
for (const r of rows) {
  const scored = r.awaiting === "true" ? "GATE-ONLY" : "classifier";
  console.log(
    `${r.case_id.padEnd(17)} ${String(r.tier).padEnd(5)} ${scored.padEnd(11)} ` +
    `${r.confidence === null ? "  null" : Number(r.confidence).toFixed(3)}    ${String(r.turns).padStart(2)}    ` +
    `${new Date(r.started_at).toLocaleString()}`,
  );
}
const gateOnly = rows.filter((r: any) => r.awaiting === "true").length;
console.log(`\ngate-only: ${gateOnly}  (this is the number in the purple banner)`);
process.exit(0);
