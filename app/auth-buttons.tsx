"use client";

import { signIn, signOut } from "next-auth/react";
import type { ReactNode } from "react";

type AuthButtonProps = {
  children: ReactNode;
  className?: string;
};

export function SignInButton({ children, className }: AuthButtonProps) {
  return (
    <button
      className={className}
      type="button"
      onClick={() => {
        void signIn("cognito");
      }}
    >
      {children}
    </button>
  );
}

export function SignOutButton({ children, className }: AuthButtonProps) {
  return (
    <button
      className={className}
      type="button"
      onClick={() => {
        void signOut();
      }}
    >
      {children}
    </button>
  );
}
