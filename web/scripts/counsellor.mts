/**
 * Counsellor account management, from a terminal.
 *
 *     npm run counsellor:add -- --email a@school.edu --name "A Bell" --role lead
 *     npm run counsellor:list
 *     npm run counsellor:disable -- --email a@school.edu
 *
 * Deliberately not a web form. The set of adults who may read children's disclosures is a
 * decision a school makes in a room, and a self-service sign-up page is a way for that set
 * to grow without anyone deciding it should. Someone with shell access to the deployment
 * is already trusted with the database; the CLI adds no authority that did not exist.
 *
 * The password is generated here rather than chosen. A lead typing a colleague's initial
 * password into a form picks something memorable, tells them over Teams, and it stays in
 * the message history — where a 20-byte random string is at least useless to remember and
 * so actually gets replaced.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const { hashPassword } = await import("@/lib/auth/password");
const { revokeAllSessions } = await import("@/lib/auth/session");
const { store } = await import("@/lib/store");

/**
 * Read `--name A Bell` as "A Bell".
 *
 * Tokens are joined until the next flag rather than taking only the one that follows,
 * because `npm run x -- --name "A Bell"` strips the quotes on the way through and a
 * silently truncated display name would end up in the audit log as "A".
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const parts: string[] = [];
  for (let j = i + 1; j < process.argv.length && !process.argv[j].startsWith("--"); j++) {
    parts.push(process.argv[j]);
  }
  return parts.length ? parts.join(" ") : undefined;
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

const command = process.argv[2];
const db = await store();

if (db.kind === "memory") {
  die(
    "No DATABASE_URL, so this would create an account in a Map and then exit.\n" +
      "Set DATABASE_URL in web/.env.local first.",
  );
}

switch (command) {
  case "add": {
    const email = arg("email") ?? die("--email is required");
    const name = arg("name") ?? die('--name is required, e.g. --name "A Bell"');
    const role = arg("role") ?? "counsellor";
    if (role !== "counsellor" && role !== "lead") {
      die('--role must be "counsellor" or "lead"');
    }
    if (await db.counsellorByEmail(email)) die(`${email} already has an account.`);

    const password = randomBytes(18).toString("base64url");
    const record = await db.createCounsellor({
      email,
      displayName: name,
      passwordHash: await hashPassword(password),
      role,
    });

    console.log(`\ncreated ${record.email} (${record.role}), id ${record.id}`);
    console.log(`temporary password: ${password}`);
    console.log(
      "\nGive this to them in person or over a channel that is not the one they will\n" +
        "use it on, and have them change it. There is no reset flow yet, so a lost\n" +
        "password means creating a new account.\n",
    );
    break;
  }

  case "list": {
    const rows = await db.listCounsellors();
    if (rows.length === 0) console.log("no accounts yet");
    for (const c of rows) {
      // No password hashes in the output. Not because printing one is exploitable, but
      // because a terminal scrollback in a shared office is a place they should never be.
      const seen = c.lastSeenAt ? new Date(c.lastSeenAt).toLocaleString() : "never";
      console.log(
        `${c.active ? " " : "✗"} ${c.email.padEnd(32)} ${c.role.padEnd(10)} ` +
          `${c.displayName.padEnd(20)} last seen ${seen}`,
      );
    }
    break;
  }

  case "disable": {
    const email = arg("email") ?? die("--email is required");
    const record = await db.counsellorByEmail(email);
    if (!record) die(`no account for ${email}`);

    // Both halves, in this order. Clearing `active` alone leaves live sessions working
    // until they expire, which is up to twelve hours of access for someone who has just
    // been removed; revoking sessions alone lets them sign straight back in.
    await db.setCounsellorActive(record.id, false);
    await revokeAllSessions(db, record.id);

    console.log(
      `disabled ${record.email} and revoked every live session.\n` +
        "The account and its audit history stay — an access log has to keep naming " +
        "someone after they leave.",
    );
    break;
  }

  default:
    die("usage: counsellor <add|list|disable> [--email …] [--name …] [--role …]");
}

process.exit(0);
