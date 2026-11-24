/**
 * Strip line_messaging_token from a GlobalSetting row and attach masked metadata.
 */
export function sanitizeGlobalSetting(setting) {
  if (!setting) return null;

  const rawToken =
    (setting.line_messaging_token && String(setting.line_messaging_token).trim()) ||
    process.env.LINE_MESSAGING_ACCESS_TOKEN ||
    '';
  const has_line_messaging_token = Boolean(rawToken);
  const line_messaging_token_masked = rawToken ? `••••••••${rawToken.slice(-4)}` : '';

  const safeSetting = {
    ...setting,
    has_line_messaging_token,
    line_messaging_token_masked
  };
  delete safeSetting.line_messaging_token;
  return safeSetting;
}
