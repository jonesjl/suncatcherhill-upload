export function getAllowedUploadEmails(): Set<string> {
  return new Set(
    (process.env.ALLOWED_UPLOAD_EMAILS ?? "")
      .split(",")
      .map(normalizeEmail)
      .filter(Boolean),
  );
}

export function isAllowedUploadEmail(email: string | null | undefined): boolean {
  const normalizedEmail = normalizeEmail(email);

  return normalizedEmail.length > 0 && getAllowedUploadEmails().has(normalizedEmail);
}

function normalizeEmail(email: string | null | undefined): string {
  return email?.trim().toLowerCase() ?? "";
}
