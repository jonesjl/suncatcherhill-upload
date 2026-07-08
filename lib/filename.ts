export const MAX_FILE_SIZE_BYTES = 250 * 1024 * 1024;
export const S3_UPLOAD_PREFIX = "files/";

export const ALLOWED_UPLOAD_EXTENSIONS = [
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "jpg",
  "jpeg",
  "png",
  "webp",
  "txt",
  "zip",
] as const;

const ALLOWED_EXTENSION_SET = new Set<string>(ALLOWED_UPLOAD_EXTENSIONS);
const MAX_BASE_FILENAME_LENGTH = 100;
const FALLBACK_BASE_FILENAME = "file";

export const ACCEPTED_UPLOAD_EXTENSIONS = ALLOWED_UPLOAD_EXTENSIONS.map(
  (extension) => `.${extension}`,
).join(",");

export type UploadFileDescriptor = {
  id?: string;
  name: string;
  size: number;
  type?: string;
};

export function sanitizeFilename(originalName: string): string {
  const filename = getFinalPathSegment(originalName).trim();
  const extension = getUploadExtension(filename);
  const extensionStart = extension ? filename.lastIndexOf(".") : -1;
  const rawBase =
    extensionStart > 0 ? filename.slice(0, extensionStart) : filename;
  const cleanedBase = sanitizeFilenameBase(rawBase);

  return extension ? `${cleanedBase}.${extension}` : cleanedBase;
}

export function getUploadExtension(filename: string): string {
  const basename = getFinalPathSegment(filename).trim();
  const extensionStart = basename.lastIndexOf(".");

  if (extensionStart <= 0 || extensionStart === basename.length - 1) {
    return "";
  }

  return basename.slice(extensionStart + 1).toLowerCase();
}

export function isAllowedUploadExtension(extension: string): boolean {
  return ALLOWED_EXTENSION_SET.has(extension.toLowerCase());
}

export function isAllowedUploadSize(size: number): boolean {
  return Number.isSafeInteger(size) && size >= 0 && size <= MAX_FILE_SIZE_BYTES;
}

function sanitizeFilenameBase(base: string): string {
  const cleaned = base
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "")
    .replace(/_/g, "-")
    .toLowerCase()
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_BASE_FILENAME_LENGTH)
    .replace(/^-+|-+$/g, "");

  return cleaned || FALLBACK_BASE_FILENAME;
}

function getFinalPathSegment(filename: string): string {
  return filename.split(/[/\\]+/).pop() ?? "";
}
