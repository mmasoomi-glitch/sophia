import db from './gate-check-db.mjs';
export async function admin() {
  await db.all('SELECT * FROM users');
  await db.get('SELECT * FROM users WHERE id = ?', [1]);
  await db.run('UPDATE users SET name = ?', ['x']);
}
