/**
 * Mint a counsellor session token and print it, for driving the console from a script.
 *
 * Local tooling only: it uses the app's own `signIn`, so it cannot create a session the
 * sign-in form could not, and it is subject to the same disabled-account and password
 * checks. Nothing here bypasses auth; it just skips the browser.
 *
 *   npx tsx scripts/mint-session.mts <email> <password>
 */
import { signIn } from "@/lib/auth/session";
import { store } from "@/lib/store";

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error("usage: tsx scripts/mint-session.mts <email> <password>");
  process.exit(1);
}

const result = await signIn(await store(), { email, password });
if (!result.ok) {
  console.error(`sign-in failed: ${result.error}`);
  process.exit(1);
}
console.log(result.token);
