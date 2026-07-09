import { getServerSession } from "next-auth/next";
import type { ReactNode } from "react";

import { SignInButton, SignOutButton } from "@/app/auth-buttons";
import { UploadForm } from "@/app/upload-form";
import { authOptions } from "@/lib/auth";
import { ALLOWED_UPLOAD_EXTENSIONS, MAX_FILE_SIZE_BYTES } from "@/lib/filename";
import { isAllowedUploadEmail } from "@/lib/upload-auth";

export const dynamic = "force-dynamic";

const MAX_FILE_SIZE_LABEL = `${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB`;
const AUTH_BUTTON_CLASS =
  "inline-flex min-h-11 items-center justify-center rounded-md bg-neutral-950 px-5 text-sm font-semibold text-white transition hover:bg-neutral-800";
const SECONDARY_BUTTON_CLASS =
  "inline-flex min-h-10 items-center justify-center rounded-md border border-neutral-300 px-4 text-sm font-semibold text-neutral-800 transition hover:border-emerald-600 hover:text-emerald-700";

export default async function Home() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email ?? null;
  const isSignedIn = Boolean(session?.user);
  const isAuthorized = isAllowedUploadEmail(email);

  return (
    <main className="min-h-full bg-[#f8faf8] text-neutral-950">
      <section className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-5 py-8 sm:px-8 lg:py-12">
        <header className="flex flex-col gap-4 border-b border-neutral-200 pb-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex flex-col gap-3">
              <p className="text-sm font-semibold uppercase text-emerald-700">
                Suncatcher Hill
              </p>
              <div className="flex flex-col gap-2">
                <h1 className="max-w-2xl text-3xl font-semibold text-neutral-950 sm:text-4xl">
                  File upload portal
                </h1>
                <p className="text-sm text-neutral-600">
                  {ALLOWED_UPLOAD_EXTENSIONS.join(", ")} up to {MAX_FILE_SIZE_LABEL}
                </p>
              </div>
            </div>

            {isSignedIn && isAuthorized ? (
              <div className="flex flex-col gap-2 sm:items-end">
                {email ? (
                  <p className="break-all text-sm text-neutral-600">{email}</p>
                ) : null}
                <SignOutButton className={SECONDARY_BUTTON_CLASS}>Sign out</SignOutButton>
              </div>
            ) : null}
          </div>
        </header>

        {!isSignedIn ? (
          <AuthMessage
            title="Sign in required"
            body="Use your Suncatcher Hill account to access the upload portal."
          >
            <SignInButton className={AUTH_BUTTON_CLASS}>Sign in with Cognito</SignInButton>
          </AuthMessage>
        ) : !isAuthorized ? (
          <AuthMessage
            title="Not authorized"
            body={
              email
                ? `${email} is not on the upload allowlist.`
                : "This signed-in account is not on the upload allowlist."
            }
          >
            <SignOutButton className={SECONDARY_BUTTON_CLASS}>Sign out</SignOutButton>
          </AuthMessage>
        ) : (
          <UploadForm cloudFrontBaseUrl={getCloudFrontBaseUrl()} />
        )}
      </section>
    </main>
  );
}

function getCloudFrontBaseUrl(): string {
  return process.env.CLOUDFRONT_BASE_URL?.replace(/\/+$/, "") ?? "";
}

function AuthMessage({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-4 rounded-lg border border-neutral-200 bg-white p-5 shadow-sm">
      <div className="grid gap-2">
        <h2 className="text-xl font-semibold text-neutral-950">{title}</h2>
        <p className="text-sm text-neutral-600">{body}</p>
      </div>
      <div>{children}</div>
    </section>
  );
}
