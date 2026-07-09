import { ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getServerSession } from "next-auth/next";

import {
  ALLOWED_UPLOAD_EXTENSIONS,
  S3_UPLOAD_PREFIX,
  type UploadFileDescriptor,
  getUploadExtension,
  isAllowedUploadExtension,
  isAllowedUploadSize,
  sanitizeFilename,
} from "@/lib/filename";
import { authOptions } from "@/lib/auth";
import { isAllowedUploadEmail } from "@/lib/upload-auth";

export const runtime = "nodejs";

const PRESIGNED_URL_EXPIRES_IN_SECONDS = 10 * 60;

type UploadRequestBody = {
  files?: unknown;
};

type ValidatedUploadFile = Required<Pick<UploadFileDescriptor, "name" | "size">> &
  Pick<UploadFileDescriptor, "id" | "type"> & {
    cleanedName: string;
    key: string;
    contentType: string;
  };

type ExistingObjectMetadata = {
  exists: boolean;
  existingSize?: number;
  existingLastModified?: string;
};

const s3Client = new S3Client({
  region: process.env.APP_AWS_REGION,
});

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    return Response.json(
      { error: "Sign in is required to upload files." },
      { status: 401 },
    );
  }

  if (!isAllowedUploadEmail(session.user.email)) {
    return Response.json(
      { error: "This account is not authorized to upload files." },
      { status: 403 },
    );
  }

  const config = getUploadConfig();

  if (!config.ok) {
    return Response.json({ error: config.error }, { status: 500 });
  }

  let body: UploadRequestBody;

  try {
    body = (await request.json()) as UploadRequestBody;
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  if (!Array.isArray(body.files)) {
    return Response.json({ error: "Request must include a files array." }, { status: 400 });
  }

  if (body.files.length === 0) {
    return Response.json({ error: "Select at least one file to upload." }, { status: 400 });
  }

  const validatedFiles = body.files.map(validateUploadFile);
  const validationErrors = validatedFiles
    .filter((result) => !result.ok)
    .map((result) => result.error);

  if (validationErrors.length > 0) {
    return Response.json(
      {
        error: "One or more files cannot be uploaded.",
        details: validationErrors,
      },
      { status: 400 },
    );
  }

  const files = validatedFiles.map((result) => {
    if (!result.ok) {
      throw new Error("Unexpected upload validation failure.");
    }

    return result.file;
  });

  const uploads = await Promise.all(
    files.map(async (file) => {
      const [existingObject, uploadUrl] = await Promise.all([
        getExistingObjectMetadata(config.bucketName, file.key),
        getSignedUrl(
          s3Client,
          new PutObjectCommand({
            Bucket: config.bucketName,
            Key: file.key,
            ContentType: file.contentType,
          }),
          { expiresIn: PRESIGNED_URL_EXPIRES_IN_SECONDS },
        ),
      ]);

      const publicUrl = `${config.cloudFrontBaseUrl}/${file.key}`;

      return {
        id: file.id,
        originalName: file.name,
        safeName: file.cleanedName,
        cleanedName: file.cleanedName,
        key: file.key,
        publicUrl,
        uploadUrl,
        cloudFrontUrl: publicUrl,
        contentType: file.contentType,
        ...existingObject,
      };
    }),
  );

  return Response.json({ uploads });
}

function validateUploadFile(
  value: unknown,
  index: number,
):
  | { ok: true; file: ValidatedUploadFile }
  | { ok: false; error: string } {
  if (!isRecord(value)) {
    return { ok: false, error: `File ${index + 1} is invalid.` };
  }

  const id = typeof value.id === "string" ? value.id : undefined;
  const name = typeof value.name === "string" ? value.name : "";
  const type = getSafeContentType(value.type);
  const size = typeof value.size === "number" ? value.size : Number.NaN;
  const label = name || `File ${index + 1}`;

  if (!name.trim()) {
    return { ok: false, error: `${label} is missing a filename.` };
  }

  if (!isAllowedUploadSize(size)) {
    return { ok: false, error: `${label} must be 250 MB or smaller.` };
  }

  const extension = getUploadExtension(name);

  if (!extension || !isAllowedUploadExtension(extension)) {
    return {
      ok: false,
      error: `${label} must be one of: ${ALLOWED_UPLOAD_EXTENSIONS.join(", ")}.`,
    };
  }

  const cleanedName = sanitizeFilename(name);
  const key = `${S3_UPLOAD_PREFIX}${cleanedName}`;

  if (!key.startsWith(S3_UPLOAD_PREFIX) || key.includes("/../")) {
    return { ok: false, error: `${label} cannot be written outside files/.` };
  }

  return {
    ok: true,
    file: {
      id,
      name,
      size,
      type,
      cleanedName,
      key,
      contentType: type || "application/octet-stream",
    },
  };
}

function getUploadConfig():
  | {
      ok: true;
      bucketName: string;
      cloudFrontBaseUrl: string;
    }
  | { ok: false; error: string } {
  const region = process.env.APP_AWS_REGION;
  const bucketName = process.env.S3_BUCKET_NAME;
  const cloudFrontBaseUrl = process.env.CLOUDFRONT_BASE_URL?.replace(/\/+$/, "");

  if (!region || !bucketName || !cloudFrontBaseUrl) {
    return {
      ok: false,
      error:
        "Missing APP_AWS_REGION, S3_BUCKET_NAME, or CLOUDFRONT_BASE_URL environment variable.",
    };
  }

  return { ok: true, bucketName, cloudFrontBaseUrl };
}

function getSafeContentType(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  const contentType = value.trim();

  if (!contentType || contentType.length > 200 || /[^\x20-\x7e]/.test(contentType)) {
    return "";
  }

  return contentType;
}

async function getExistingObjectMetadata(
  bucketName: string,
  key: string,
): Promise<ExistingObjectMetadata> {
  const listedObjects = await s3Client.send(
    new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: key,
      MaxKeys: 1,
    }),
  );
  const existingObject = listedObjects.Contents?.find((object) => object.Key === key);

  if (!existingObject) {
    return { exists: false };
  }

  return {
    exists: true,
    ...(typeof existingObject.Size === "number"
      ? { existingSize: existingObject.Size }
      : {}),
    ...(existingObject.LastModified
      ? { existingLastModified: existingObject.LastModified.toISOString() }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
