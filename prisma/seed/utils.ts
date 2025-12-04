import { PrismaClient } from '../../generated/prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const connectionString = process.env.DATABASE_URL!;
const pool = new Pool({ 
  connectionString,
  ssl: process.env.NODE_ENV === 'production' || connectionString.includes('sslmode=require') 
    ? { rejectUnauthorized: false } 
    : undefined 
});
const adapter = new PrismaPg(pool);

export const prisma = new PrismaClient({ adapter });

/** Check if table has certain column (used for slug) */
export async function hasColumn(table: string, column: string): Promise<boolean> {
  try {
    const rows: any = await prisma.$queryRawUnsafe(
      `SELECT column_name FROM information_schema.columns WHERE table_name='${table}' AND column_name='${column}'`
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}