import fetch from 'node-fetch';

async function test() {
  const res = await fetch('http://localhost:3000/api/reservations/admin', {
    headers: { 'Authorization': `Bearer ${process.env.ADMIN_TOKEN || ''}` }
  });
}
test();
