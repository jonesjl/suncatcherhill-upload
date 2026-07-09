"use client";

import { type FormEvent, useState } from "react";

import {
  ACCEPTED_UPLOAD_EXTENSIONS,
  MAX_FILE_SIZE_BYTES,
  getUploadExtension,
  isAllowedUploadExtension,
  isAllowedUploadSize,
  sanitizeFilename,
} from "@/lib/filename";

type UploadStatus = "ready" | "signing" | "uploading" | "uploaded" | "error";

type UploadRow = {
  id: string;
  file: File;
  originalName: string;
  cleanedName: string;
  status: UploadStatus;
  message: string;
  cloudFrontUrl?: string;
};

type CreateUploadUrlsResponse = {
  uploads?: Array<{
    id?: string;
    originalName: string;
    cleanedName: string;
    uploadUrl: string;
    cloudFrontUrl: string;
    contentType: string;
  }>;
  error?: string;
  details?: string[];
};

type UploadResult =
  | {
      id: string;
      ok: true;
      cleanedName: string;
      cloudFrontUrl: string;
    }
  | {
      id: string;
      ok: false;
      message: string;
    };

const MAX_FILE_SIZE_LABEL = `${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB`;

export function UploadForm() {
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Select files to begin.");
  const [copyMessages, setCopyMessages] = useState<Record<string, string>>({});

  function handleFileSelection(files: FileList | null) {
    const nextRows = Array.from(files ?? []).map((file, index) => {
      const validationError = getClientValidationError(file);

      return {
        id: `${file.name}-${file.size}-${file.lastModified}-${index}`,
        file,
        originalName: file.name,
        cleanedName: sanitizeFilename(file.name),
        status: validationError ? "error" : "ready",
        message: validationError ?? "Ready",
      } satisfies UploadRow;
    });

    setRows(nextRows);
    setCopyMessages({});
    setStatusMessage(
      nextRows.length === 0
        ? "Select files to begin."
        : `${nextRows.length} file${nextRows.length === 1 ? "" : "s"} selected.`,
    );
  }

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isUploading) {
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
        status: validationError ? "error" : row.status === "uploaded" ? "ready" : row.status,
        message: validationError ?? "Ready",
        cloudFrontUrl: validationError ? undefined : row.cloudFrontUrl,
      } satisfies UploadRow;
    });
    const validRows = refreshedRows.filter((row) => row.status !== "error");

    setRows(
      refreshedRows.map((row) =>
        row.status === "error"
          ? row
          : {
              ...row,
              status: "signing",
              message: "Creating upload URL",
              cloudFrontUrl: undefined,
            },
      ),
    );

    if (validRows.length === 0) {
      setStatusMessage("No selected files can be uploaded.");
      return;
    }

    setIsUploading(true);
    setStatusMessage("Creating upload URLs.");
    setCopyMessages({});

    try {
      const presignResponse = await fetch("/api/create-upload-urls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
            ? {
                ...row,
                cleanedName: upload.cleanedName,
                cloudFrontUrl: undefined,
                status: "uploading",
                message: "Uploading to S3",
              }
            : row;
        }),
      );
      setStatusMessage("Uploading files to S3.");

      const results: UploadResult[] = await Promise.all(
        validRows.map(async (row): Promise<UploadResult> => {
          const upload = uploadsById.get(row.id);

          if (!upload) {
            return {
              id: row.id,
              ok: false,
              message: "Missing upload URL.",
            };
          }

          try {
            const uploadResponse = await fetch(upload.uploadUrl, {
              method: "PUT",
              headers: { "Content-Type": upload.contentType },
              body: row.file,
            });

            if (!uploadResponse.ok) {
              throw new Error(`S3 returned ${uploadResponse.status}.`);
            }

            return {
              id: row.id,
              ok: true,
              cleanedName: upload.cleanedName,
              cloudFrontUrl: upload.cloudFrontUrl,
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
              cloudFrontUrl: undefined,
            };
          }

          return {
            ...row,
            cleanedName: result.cleanedName,
            cloudFrontUrl: result.cloudFrontUrl,
            status: "uploaded",
            message: "Uploaded",
          };
        }),
      );
      setStatusMessage(
        successCount === validRows.length
          ? "Upload complete."
          : `Uploaded ${successCount} of ${validRows.length} files.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed.";

      setRows((currentRows) =>
        currentRows.map((row) =>
          validRows.some((validRow) => validRow.id === row.id)
            ? { ...row, status: "error", message, cloudFrontUrl: undefined }
            : row,
        ),
      );
      setStatusMessage(message);
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
      <form
        onSubmit={handleUpload}
        className="grid gap-5 rounded-lg border border-neutral-200 bg-white p-5 shadow-sm"
      >
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
            type="submit"
            disabled={isUploading || rows.length === 0}
          >
            {isUploading ? "Uploading" : "Upload"}
          </button>
        </div>
      </form>

      {rows.length > 0 ? (
        <section className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm">
          <div className="grid grid-cols-1 border-b border-neutral-200 bg-neutral-50 px-4 py-3 text-xs font-semibold uppercase text-neutral-500 md:grid-cols-[1fr_1fr_140px]">
            <span>Original filename</span>
            <span className="hidden md:block">Cleaned CloudFront URL</span>
            <span className="hidden md:block">Status</span>
          </div>

          <ul className="divide-y divide-neutral-200">
            {rows.map((row) => (
              <li
                key={row.id}
                className="grid grid-cols-1 gap-3 px-4 py-4 md:grid-cols-[1fr_1fr_140px] md:items-center"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-neutral-950">
                    {row.originalName}
                  </p>
                  <p className="truncate text-xs text-neutral-500">
                    {row.cleanedName}
                  </p>
                </div>

                <div className="min-w-0">
                  {row.cloudFrontUrl ? (
                    <div className="flex flex-col gap-2">
                      <a
                        className="break-all text-sm font-medium text-emerald-700 underline decoration-emerald-200 underline-offset-4 hover:text-emerald-900"
                        href={row.cloudFrontUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {row.cloudFrontUrl}
                      </a>
                      <button
                        className="w-fit rounded-md border border-neutral-300 px-3 py-2 text-xs font-semibold text-neutral-800 transition hover:border-emerald-600 hover:text-emerald-700"
                        type="button"
                        onClick={() => copyUrl(row.id, row.cloudFrontUrl ?? "")}
                      >
                        {copyMessages[row.id] ?? "Copy URL"}
                      </button>
                    </div>
                  ) : (
                    <span className="text-sm text-neutral-500">Pending</span>
                  )}
                </div>

                <div>
                  <span
                    className={`inline-flex min-h-8 items-center rounded-md px-3 text-xs font-semibold ${getStatusClassName(
                      row.status,
                    )}`}
                  >
                    {row.message}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
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

function formatApiError(payload: CreateUploadUrlsResponse): string {
  if (payload.details?.length) {
    return payload.details.join(" ");
  }

  return payload.error ?? "Could not create upload URLs.";
}

function getStatusClassName(status: UploadStatus): string {
  switch (status) {
    case "uploaded":
      return "bg-emerald-100 text-emerald-800";
    case "error":
      return "bg-red-100 text-red-800";
    case "signing":
    case "uploading":
      return "bg-sky-100 text-sky-800";
    case "ready":
    default:
      return "bg-neutral-100 text-neutral-700";
  }
}
