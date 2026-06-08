/**
 * One-time CLI to create the first admin account.
 * Usage: node bootstrap-admin.js <username> <password>
 */
require('dotenv').config();
const userStore = require('./userStore');
const auth = require('./auth');

async function main() {
  const [username, password] = process.argv.slice(2);
  if (!username || !password) {
    console.error('Usage: node bootstrap-admin.js <username> <password>');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const existing = await userStore.count();
  if (existing > 0) {
    console.error(`Refusing to bootstrap: ${existing} user account(s) already exist. Use the Users admin page instead.`);
    process.exit(1);
  }

  const passwordHash = await auth.hashPassword(password);
  const user = await userStore.create({ username, passwordHash, role: 'admin' });
  console.log(`Created admin account "${user.username}" (id: ${user.id}). You can now log in.`);
}

main().catch(err => {
  console.error('Bootstrap failed:', err.message);
  process.exit(1);
});
