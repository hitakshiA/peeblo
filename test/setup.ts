// Loaded before every test file (node --test --import). Core reads its configuration at import time and
// refuses to start without these, so tests get placeholders. Nothing here reaches a real service:
// the database pool connects only on a query, and the unit tests make none.
process.env.DATABASE_URL ??= "postgres://peeblo:test@127.0.0.1:1/peeblo_test";
process.env.PEEBLO_ADMIN_TOKEN ??= "test-admin-token";
process.env.PEEBLO_SECRET_KEY ??= Buffer.alloc(32, 7).toString("base64");
// Keeps a developer's own settings.json (in the real data directory) out of the tests.
process.env.PEEBLO_DATA_DIR = "/nonexistent/peeblo-test-data";
