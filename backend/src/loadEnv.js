import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '../.env');

const isTestEnv = process.env.NODE_ENV === 'test';
const callerTestDbUrl = isTestEnv ? process.env.TEST_DATABASE_URL : null;
dotenv.config({ path: envPath, override: true });
if (isTestEnv) {
  process.env.NODE_ENV = 'test';
  if (callerTestDbUrl) {
    process.env.TEST_DATABASE_URL = callerTestDbUrl;
  }
}
