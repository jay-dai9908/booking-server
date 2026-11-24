/**
 * Build a Prisma User where filter that excludes merged manual users.
 */
export function activeUserWhere(extra = {}) {
  return {
    ...extra,
    merged_into_user_id: null
  };
}
