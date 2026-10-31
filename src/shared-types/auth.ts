import { z } from 'zod';

export const RegisterBodySchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8),
    confirmPassword: z.string(),
    displayName: z.string().min(1).max(32).optional(),
  })
  .strict()
  .refine((d) => d.password === d.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

export const LoginBodySchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1),
  })
  .strict();

export const UpdateProfileBodySchema = z
  .object({
    displayName: z.string().min(1).max(32),
  })
  .strict();

export const AuthUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  /** PR 3a — the account's canonical in-game playerId (owner of its ships /
   *  structures). `null` until the account's first logged-in join binds one
   *  (that join adopts the browser's current id). Optional for back-compat. */
  playerId: z.string().nullable().optional(),
});

export const AuthResponseSchema = z.object({
  token: z.string(),
  user: AuthUserSchema,
});

export type AuthUser = z.infer<typeof AuthUserSchema>;
export type AuthResponse = z.infer<typeof AuthResponseSchema>;
