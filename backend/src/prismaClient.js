import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
dotenv.config();

const isTest = process.execArgv.includes('--test') ||
  process.env.NODE_ENV === 'test' ||
  /[\/\\]test[\/\\]/.test(process.argv[1] || '') ||
  process.argv.some(arg => typeof arg === 'string' && (arg.endsWith('.test.js') || arg.includes('/test/') || arg.includes('\\test\\')));

let url = process.env.DATABASE_URL;

if (isTest) {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error('TEST_DATABASE_URL is not set. Refusing to run tests on production/dev database.');
  }
  const cleanUrl = testUrl.split('?')[0];
  const dbName = cleanUrl.split('/').pop();
  if (!dbName || !dbName.endsWith('_test')) {
    throw new Error(`TEST_DATABASE_URL database name "${dbName}" must end with "_test"! Refusing to run tests.`);
  }
  url = testUrl;
  process.env.DATABASE_URL = testUrl;
}

const prisma = new PrismaClient(url ? { datasources: { db: { url } } } : undefined);

export default prisma;
