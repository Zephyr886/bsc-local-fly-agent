export class FlyRepositoryError extends Error {
  constructor(code, message, { fields = [], cause } = {}) {
    super(message, { cause });
    this.name = "FlyRepositoryError";
    this.code = code;
    this.fields = fields;
  }
}

export function revisionConflict(expectedRevision, actualRevision) {
  return new FlyRepositoryError(
    "PROFILE_REVISION_CONFLICT",
    `Profile revision 已变化（期望 ${expectedRevision}，当前 ${actualRevision}）`,
    { fields: [{ path: "/expectedRevision", reason: `当前 revision 为 ${actualRevision}` }] },
  );
}

export function invalidId(kind, value) {
  const upper = kind.toUpperCase();
  return new FlyRepositoryError(
    `INVALID_${upper}_ID`,
    `${kind}Id 格式无效`,
    { fields: [{ path: `/${kind}Id`, reason: `不接受的 ID：${String(value)}` }] },
  );
}
