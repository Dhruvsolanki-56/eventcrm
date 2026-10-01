import { z } from 'zod';
import { safeWebsiteHref } from './website.js';
export { safeWebsiteHref } from './website.js';

export const RoleSchema = z.enum(['admin', 'manager', 'representative', 'attendee']);
export const WorkspaceKindSchema = z.enum(['company', 'personal']);

export const WebsiteSchema = z.string().trim().max(300).refine((value) => !value || safeWebsiteHref(value) !== null, 'Enter a website using http or https.');

export const DemoAccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.email(),
  role: RoleSchema,
  workspaceId: z.string(),
  workspaceName: z.string(),
  workspaceKind: WorkspaceKindSchema,
});

export const SessionSchema = z.object({
  user: z.object({ id: z.string(), name: z.string(), email: z.email() }),
  workspace: z.object({ id: z.string(), name: z.string(), kind: WorkspaceKindSchema, role: RoleSchema }),
  availableWorkspaces: z.array(z.object({ id: z.string(), name: z.string(), kind: WorkspaceKindSchema, role: RoleSchema })),
  csrfToken: z.string(),
  demoMode: z.boolean(),
});

export const LoginSchema = z.object({ email: z.email(), password: z.string().min(1).max(200) });
export const PasswordResetRequestSchema = z.object({ email: z.email() });
export const PasswordResetConfirmSchema = z.object({ token: z.string().min(40).max(100), password: z.string().min(12).max(200) });
export const OneTimeTokenSchema = z.object({ token: z.string().min(40).max(100) });
export const SignupSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.email(),
  password: z.string().min(12).max(200),
  workspaceKind: WorkspaceKindSchema,
  workspaceName: z.string().trim().min(1).max(120).optional(),
  inviteToken: z.string().min(40).max(100).optional(),
}).superRefine((value, ctx) => {
  if (!value.inviteToken && value.workspaceKind === 'company' && !value.workspaceName) {
    ctx.addIssue({ code: 'custom', path: ['workspaceName'], message: 'Enter your company name.' });
  }
});

export const CardReadOutputSchema = z.object({
  name: z.string().max(160).default(''),
  title: z.string().max(160).default(''),
  company: z.string().max(200).default(''),
  email: z.email().or(z.literal('')).default(''),
  phone: z.string().max(60).default(''),
  website: WebsiteSchema.default(''),
  products: z.array(z.string().max(120)).max(12).default([]),
  topics: z.array(z.string().max(120)).max(12).default([]),
  uncertain: z.array(z.enum(['name', 'title', 'company', 'email', 'phone', 'website'])).max(6).default([]),
});

export const SaveLeadSchema = z.object({
  name: z.string().trim().max(160),
  title: z.string().trim().max(160).default(''),
  company: z.string().trim().max(200).default(''),
  email: z.string().trim().max(254).default(''),
  phone: z.string().trim().max(60).default(''),
  website: WebsiteSchema.default(''),
  quality: z.enum(['hot','warm','cold']).nullable().default(null),
  note: z.string().trim().max(4000).default(''),
  followUpDate: z.iso.date().nullable().default(null),
  productIds: z.array(z.string().min(1).max(80)).max(12).default([]),
  companyChoice: z.string().max(80).optional(),
  samePersonContactId: z.string().max(80).optional(),
  differentPerson: z.boolean().optional(),
}).strict();

export type Role = z.infer<typeof RoleSchema>;
export type WorkspaceKind = z.infer<typeof WorkspaceKindSchema>;
export type SessionData = z.infer<typeof SessionSchema>;
export type DemoAccount = z.infer<typeof DemoAccountSchema>;
export type CardReadOutput = z.infer<typeof CardReadOutputSchema>;

export const statusWords = {
  scan: { uploading: 'Uploading…', queued: 'Reading…', reading: 'Reading…', ready: 'Ready to review', saved: 'Saved', failed: "Couldn't read (type it in)", discarded: 'Removed' },
  email: { draft: 'Draft', queued: 'Queued for the mail server; delivery is not confirmed.', sent: 'Accepted by the mail server; delivery is not confirmed.', failed: 'The mail server did not accept the message.', outbox: 'Saved, not sent.' },
  job: { queued: 'Waiting', running: 'Working', succeeded: 'Done', failed: 'Needs attention' },
} as const;
