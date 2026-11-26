export function cookieSecure(req) {
  const raw = String(process.env.COOKIE_SECURE ?? '').trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return Boolean(
    req?.secure ||
    String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https'
  );
}
