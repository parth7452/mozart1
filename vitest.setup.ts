// Loads .env so the Postgres integration tests find DATABASE_URL locally. In CI
// the variable is already set; tests that need a database skip themselves when
// it is missing rather than failing.
import 'dotenv/config';
