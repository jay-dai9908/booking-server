function parseBankAccounts(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function formatBankLabel(bankName, bankCode) {
  const name = bankName ? String(bankName).trim() : '';
  const code = bankCode ? String(bankCode).trim() : '';
  if (!name && !code) return '';
  if (!name) return code;
  if (code && !name.includes(code)) {
    return `${name}（${code}）`;
  }
  return name;
}

export function formatMultiBankChoice(bank) {
  const name = bank?.bank_name ? String(bank.bank_name).trim() : '';
  const code = bank?.bank_code ? String(bank.bank_code).trim() : '';
  const account = bank?.account ? String(bank.account).trim() : '';
  return `${name} (${code}) ${account}`;
}

export function buildOrderPaymentInfo({ order, method, poolRow } = {}) {
  const methodCode = method?.code || order?.payment_method_code || '';
  const methodName = method?.name || order?.payment_method_code || '';
  const methodType = method?.method_type || (methodCode === 'onsite' ? 'ONSITE' : methodCode === 'ctbc_pool' ? 'POOL_ACCOUNT' : null);
  const needsPayment = methodType !== 'ONSITE';
  const instructions = method?.display_instructions || null;
  const requireLast5 = Boolean(needsPayment && method?.require_last5);

  let bankLabel = '';
  let account = null;
  let paymentUrl = null;
  let accountMissing = false;

  if (!needsPayment) {
    bankLabel = '';
    account = null;
    paymentUrl = null;
    accountMissing = false;
  } else if (methodType === 'POOL_ACCOUNT') {
    account = order?.assigned_pool_account ? String(order.assigned_pool_account).trim() : null;
    paymentUrl = order?.assigned_pool_url || poolRow?.payment_url || null;
    bankLabel = formatBankLabel(poolRow?.bank_name, poolRow?.bank_code);
    accountMissing = !account;
  } else if (methodType === 'MULTI_BANK') {
    const rawSelected = order?.selected_bank_info ? String(order.selected_bank_info).trim() : '';
    const accounts = parseBankAccounts(method?.bank_accounts_json);
    const matched = rawSelected
      ? accounts.find((b) => {
          const formatted = formatMultiBankChoice(b).trim();
          const bAcc = b?.account ? String(b.account).trim() : '';
          return formatted === rawSelected || (bAcc && bAcc === rawSelected);
        })
      : null;

    if (matched) {
      bankLabel = formatBankLabel(matched.bank_name, matched.bank_code);
      account = matched.account ? String(matched.account).trim() : null;
    } else if (rawSelected) {
      bankLabel = '';
      account = rawSelected;
    }
    accountMissing = !account;
  } else if (methodType === 'EWALLET') {
    bankLabel = '';
    account = null;
    paymentUrl = null;
    accountMissing = false;
  } else {
    account = order?.assigned_pool_account || order?.selected_bank_info || null;
    paymentUrl = order?.assigned_pool_url || poolRow?.payment_url || null;
    bankLabel = formatBankLabel(poolRow?.bank_name, poolRow?.bank_code);
    accountMissing = false;
  }

  return {
    method_code: methodCode,
    method_name: methodName,
    method_type: methodType,
    needs_payment: needsPayment,
    bank_label: bankLabel,
    account,
    payment_url: paymentUrl,
    instructions,
    require_last5: requireLast5,
    account_missing: accountMissing
  };
}
