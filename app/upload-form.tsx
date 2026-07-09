"use client";

import { useRef, useState } from "react";

import {
  ACCEPTED_UPLOAD_EXTENSIONS,
  MAX_FILE_SIZE_BYTES,
  S3_UPLOAD_PREFIX,
  getUploadExtension,
  isAllowedUploadExtension,
  isAllowedUploadSize,
  sanitizeFilename,
} from "@/lib/filename";

type UploadStatus =
  | "ready"
  | "checking"
  | "prepared"
  | "uploading"
  | "uploaded"
  | "error";

type UploadRow = {
  id: string;
  file: File;
  originalName: string;
  safeName: string;
  status: UploadStatus;
  message: string;
  key?: string;
  publicUrl?: string;
  uploadUrl?: string;
  contentType?: string;
  exists?: boolean;
  existingSize?: number;
  existingLastModified?: string;
};

type PreparedUpload = {
  id?: string;
  originalName: string;
  safeName: string;
  cleanedName?: string;
  key: string;
  publicUrl: string;
  cloudFrontUrl?: string;
  uploadUrl: string;
  contentType: string;
  exists: boolean;
  existingSize?: number;
  existingLastModified?: string;
};

type CreateUploadUrlsResponse = {
  uploads?: PreparedUpload[];
  error?: string;
  details?: string[];
};

type UploadResult =
  | {
      id: string;
      ok: true;
    }
  | {
      id: string;
      ok: false;
      message: string;
    };

const MAX_FILE_SIZE_LABEL = `${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB`;
const REPLACEMENT_WARNING =
  "One or more files will replace existing files. Previous versions are recoverable in S3.";

type UploadFormProps = {
  cloudFrontBaseUrl: string;
};

export function UploadForm({ cloudFrontBaseUrl }: UploadFormProps) {
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [isPreparing, setIsPreparing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Select files to begin.");
  const [copyMessages, setCopyMessages] = useState<Record<string, string>>({});
  const prepareRequestIdRef = useRef(0);
  const activePrepareAbortControllerRef = useRef<AbortController | null>(null);

  const hasReplacementWarning = rows.some((row) => row.exists === true);
  const rowsReadyForUpload = rows.filter(isRowReadyForUpload);

  function handleFileSelection(files: FileList | null) {
    activePrepareAbortControllerRef.current?.abort();
    const prepareRequestId = prepareRequestIdRef.current + 1;
    prepareRequestIdRef.current = prepareRequestId;

    const nextRows = Array.from(files ?? []).map((file, index) => {
      const validationError = getClientValidationError(file);
      const safeName = sanitizeFilename(file.name);

      return {
        id: `${file.name}-${file.size}-${file.lastModified}-${index}`,
        file,
        originalName: file.name,
        safeName,
        status: validationError ? "error" : "checking",
        message: validationError ?? "Checking files...",
        publicUrl: validationError
          ? undefined
          : getPublicUrl(cloudFrontBaseUrl, safeName),
      } satisfies UploadRow;
    });

    setRows(nextRows);
    setCopyMessages({});

    if (nextRows.length === 0) {
      activePrepareAbortControllerRef.current = null;
      setIsPreparing(false);
      setStatusMessage("Select files to begin.");
      return;
    }

    const validRows = nextRows.filter((row) => row.status !== "error");

    if (validRows.length === 0) {
      activePrepareAbortControllerRef.current = null;
      setIsPreparing(false);
      setStatusMessage("No selected files can be prepared.");
      return;
    }

    setIsPreparing(true);
    setStatusMessage("Checking files...");
    void prepareUploadRows(validRows, prepareRequestId);
  }

  async function prepareUploadRows(validRows: UploadRow[], prepareRequestId: number) {
    const abortController = new AbortController();
    activePrepareAbortControllerRef.current = abortController;

    try {
      const presignResponse = await fetch("/api/create-upload-urls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          files: validRows.map((row) => ({
            id: row.id,
            name: row.file.name,
            size: row.file.size,
            type: row.file.type,
          })),
        }),
      });
      const presignPayload = (await presignResponse.json()) as CreateUploadUrlsResponse;

      if (prepareRequestIdRef.current !== prepareRequestId) {
        return;
      }

      if (!presignResponse.ok || !presignPayload.uploads) {
        throw new Error(formatApiError(presignPayload));
      }

      const uploadsById = new Map(
        presignPayload.uploads.map((upload) => [upload.id, upload]),
      );

      setRows((currentRows) =>
        currentRows.map((row) => {
          const upload = uploadsById.get(row.id);

          return upload
            ? applyPreparedUpload(row, upload)
            : row;
        }),
      );
      setStatusMessage(
        presignPayload.uploads.some((upload) => upload.exists)
          ? `Review complete. ${REPLACEMENT_WARNING}`
          : "Review complete. Ready to upload.",
      );
    } catch (error) {
      if (
        prepareRequestIdRef.current !== prepareRequestId ||
        abortController.signal.aborted
      ) {
        return;
      }

      const message = error instanceof Error ? error.message : "Could not prepare files.";

      setRows((currentRows) =>
        currentRows.map((row) =>
          validRows.some((validRow) => validRow.id === row.id)
            ? { ...row, status: "error", message }
            : row,
        ),
      );
      setStatusMessage(message);
    } finally {
      if (prepareRequestIdRef.current === prepareRequestId) {
        setIsPreparing(false);
        activePrepareAbortControllerRef.current = null;
      }
    }
  }

  async function handleUpload() {
    if (isPreparing || isUploading) {
      return;
    }

    if (rows.length === 0) {
      setStatusMessage("Select at least one file.");
      return;
    }

    const refreshedRows = rows.map((row) => {
      const validationError = getClientValidationError(row.file);

      return {
        ...row,
        status: validationError ? "error" : row.status,
        message: validationError ?? row.message,
      } satisfies UploadRow;
    });
    const rowsMissingPreparation = refreshedRows.filter(
      (row) => getClientValidationError(row.file) === null && !isRowReadyForUpload(row),
    );
    const uploadRows = refreshedRows.filter(isRowReadyForUpload);

    setRows(refreshedRows);

    if (rowsMissingPreparation.length > 0 || uploadRows.length === 0) {
      setStatusMessage("Files must finish checking before upload.");
      return;
    }

    setIsUploading(true);
    setStatusMessage("Uploading files to S3.");
    setCopyMessages({});

    setRows((currentRows) =>
      currentRows.map((row) =>
        uploadRows.some((uploadRow) => uploadRow.id === row.id)
          ? { ...row, status: "uploading", message: "Uploading to S3" }
          : row,
      ),
    );

    try {
      const results: UploadResult[] = await Promise.all(
        uploadRows.map(async (row): Promise<UploadResult> => {
          try {
            const uploadResponse = await fetch(row.uploadUrl ?? "", {
              method: "PUT",
              headers: { "Content-Type": row.contentType ?? "application/octet-stream" },
              body: row.file,
            });

            if (!uploadResponse.ok) {
              throw new Error(`S3 returned ${uploadResponse.status}.`);
            }

            return {
              id: row.id,
              ok: true,
            };
          } catch (error) {
            return {
              id: row.id,
              ok: false,
              message: error instanceof Error ? error.message : "Upload failed.",
            };
          }
        }),
      );

      const successCount = results.filter((result) => result.ok).length;

      setRows((currentRows) =>
        currentRows.map((row) => {
          const result = results.find((uploadResult) => uploadResult.id === row.id);

          if (!result) {
            return row;
          }

          if (!result.ok) {
            return {
              ...row,
              status: "error",
              message: result.message,
            };
          }

          return {
            ...row,
            status: "uploaded",
            message: "Uploaded",
          };
        }),
      );
      setStatusMessage(
        successCount === uploadRows.length
          ? "Upload complete."
          : `Uploaded ${successCount} of ${uploadRows.length} files.`,
      );
    } finally {
      setIsUploading(false);
    }
  }

  async function copyUrl(id: string, url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopyMessages((current) => ({ ...current, [id]: "Copied" }));
    } catch {
      setCopyMessages((current) => ({ ...current, [id]: "Copy failed" }));
    }
  }

  return (
    <>
      <section className="grid gap-5 rounded-lg border border-neutral-200 bg-white p-5 shadow-sm">
        <label className="grid cursor-pointer gap-3 rounded-md border border-dashed border-emerald-300 bg-emerald-50/60 px-5 py-8 text-center transition hover:border-emerald-500 hover:bg-emerald-50">
          <span className="text-base font-medium text-neutral-950">
            Select files
          </span>
          <input
            className="mx-auto block w-full max-w-lg text-sm text-neutral-700 file:mr-4 file:rounded-md file:border-0 file:bg-emerald-700 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-emerald-800"
            type="file"
            multiple
            accept={ACCEPTED_UPLOAD_EXTENSIONS}
            onChange={(event) => handleFileSelection(event.target.files)}
          />
        </label>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm font-medium text-neutral-700" role="status">
            {statusMessage}
          </p>
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-md bg-neutral-950 px-5 text-sm font-semibold text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-300 disabled:text-neutral-600"
            type="button"
            disabled={isPreparing || isUploading || rowsReadyForUpload.length === 0}
            onClick={handleUpload}
          >
            {isPreparing ? "Checking" : isUploading ? "Uploading" : "Upload"}
          </button>
        </div>
      </section>

      {hasReplacementWarning ? (
        <p
          className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900"
          role="alert"
        >
          {REPLACEMENT_WARNING}
        </p>
      ) : null}

      {rows.length > 0 ? (
        <section className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm">
          <div className="grid grid-cols-1 border-b border-neutral-200 bg-neutral-50 px-4 py-3 text-xs font-semibold uppercase text-neutral-500 md:grid-cols-[1fr_1fr_1.2fr_180px]">
            <span>Original filename</span>
            <span className="hidden md:block">Final cleaned filename</span>
            <span className="hidden md:block">Destination URL</span>
            <span className="hidden md:block">Status</span>
          </div>

          <ul className="divide-y divide-neutral-200">
            {rows.map((row) => {
              const existingObjectDetails = getExistingObjectDetails(row);

              return (
                <li
                  key={row.id}
                  className="grid grid-cols-1 gap-3 px-4 py-4 md:grid-cols-[1fr_1fr_1.2fr_180px] md:items-center"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-neutral-950">
                      {row.originalName}
                    </p>
                  </div>

                  <div className="min-w-0">
                    <p className="break-all text-sm font-medium text-neutral-950">
                      {row.safeName}
                    </p>
                  </div>

                  <div className="min-w-0">
                    {row.publicUrl ? (
                      <div className="flex flex-col gap-2">
                        <a
                          className="break-all text-sm font-medium text-emerald-700 underline decoration-emerald-200 underline-offset-4 hover:text-emerald-900"
                          href={row.publicUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {row.publicUrl}
                        </a>
                        <button
                          className="w-fit rounded-md border border-neutral-300 px-3 py-2 text-xs font-semibold text-neutral-800 transition hover:border-emerald-600 hover:text-emerald-700"
                          type="button"
                          onClick={() => copyUrl(row.id, row.publicUrl ?? "")}
                        >
                          {copyMessages[row.id] ?? "Copy URL"}
                        </button>
                      </div>
                    ) : (
                      <span className="text-sm text-neutral-500">Unavailable</span>
                    )}
                  </div>

                  <div className="flex flex-col items-start gap-1">
                    <span
                      className={`inline-flex min-h-8 items-center rounded-md px-3 text-xs font-semibold ${getExistenceClassName(
                        row.exists,
                        row.status,
                      )}`}
                    >
                      {getExistenceLabel(row)}
                    </span>
                    {existingObjectDetails ? (
                      <span className="text-xs text-neutral-500">
                        {existingObjectDetails}
                      </span>
                    ) : null}
                    <span className="text-xs text-neutral-500">{row.message}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function applyPreparedUpload(row: UploadRow, upload: PreparedUpload): UploadRow {
  const safeName = upload.safeName ?? upload.cleanedName ?? row.safeName;
  const publicUrl = upload.publicUrl ?? upload.cloudFrontUrl;

  return {
    ...row,
    safeName,
    key: upload.key,
    publicUrl,
    uploadUrl: upload.uploadUrl,
    contentType: upload.contentType,
    exists: upload.exists,
    existingSize: upload.existingSize,
    existingLastModified: upload.existingLastModified,
    status: "prepared",
    message: "Ready to upload",
  };
}

function isRowReadyForUpload(row: UploadRow): boolean {
  return (
    getClientValidationError(row.file) === null &&
    row.status !== "uploaded" &&
    Boolean(row.uploadUrl && row.contentType)
  );
}

function getClientValidationError(file: File): string | null {
  const extension = getUploadExtension(file.name);

  if (!extension || !isAllowedUploadExtension(extension)) {
    return "Unsupported file type";
  }

  if (!isAllowedUploadSize(file.size)) {
    return `File must be ${MAX_FILE_SIZE_LABEL} or smaller`;
  }

  return null;
}

function getPublicUrl(baseUrl: string, safeName: string): string | undefined {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");

  return normalizedBaseUrl
    ? `${normalizedBaseUrl}/${S3_UPLOAD_PREFIX}${safeName}`
    : undefined;
}

function formatApiError(payload: CreateUploadUrlsResponse): string {
  if (payload.details?.length) {
    return payload.details.join(" ");
  }

  return payload.error ?? "Could not create upload URLs.";
}

function getExistenceLabel(row: UploadRow): string {
  if (row.status === "error") {
    return "Error";
  }

  if (row.status === "checking") {
    return "Checking files";
  }

  if (row.exists === true) {
    return row.status === "uploaded"
      ? "Replaced existing file"
      : "Will replace existing file";
  }

  if (row.exists === false) {
    return "New file";
  }

  return "Needs check";
}

function getExistenceClassName(
  exists: boolean | undefined,
  status: UploadStatus,
): string {
  if (status === "error") {
    return "bg-red-100 text-red-800";
  }

  if (exists === true) {
    return "bg-amber-100 text-amber-900";
  }

  if (exists === false) {
    return "bg-emerald-100 text-emerald-800";
  }

  if (status === "checking" || status === "uploading") {
    return "bg-sky-100 text-sky-800";
  }

  return "bg-neutral-100 text-neutral-700";
}

function getExistingObjectDetails(row: UploadRow): string | null {
  if (!row.exists) {
    return null;
  }

  const details = [
    typeof row.existingSize === "number" ? formatFileSize(row.existingSize) : null,
    row.existingLastModified
      ? `Last modified ${formatLastModified(row.existingLastModified)}`
      : null,
  ].filter(Boolean);

  return details.length > 0 ? details.join(" | ") : null;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatLastModified(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
