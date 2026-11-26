// Reports names only; never prints credentials.
const groups = {
  Database: ["SUPABASE_DB_URL"],
  Authentication: ["SESSION_SECRET", "NEXT_PUBLIC_APP_URL"],
  Gmail: [
    "SUPPORT_MAILBOX",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REDIRECT_URI",
    "SUPPORT_TOKEN_KEY",
  ],
  Meta: ["META_APP_SECRET", "META_WEBHOOK_VERIFY_TOKEN"],
  AI: ["GEMINI_API_KEY"],
  Notifications: [
    "GMAIL_PUBSUB_TOPIC",
    "GMAIL_PUSH_SERVICE_ACCOUNT",
    "GMAIL_PUSH_AUDIENCE",
    "CRON_SECRET",
  ],
};
for (const [group, names] of Object.entries(groups)) {
  console.log(group);
  for (const name of names) {
    const present =
      name === "SUPABASE_DB_URL"
        ? Boolean(
            process.env.SUPABASE_DB_URL ||
              process.env.DATABASE_URL ||
              process.env.POSTGRES_URL
          )
        : name === "SESSION_SECRET"
          ? Boolean(process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32)
          : name === "SUPPORT_MAILBOX"
            ? true
            : Boolean(process.env[name]);
    console.log(`  ${present ? "READY" : "MISSING"} ${name}`);
  }
}
