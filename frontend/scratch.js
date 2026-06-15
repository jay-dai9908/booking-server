import fetch from 'node-fetch';

async function test() {
  const res = await fetch('http://localhost:3000/api/reservations/admin', {
    headers: { 'Authorization': 'Bearer admin_token_here' } // Wait, I don't have the token.
  });
}
test();
