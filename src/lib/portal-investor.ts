// Read-only access to the portal's full investor profile (public.* tables) via
// raw SQL — the profile data the agent's read-only "view" screen needs. Kept
// out of the Prisma model graph (datasource is xsystem-only), like portal-data.ts.
// All reads; callers must first gate the investor code by agent scope.

import { prisma } from "@/lib/prisma";

export interface PortalInvestorProfile {
  id: string;
  investorCode: string;
  name: string;
  title: string | null;
  investorType: string;
  nidNumber: string | null;
  tinNumber: string | null;
  dateOfBirth: Date | null;
  address: string | null;
  boId: string | null;
  dpId: string | null;
  brokerageHouse: string | null;
  fatherName: string | null;
  motherName: string | null;
  spouseName: string | null;
  jointApplicantName: string | null;
  dividendOption: string;
  email: string | null;
  phone: string | null;
  status: string; // user status (ACTIVE / PENDING / …)
  createdAt: Date;
}

export async function getInvestorProfileByCode(
  code: string,
): Promise<PortalInvestorProfile | null> {
  const rows = await prisma.$queryRawUnsafe<PortalInvestorProfile[]>(
    `SELECT i.id, i."investorCode", i.name, i.title, i."investorType",
            i."nidNumber", i."tinNumber", i."dateOfBirth", i.address,
            i."boId", i."dpId", i."brokerageHouse",
            i."fatherName", i."motherName", i."spouseName",
            i."jointApplicantName", i."dividendOption",
            u.email, u.phone, u.status, i."createdAt"
     FROM public.investors i
     JOIN public.users u ON u.id = i."userId"
     WHERE i."investorCode" = $1
     LIMIT 1`,
    code,
  );
  return rows[0] ?? null;
}

export interface PortalBankAccount {
  id: string;
  bankName: string;
  branchName: string | null;
  accountNumber: string;
  routingNumber: string | null;
  chequeLeafUrl: string | null;
  isPrimary: boolean;
  status: string;
}

export async function getBankAccounts(investorId: string): Promise<PortalBankAccount[]> {
  return prisma.$queryRawUnsafe<PortalBankAccount[]>(
    `SELECT id, "bankName", "branchName", "accountNumber", "routingNumber",
            "chequeLeafUrl", "isPrimary", status
     FROM public.bank_accounts
     WHERE "investorId" = $1
     ORDER BY "isPrimary" DESC, "createdAt" ASC`,
    investorId,
  );
}

export interface PortalNominee {
  id: string;
  name: string;
  relationship: string | null;
  nidNumber: string | null;
  share: number;
  isMinor: boolean;
}

export async function getNominees(investorId: string): Promise<PortalNominee[]> {
  return prisma.$queryRawUnsafe<PortalNominee[]>(
    `SELECT id, name, relationship, "nidNumber", share, "isMinor"
     FROM public.nominees WHERE "investorId" = $1`,
    investorId,
  );
}

export interface PortalDocument {
  id: string;
  type: string;
  fileName: string;
  filePath: string;
  mimeType: string | null;
  createdAt: Date;
}

export async function getDocuments(investorId: string): Promise<PortalDocument[]> {
  return prisma.$queryRawUnsafe<PortalDocument[]>(
    `SELECT id, type, "fileName", "filePath", "mimeType", "createdAt"
     FROM public.documents WHERE "investorId" = $1 ORDER BY "createdAt" DESC`,
    investorId,
  );
}

/** The REGISTRATION KycRecord snapshot (permanent address, joint applicant, etc.). */
export async function getRegistrationSnapshot(
  investorId: string,
): Promise<Record<string, unknown> | null> {
  const rows = await prisma.$queryRawUnsafe<{ documentUrl: string | null }[]>(
    `SELECT "documentUrl" FROM public.kyc_records
     WHERE "investorId" = $1 AND type = 'REGISTRATION'
     ORDER BY "createdAt" DESC LIMIT 1`,
    investorId,
  );
  const raw = rows[0]?.documentUrl;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}
